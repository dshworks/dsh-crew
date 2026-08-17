/**
 * The crew tools: how the dsh agent runs the team.
 *
 * The split view is the human's half. This is the other half — with these five
 * tools the agent in the center column can seat a crew member, hand it work,
 * read what came back, and dismiss it, while the human watches every keystroke
 * of it happen in a pane and can take the keyboard at any moment.
 *
 * That shared surface is the point. The harness's existing subagent providers
 * are opaque by contract: one task in, one sentence out, nothing observable in
 * between. Here the delegation and the observation are the same terminal.
 *
 * `crew_send` waits for the pane to settle rather than returning immediately.
 * A coding agent's answer arrives over tens of seconds, so a fire-and-forget
 * send would force the model to poll `crew_peek` in a loop and burn a turn per
 * sample. Settling is detected from the rendered screen: unchanged for
 * `settleMs` means the crew member stopped typing.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

/** How often the settle watcher samples the rendered screen. */
const SAMPLE_MS = 400

/**
 * Pause between typing a message and pressing Enter.
 *
 * Both Claude Code and Codex run bracketed-paste-style input detection: a burst
 * of bytes ending in a carriage return is read as pasted text, and the return
 * becomes a literal newline inside the composer rather than a submit. Sending
 * `message + '\r'` as one write therefore types the task and never sends it —
 * and because the pane then goes quiet, the settle watcher reports success and
 * hands the model back its own unsent question as the answer.
 *
 * Separating the return into its own write, after a pause long enough to end the
 * paste burst, submits on both. Verified against claude 2.1.232 and codex 0.147.0.
 */
const SUBMIT_DELAY_MS = 250

/**
 * Wait until a pane's screen stops changing, or until the deadline.
 *
 * `requireContent` additionally refuses to call an empty screen settled. A CLI
 * that has not painted its first frame is perfectly quiet, so a freshly seated
 * pane would otherwise "settle" on nothing at all.
 * @param {object} pane - the live pane.
 * @param {object} bounds - `settleMs`, `timeoutMs`, and optional `requireContent`.
 * @param {AbortSignal} signal - the tool call's cancellation signal.
 * @returns {Promise<{settled: boolean, screen: string}>} the final screen and why it returned.
 */
async function waitForQuiet(pane, bounds, signal) {
  const deadline = Date.now() + bounds.timeoutMs
  let previous = null
  let quietSince = Date.now()
  for (;;) {
    await pane.screen.drain()
    const screen = pane.screen.read()
    const usable = !bounds.requireContent || screen.trim() !== ''
    if (screen !== previous) {
      previous = screen
      quietSince = Date.now()
    } else if (usable && Date.now() - quietSince >= bounds.settleMs) {
      return { settled: true, screen }
    }
    if (Date.now() >= deadline) return { settled: false, screen }
    if (pane.status.kind === 'exited') return { settled: true, screen }
    await sleep(SAMPLE_MS, signal)
  }
}

/**
 * Sleep, or reject as soon as the tool call is cancelled.
 *
 * The listener is removed on the normal path too. `{once: true}` alone would
 * only clear it on an abort that may never come, and this runs once per sample
 * — a 15-minute `crew_send` would leave thousands of listeners on one signal.
 * @param {number} ms - how long to wait.
 * @param {AbortSignal} signal - the tool call's cancellation signal.
 * @returns {Promise<void>} resolves after the delay; rejects on abort.
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer)
      reject(new Error('crew: wait cancelled'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel)
      resolve()
    }, ms)
    signal.addEventListener('abort', cancel, { once: true })
  })
}

/**
 * Register the five crew tools on the injected context.
 * @param {import('@deepseek-ai/cordis').Context} ctx - context with `ctx.tools`.
 * @param {object} deps - pane registry, roster, cwd resolver, and config.
 */
export function registerCrewTools(ctx, deps) {
  const { panes, roster, resolveCwd, config } = deps

  /**
   * The pane a tool call names, restricted to the calling session's own crew.
   * @param {object} exec - tool execution identity.
   * @param {string} paneId - the requested pane.
   * @returns {object} the live pane.
   */
  const ownPane = (exec, paneId) => {
    const pane = panes.get(paneId)
    if (pane === undefined) throw new Error(`no crew pane "${paneId}"`)
    if (pane.sessionId !== exec.agent.session.id) {
      throw new Error(`pane "${paneId}" belongs to another session`)
    }
    return pane
  }

  ctx.tools.register(defineTool({
    name: 'crew_list',
    description: 'List the coding agents available to seat, and the crew panes currently open in this session. Use before seating to see who is already working.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          available: { type: 'array', items: { type: 'string' } },
          panes: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.panes.length === 0
          ? `No crew seated. Available: ${value.available.join(', ')}`
          : value.panes.map(p => `${p.id} — ${p.label} (${p.status})`).join('\n'),
      }],
    },
    async execute(_args, exec) {
      return {
        available: roster.map(agent => agent.id),
        panes: panes.list(exec.agent.session.id),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'crew_seat',
    description: 'Start a coding agent in a live terminal pane beside this conversation, in this session\'s workspace. The human sees it and can type into it. Returns a pane id to send work to. Seat an agent once and reuse the pane; do not seat a new one per question.',
    parameters: {
      agent: { type: 'string', required: true, description: 'Crew member id from crew_list, such as "claude" or "codex".' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          paneId: { type: 'string' },
          label: { type: 'string' },
          cwd: { type: 'string' },
          screen: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `Seated ${value.label} in ${value.paneId} (${value.cwd}).\n\n${value.screen}` }],
    },
    async execute(args, exec) {
      const agent = roster.find(entry => entry.id === args.agent)
      if (agent === undefined) {
        throw new Error(`unknown crew member "${args.agent}"; available: ${roster.map(a => a.id).join(', ')}`)
      }
      const session = exec.agent.session
      const seated = panes.list(session.id).filter(pane => pane.status === 'running')
      if (seated.length >= config.maxPanesPerSession) {
        throw new Error(`this session already holds ${config.maxPanesPerSession} panes; dismiss one first`)
      }
      // The same refusal the browser route makes, for the same reason: falling
      // back to the server's cwd would seat an agent with write access to
      // whatever directory dsh was launched from.
      const cwd = resolveCwd(session.id)
      const pane = await panes.spawn({
        agent,
        sessionId: session.id,
        cwd,
        cols: config.cols,
        rows: config.rows,
      })
      // A coding CLI paints a banner and a prompt before it can accept input;
      // returning its first screen tells the model whether it is actually ready,
      // sitting on a login wall, or asking whether it may trust this directory.
      // `requireContent` is what makes that true: claude takes ~4.5s to paint
      // its first frame and is silent until then, so a quiet-only test would
      // hand back a blank screen and call the crew member seated.
      const { screen } = await waitForQuiet(
        pane,
        { settleMs: 1200, timeoutMs: 20_000, requireContent: true },
        exec.signal,
      )
      return { paneId: pane.id, label: pane.label, cwd, screen }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'crew_send',
    description: 'Type a message into a seated crew member\'s terminal, press Enter, and wait for it to finish answering. Returns the pane\'s screen when it goes quiet. This is how you delegate work to Claude Code or Codex and read the result.',
    parameters: {
      pane: { type: 'string', required: true, description: 'Pane id from crew_seat or crew_list.' },
      message: { type: 'string', required: true, description: 'The text to type. Written verbatim, then Enter.' },
      timeoutSeconds: { type: 'number', description: 'Give up waiting after this long (default 180, max 900). The crew member keeps working; peek later.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          screen: { type: 'string' },
          settled: { type: 'boolean' },
          status: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (args, value) => [{
        type: 'text',
        text: value.settled
          ? value.screen
          : `${value.screen}\n\n[still working after the timeout — call crew_peek with pane "${args.pane}" to check again]`,
      }],
    },
    async execute(args, exec) {
      const pane = ownPane(exec, args.pane)
      if (pane.status.kind === 'exited') throw new Error(`pane "${args.pane}" has exited`)
      const timeoutMs = Math.min(900, Math.max(5, args.timeoutSeconds ?? 180)) * 1000
      // Type, let the paste burst end, then press Enter as its own keystroke.
      await pane.handle.write(args.message)
      await sleep(SUBMIT_DELAY_MS, exec.signal)
      await pane.handle.write('\r')
      // A CLI that has not begun rendering the reply is momentarily as quiet as
      // one that finished, so the quiet window has to outlast that gap.
      const { settled, screen } = await waitForQuiet(pane, { settleMs: 3000, timeoutMs }, exec.signal)
      return { screen, settled, status: pane.status.kind }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'crew_peek',
    description: 'Read what a seated crew member\'s terminal is showing right now, exactly as the human sees it. Use to check on work started earlier, or when crew_send timed out.',
    parameters: {
      pane: { type: 'string', required: true, description: 'Pane id from crew_seat or crew_list.' },
      lines: { type: 'number', description: 'Trailing lines to return; the visible screen by default.' },
    },
    output: {
      schema: { type: 'object', properties: { screen: { type: 'string' }, status: { type: 'string' } }, additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: value.screen }],
    },
    async execute(args, exec) {
      const pane = ownPane(exec, args.pane)
      await pane.screen.drain()
      return { screen: pane.screen.read(args.lines), status: pane.status.kind }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'crew_dismiss',
    description: 'Close a crew member\'s pane and end its process. Its unsaved terminal state is lost; files it already wrote stay.',
    parameters: {
      pane: { type: 'string', required: true, description: 'Pane id to close.' },
    },
    output: {
      schema: { type: 'object', properties: { closed: { type: 'boolean' } }, additionalProperties: false },
      render: (args, value) => [{ type: 'text', text: value.closed ? `Dismissed ${args.pane}.` : `No pane ${args.pane}.` }],
    },
    async execute(args, exec) {
      ownPane(exec, args.pane)
      return { closed: await panes.close(args.pane) }
    },
  }))
}
