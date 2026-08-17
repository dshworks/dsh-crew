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
 *
 * `run_in_background: true` moves that same wait onto the harness's job seam, so
 * a delegation the model does not need the answer to right now costs no turn at
 * all: the call returns a job id, the model keeps working, and the completion
 * notice wakes it with the result.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

/** How often the settle watcher samples the rendered screen. */
const SAMPLE_MS = 400

/** Quiet stretch that counts as "the crew member stopped answering". */
const SETTLE_MS = 3000

/**
 * Rendered lines a send returns as its result.
 *
 * Enough for a long answer with its tool output, bounded because a runaway
 * crew member could otherwise put a whole build log in the model's context.
 */
const OUTPUT_MAX_LINES = 200

/** Seconds a foreground `crew_send` may block the calling turn. */
const FOREGROUND_SECONDS = { fallback: 180, min: 5, max: 900 }

/**
 * Seconds a background watch may run.
 *
 * Nothing is blocked while it does, so the cap is only a safety net for a pane
 * that never goes quiet — a spinner nobody stops, a crew member left mid-prompt.
 */
const BACKGROUND_SECONDS = { fallback: 1800, min: 5, max: 7200 }

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
 * Type a message into a pane, then submit it as its own keystroke.
 *
 * An empty message presses Enter alone, which is how a caller answers the
 * dialog a coding CLI may open before its composer (a trust prompt, a
 * permission question) without typing anything into it.
 * @param {object} pane - the live pane.
 * @param {string} message - the text to type.
 * @param {AbortSignal} signal - cancellation for the pause between the two writes.
 * @returns {Promise<void>} resolves once Enter has been written.
 */
async function typeMessage(pane, message, signal) {
  if (message !== '') await pane.handle.write(message)
  await sleep(SUBMIT_DELAY_MS, signal)
  await pane.handle.write('\r')
}

/**
 * What arrived on the pane since a mark: the result of one send.
 *
 * The whole viewport is a poor answer to "what did the crew member say" — most
 * of it is the banner and composer that were already there. The delta is the new
 * lines, and it falls back to the viewport when there are none to report, which
 * is what a CLI that repaints in place produces.
 *
 * A dismissed pane's mirror is disposed, so reading it can throw; a job outcome
 * must not reject, so an unreadable screen degrades to no output rather than
 * failing the send that already happened.
 * @param {object} pane - the live pane.
 * @param {object} mark - a `pane.screen.mark()` taken before typing.
 * @returns {string} the rendered result.
 */
function resultSince(pane, mark) {
  try {
    const delta = pane.screen.since(mark, OUTPUT_MAX_LINES)
    return delta === '' ? pane.screen.read() : delta
  } catch {
    return ''
  }
}

/**
 * Clamp a model-supplied timeout into a path's accepted range.
 * @param {number | undefined} seconds - the requested value.
 * @param {{fallback: number, min: number, max: number}} bounds - the range.
 * @returns {number} milliseconds.
 */
function timeoutMsFrom(seconds, bounds) {
  return Math.min(bounds.max, Math.max(bounds.min, seconds ?? bounds.fallback)) * 1000
}

/**
 * Send a message and watch for the answer as a background job's work.
 *
 * Shaped for `ctx.jobs.start()`: the hooks come back synchronously while the
 * typing and the watching run on their own. No `readOutput` is offered — the
 * incremental form of a repainting terminal is the pane itself, which the human
 * is already watching and the model can sample with `crew_peek`, so this job
 * reports one final result instead of a stream of half-drawn screens.
 * @param {object} pane - the live pane.
 * @param {string} message - the text to type.
 * @param {number} timeoutMs - how long to watch before giving up on quiet.
 * @returns {object} the `JobHooks` the registry drives.
 */
function startSend(pane, message, timeoutMs) {
  const control = new AbortController()
  const mark = pane.screen.mark()
  const done = (async () => {
    try {
      await typeMessage(pane, message, control.signal)
      const { settled } = await waitForQuiet(pane, { settleMs: SETTLE_MS, timeoutMs }, control.signal)
      return {
        status: 'completed',
        ...settled ? {} : { detail: `still changing after ${Math.round(timeoutMs / 1000)}s; crew_peek to keep watching` },
        output: resultSince(pane, mark),
      }
    } catch (error) {
      if (control.signal.aborted) {
        return { status: 'killed', detail: 'interrupted', output: resultSince(pane, mark) }
      }
      return { status: 'failed', detail: error instanceof Error ? error.message : String(error) }
    }
  })()
  return {
    /**
     * Stop watching and interrupt the crew member's current turn.
     *
     * The pane stays seated: a cancelled delegation is a turn the operator or the
     * model changed its mind about, not a reason to end a process the human is
     * watching. `cancel` may not throw and a pane that has already exited cannot
     * be signalled, so the signal is deferred into a promise chain that swallows
     * both failures — the watch is stopped either way, which is what it promises.
     */
    cancel: () => {
      control.abort()
      Promise.resolve().then(() => pane.handle.signalForeground('SIGINT')).catch(() => {})
    },
    done,
  }
}

/**
 * A one-line job label: who is working, and on what.
 * @param {object} pane - the pane being sent to.
 * @param {string} message - the message being sent.
 * @returns {string} the label the job list shows.
 */
function describeSend(pane, message) {
  const first = message.split('\n').find(line => line.trim() !== '') ?? '(Enter)'
  return `${pane.label} ← ${first.length > 60 ? `${first.slice(0, 57)}…` : first}`
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
    description: 'Start a coding agent in a live terminal pane beside this conversation, in this session\'s workspace. The human sees it and can type into it. Returns a pane id to send work to, and the crew member\'s first screen. Seat an agent once and reuse the pane; do not seat a new one per question.'
      + ' READ that first screen before sending work: a coding CLI may open on a dialog rather than a ready composer — "do you trust this directory", a login wall, a release note — and a task sent into a dialog is typed into the dialog instead. Answer the dialog with crew_send (an empty message presses Enter), then send the task.',
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
    description: 'Type a message into a seated crew member\'s terminal, press Enter, and wait for it to finish answering. Returns the lines that arrived, plus the pane\'s screen. This is how you delegate work to Claude Code or Codex and read the result.'
      + ' If the pane is showing a dialog or permission prompt rather than a composer, answer THAT first — send the option you choose, or an empty message to press Enter — and send the task only once the crew member is ready. A task typed into a dialog is not a task: the text lands in the dialog and its digits can pick an option.'
      + (config.enableRunInBackground
        ? ' Set run_in_background: true when you do not need the answer to continue: the call returns a job id immediately, you are notified in-session when the crew member finishes, and you read the result with job_output.'
        : ''),
    parameters: {
      pane: { type: 'string', required: true, description: 'Pane id from crew_seat or crew_list.' },
      message: { type: 'string', required: true, description: 'The text to type. Written verbatim, then Enter as a separate keystroke. Empty presses Enter alone, which answers a dialog without typing into it.' },
      timeoutSeconds: { type: 'number', description: 'Give up watching after this long: default 180 and max 900 while waiting, 1800 and 7200 in the background. The crew member keeps working either way; peek later.' },
      ...config.enableRunInBackground ? {
        run_in_background: { type: 'boolean', description: 'Send now and return a job id instead of waiting (collect with job_output, stop with job_kill). The pane stays visible to the human either way.' },
      } : {},
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            properties: {
              kind: { type: 'string', const: 'background', required: true },
              jobId: { type: 'string', required: true },
            },
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              kind: { type: 'string', const: 'foreground', required: true },
              output: { type: 'string', required: true },
              screen: { type: 'string', required: true },
              settled: { type: 'boolean', required: true },
              status: { type: 'string', required: true },
            },
            additionalProperties: false,
          },
        ],
      },
      render: (args, value) => [{
        type: 'text',
        text: value.kind === 'background'
          ? `started crew job ${value.jobId} — job_output to read, crew_peek to watch`
          : value.settled
            ? value.output
            : `${value.output}\n\n[still working after the timeout — call crew_peek with pane "${args.pane}" to check again]`,
      }],
    },
    async execute(args, exec) {
      const pane = ownPane(exec, args.pane)
      if (pane.status.kind === 'exited') throw new Error(`pane "${args.pane}" has exited`)
      if (args.run_in_background === true) {
        // Undeclared arguments are accepted, so removing the parameter from the
        // schema is not by itself a refusal.
        if (!config.enableRunInBackground) {
          throw new Error('run_in_background is disabled for this deployment (enableRunInBackground: false)')
        }
        const jobs = ctx.get('jobs')
        if (jobs === undefined) {
          throw new Error('background crew work unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
        }
        // The job registry owns the work once it starts, so a call the caller has
        // already abandoned must not leave one running with nobody expecting it.
        if (exec.signal.aborted) {
          const aborted = new Error('crew_send aborted before its job started')
          // The tool runtime classifies aborts by error name, not by message.
          aborted.name = 'AbortError'
          throw aborted
        }
        const jobId = jobs.start({
          kind: 'crew',
          label: describeSend(pane, args.message),
          ...exec.agent ? { owner: exec.agent } : {},
          run: () => startSend(pane, args.message, timeoutMsFrom(args.timeoutSeconds, BACKGROUND_SECONDS)),
        })
        return { kind: 'background', jobId }
      }
      const mark = pane.screen.mark()
      await typeMessage(pane, args.message, exec.signal)
      // A CLI that has not begun rendering the reply is momentarily as quiet as
      // one that finished, so the quiet window has to outlast that gap.
      const { settled, screen } = await waitForQuiet(
        pane,
        { settleMs: SETTLE_MS, timeoutMs: timeoutMsFrom(args.timeoutSeconds, FOREGROUND_SECONDS) },
        exec.signal,
      )
      return { kind: 'foreground', output: resultSince(pane, mark), screen, settled, status: pane.status.kind }
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
