/**
 * dsh-crew — host half.
 *
 * dsh can already delegate to Claude Code and Codex: the harness ships
 * `subagent-claude-code` and `subagent-codex`, which start the product, hand it
 * one task, and return its final sentence. What they deliberately do not do is
 * let you WATCH. Their own contracts say so — final text only, no progress
 * stream, no human interaction path, and the model-facing terminal tool
 * documents "no TUI". You can call the other agents; you cannot see them work,
 * and you cannot take the keyboard when they go wrong.
 *
 * This plugin adds the missing half. Each crew member gets a real PTY running
 * its own CLI in the session's workspace, streamed to a pane in the dsh Web UI.
 * The human types into any pane at any time. The dsh agent, meanwhile, gets
 * tools to seat crew, send them work, and read their screens — so the center
 * column runs the team and the split view shows it happening.
 *
 * Two routes carry it: a JSON control route behind a request fence, and one
 * WebSocket per attached pane. Both are this plugin's own; nothing here touches
 * the session log, because raw terminal bytes are not conversation state.
 */
import z from '@deepseek-ai/schemastery'
import { WebSocketServer } from 'ws'
import { PaneRegistry } from './panes.js'
import { checkControlRequest, checkUpgradeRequest, assertTrustedAuthority } from './trust.js'
import { composeRoster, describeRoster } from './roster.js'
import { registerCrewTools } from './tools.js'

export const name = 'dsh-crew'

/** Where the browser posts control operations. */
const CONTROL_PATH = '/dsh-crew/rpc'

/** Where a pane's byte stream is upgraded. */
const ATTACH_PATH = '/dsh-crew/attach'

/** Largest control body accepted, well above any legitimate operation. */
const MAX_BODY_BYTES = 64 * 1024

export const Config = z.object({
  /**
   * Extra crew members, or overrides of the built-in `claude`, `codex`, and
   * `dsh` rows matched by `id`. A row needs `id` and `command`; `label`,
   * `args`, `accent`, `env`, and `enabled: false` are optional.
   */
  agents: z.array(z.any()).default([]),
  /**
   * Authorities besides loopback that may reach the control and attach routes.
   * Match the `--trusted-host` values the deployment already runs with; a pane
   * starts processes, so an unlisted origin is refused rather than warned about.
   */
  trustedHosts: z.array(String).default([]),
  /** Terminal columns for a new pane when the browser does not measure one. */
  cols: z.number().min(20).max(500).default(100),
  /** Terminal rows for a new pane when the browser does not measure one. */
  rows: z.number().min(5).max(200).default(30),
  /** Raw output retained per pane so a browser reload repaints its screen. */
  scrollbackBytes: z.number().min(4096).max(8 * 1024 * 1024).default(262_144),
  /** Panes one dsh session may hold open at once. */
  maxPanesPerSession: z.number().min(1).max(16).default(6),
  /** SIGTERM-to-SIGKILL grace when a pane closes. */
  graceMs: z.number().min(100).max(60_000).default(3000),
  /**
   * Expose the crew tools to the dsh agent. With this off the split view still
   * works and the crew is human-driven only.
   */
  tools: z.boolean().default(true),
})

/** Services this plugin cannot work without. */
export const inject = ['subprocess', 'webServer']

/**
 * Read a bounded JSON body.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {Promise<object>} the parsed body.
 */
async function readJsonBody(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Mount the crew: pane registry, control route, attach route, and — unless
 * configured off — the agent-facing tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 * @param {ReturnType<typeof Config>} config - validated configuration.
 */
export function apply(ctx, config) {
  // A malformed authority fails the load rather than silently authorizing a
  // different host at request time.
  for (const entry of config.trustedHosts) assertTrustedAuthority(entry)

  const roster = composeRoster(config.agents)
  const panes = new PaneRegistry({
    spawnTerminal: spec => ctx.subprocess.spawnTerminal(spec),
    scrollbackBytes: config.scrollbackBytes,
    graceMs: config.graceMs,
  })

  /**
   * Resolve the workspace a new pane starts in.
   *
   * The browser never chooses this. A pane starts a process, so its working
   * directory comes from the session the request names, exactly as the harness's
   * own subagent providers derive theirs — never from request data.
   *
   * An unresolvable session is refused rather than defaulted. Falling back to
   * the server's own cwd would start an agent with write access to whatever
   * directory dsh happened to be launched from, on nothing more than an
   * unrecognized id — a worse outcome than a failed launch the caller can see.
   * @param {string | undefined} sessionId - the dsh session opening the pane.
   * @returns {string} an absolute directory path.
   */
  const resolveCwd = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new Error('a crew pane needs the session that opens it')
    }
    const session = ctx.get('sessions')?.get(sessionId)
    if (session === undefined) throw new Error(`no session "${sessionId}" on this host`)
    const cwd = session.header?.cwd
    if (cwd === undefined) throw new Error(`session "${sessionId}" has no workspace directory`)
    return cwd
  }

  /**
   * Execute one control operation.
   * @param {object} body - the parsed request body.
   * @returns {Promise<object>} the JSON response value.
   */
  const dispatch = async (body) => {
    const op = body?.op
    switch (op) {
      case 'roster':
        return { agents: await describeRoster(roster) }

      case 'list':
        return { panes: panes.list(body.sessionId) }

      case 'spawn': {
        const agent = roster.find(entry => entry.id === body.agentId)
        if (agent === undefined) throw new Error(`unknown crew member "${body.agentId}"`)
        const seated = panes.list(body.sessionId).filter(pane => pane.status === 'running')
        if (seated.length >= config.maxPanesPerSession) {
          throw new Error(`this session already holds ${config.maxPanesPerSession} panes`)
        }
        const pane = await panes.spawn({
          agent,
          sessionId: body.sessionId,
          cwd: resolveCwd(body.sessionId),
          cols: clampGeometry(body.cols, config.cols, 20, 500),
          rows: clampGeometry(body.rows, config.rows, 5, 200),
        })
        return { pane: pane.describe(), token: panes.mintToken(pane.id) }
      }

      case 'attach': {
        const pane = requirePane(panes, body.paneId)
        return { pane: pane.describe(), token: panes.mintToken(pane.id) }
      }

      case 'input': {
        const pane = requirePane(panes, body.paneId)
        await pane.handle.write(String(body.data ?? ''))
        return { ok: true }
      }

      case 'signal': {
        const pane = requirePane(panes, body.paneId)
        await pane.handle.signalForeground(body.signal ?? 'SIGINT')
        return { ok: true }
      }

      case 'peek': {
        const pane = requirePane(panes, body.paneId)
        await pane.screen.drain()
        return { screen: pane.screen.read(body.lines) }
      }

      case 'close':
        return { closed: await panes.close(body.paneId) }

      default:
        throw new Error(`unknown op "${String(op)}"`)
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CONTROL_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' }).end()
        return
      }
      const verdict = checkControlRequest(req, config.trustedHosts)
      if (!verdict.ok) {
        res.writeHead(verdict.status).end(verdict.message)
        return
      }
      try {
        const value = await dispatch(await readJsonBody(req))
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(value))
      } catch (error) {
        // Every failure here is a caller-visible domain fact (unknown pane,
        // missing binary, pane cap). The message is the whole diagnosis, so the
        // Web UI shows it verbatim instead of inventing its own copy.
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      }
    },
  }), 'dsh-crew: control route')

  const sockets = new WebSocketServer({ noServer: true })
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: ATTACH_PATH,
    handler: (req, socket, head) => {
      if (!checkUpgradeRequest(req, config.trustedHosts)) {
        socket.destroy()
        return
      }
      const token = new URL(req.url, 'http://localhost').searchParams.get('token')
      const pane = panes.redeemToken(token)
      if (pane === undefined) {
        socket.destroy()
        return
      }
      sockets.handleUpgrade(req, socket, head, (ws) => {
        const detach = panes.attach(pane, (frame) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
        })
        ws.on('message', (raw) => {
          // Keystrokes are the hot path and arrive one or two bytes at a time;
          // anything that is not a control frame is terminal input verbatim.
          const text = raw.toString('utf8')
          if (text.startsWith('{')) {
            try {
              const frame = JSON.parse(text)
              if (frame.t === 'sig') {
                void pane.handle.signalForeground(frame.s ?? 'SIGINT')
                return
              }
              if (frame.t === 'in') {
                void pane.handle.write(String(frame.d ?? ''))
                return
              }
            } catch {
              // A body that opens with '{' but does not parse is input, not a
              // malformed frame: a paste of JSON is ordinary terminal traffic.
            }
          }
          void pane.handle.write(text)
        })
        ws.on('close', detach)
        ws.on('error', detach)
      })
    },
  }), 'dsh-crew: attach WebSocket')

  ctx.effect(() => () => {
    sockets.close()
    void panes.closeAll()
  }, 'dsh-crew: pane teardown')

  if (config.tools) {
    ctx.inject(['tools'], (toolCtx) => {
      registerCrewTools(toolCtx, { panes, roster, resolveCwd, config })
    })
  }
}

/**
 * Clamp a browser-measured geometry value into the PTY's accepted range.
 * @param {unknown} value - the requested value.
 * @param {number} fallback - configured default when absent or unusable.
 * @param {number} min - inclusive lower bound.
 * @param {number} max - inclusive upper bound.
 * @returns {number} an integer inside the range.
 */
function clampGeometry(value, fallback, min, max) {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * Look up a pane or fail with the id the caller used.
 * @param {PaneRegistry} panes - the registry.
 * @param {unknown} paneId - the requested id.
 * @returns {object} the live pane.
 */
function requirePane(panes, paneId) {
  const pane = panes.get(String(paneId))
  if (pane === undefined) throw new Error(`no pane "${String(paneId)}"`)
  return pane
}
