/**
 * The pane registry: one live PTY per seated crew member, plus the bookkeeping
 * a browser pane needs to attach, detach, and come back after a reload.
 *
 * Every pane is a real terminal running the agent's own CLI — not a wrapper, not
 * a protocol client. That is the whole point: Claude Code and Codex already have
 * excellent terminal interfaces, and the fastest way to put them beside dsh is to
 * carry their bytes, not to reimplement their surfaces.
 *
 * The PTY itself comes from the harness's subprocess seam
 * (`ctx.subprocess.spawnTerminal`), so this plugin ships no native dependency and
 * inherits the seam's credential scrub and process-tree teardown.
 */
import { randomUUID } from 'node:crypto'
import { ScreenMirror } from './screen.js'

/** Bytes of raw terminal output retained per pane for replay on attach. */
const DEFAULT_SCROLLBACK_BYTES = 262_144

/** How long a minted attach token stays redeemable. */
const TOKEN_TTL_MS = 30_000

/**
 * Terminal capability the pane declares to its child.
 *
 * The harness server is normally started from a non-interactive shell, so its
 * ambient `TERM` is `dumb`. A coding CLI that reads `TERM=dumb` correctly
 * concludes it is not on a terminal and turns off colour and cursor addressing,
 * which is precisely the output a pane exists to show. The pane knows better
 * than the ambient value: the browser end is xterm.js, which is what these
 * names describe.
 */
const TERMINAL_ENV = { TERM: 'xterm-256color', COLORTERM: 'truecolor' }

/**
 * Build the argv for a crew member, forcing `TERM` from outside the seam.
 *
 * `spawnTerminal` takes an `env` and layers it over the provider's scrub, which
 * carries `COLORTERM` and everything else correctly — but not `TERM`.
 * `@deepseek-ai/dsh-subprocess-local` hands node-pty a hardcoded
 * `name: 'dumb'`, and node-pty resolves `opt.name || env.TERM` and then assigns
 * `env.TERM = name`, so the provider's constant overwrites the caller's value
 * after the merge. `TERM` is the one variable this seam will not carry.
 *
 * `env` settles it from the outside: it applies the assignment and `exec`s the
 * real program in place, so the pane still owns exactly one process and the
 * reported pid, the foreground group, and signalling are unchanged. Only `TERM`
 * travels this way — argv is visible in `ps`, and the rest of the environment
 * may hold an agent's credentials, so everything else stays in `env`.
 * @param {object} agent - the roster entry being seated.
 * @param {string | undefined} term - the terminal name the pane wants.
 * @returns {Array<string>} argv for the subprocess seam.
 */
function terminalArgv(agent, term) {
  const argv = [agent.command, ...(agent.args ?? [])]
  return term === undefined ? argv : ['env', `TERM=${term}`, ...argv]
}

/**
 * A byte-bounded FIFO of terminal output.
 *
 * Terminal output is not line-oriented and a TUI rewrites its own screen, so the
 * ring keeps raw bytes in arrival order and drops from the front. Replaying it
 * into a fresh emulator reconstructs the screen for any application that repaints
 * — which every full-screen agent CLI does — while a chatty scrolling program
 * simply loses its oldest history.
 */
class Scrollback {
  #chunks = []
  #bytes = 0
  #limit

  /**
   * @param {number} limit - maximum retained bytes.
   */
  constructor(limit) {
    this.#limit = limit
  }

  /**
   * Append one chunk and evict from the front until the limit holds.
   * @param {string} chunk - terminal output as text.
   */
  push(chunk) {
    if (chunk === '') return
    this.#chunks.push(chunk)
    this.#bytes += Buffer.byteLength(chunk)
    while (this.#bytes > this.#limit && this.#chunks.length > 1) {
      this.#bytes -= Buffer.byteLength(this.#chunks.shift())
    }
  }

  /** @returns {string} everything retained, in arrival order. */
  read() {
    return this.#chunks.join('')
  }
}

/**
 * One seated agent: its PTY handle, its retained screen, and its watchers.
 */
class Pane {
  /**
   * @param {object} spec - identity and process facts fixed at spawn.
   */
  constructor(spec) {
    this.id = spec.id
    this.sessionId = spec.sessionId
    this.agentId = spec.agentId
    this.label = spec.label
    this.accent = spec.accent
    this.cwd = spec.cwd
    this.cols = spec.cols
    this.rows = spec.rows
    this.pid = spec.handle.pid
    this.startedAt = spec.now
    this.handle = spec.handle
    this.scrollback = new Scrollback(spec.scrollbackBytes)
    // Raw bytes replay the browser's emulator; the mirror answers what the pane
    // currently SHOWS, which is the only useful form for a model.
    this.screen = new ScreenMirror({ cols: spec.cols, rows: spec.rows })
    /** @type {Set<(frame: object) => void>} live watchers. */
    this.watchers = new Set()
    /** @type {{kind: 'running'} | {kind: 'exited', exitCode: number | null}} */
    this.status = { kind: 'running' }
  }

  /**
   * Fan one output chunk out to every watcher and retain it for later attaches.
   * @param {string} chunk - terminal output as text.
   */
  emit(chunk) {
    this.scrollback.push(chunk)
    this.screen.write(chunk)
    for (const watcher of this.watchers) watcher({ t: 'out', d: chunk })
  }

  /**
   * Record the terminal's exit and tell every watcher, once.
   * @param {number | null} exitCode - top-level process exit code.
   */
  settle(exitCode) {
    if (this.status.kind === 'exited') return
    this.status = { kind: 'exited', exitCode }
    for (const watcher of this.watchers) watcher({ t: 'exit', code: exitCode })
  }

  /** @returns {object} the JSON row the Web UI lists. */
  describe() {
    return {
      id: this.id,
      sessionId: this.sessionId,
      agentId: this.agentId,
      label: this.label,
      accent: this.accent,
      cwd: this.cwd,
      cols: this.cols,
      rows: this.rows,
      pid: this.pid,
      startedAt: this.startedAt,
      status: this.status.kind,
      exitCode: this.status.kind === 'exited' ? this.status.exitCode : undefined,
      watchers: this.watchers.size,
    }
  }
}

/**
 * Owns every pane in this host process.
 *
 * Panes are keyed by their own minted id and tagged with the dsh session that
 * opened them, so the Web UI can show one session's crew while a pane survives
 * the browser navigating away and back.
 */
export class PaneRegistry {
  #panes = new Map()
  #tokens = new Map()
  #options

  /**
   * @param {object} options - spawn defaults and the subprocess seam accessor.
   */
  constructor(options) {
    this.#options = { scrollbackBytes: DEFAULT_SCROLLBACK_BYTES, ...options }
  }

  /**
   * Seat one agent: allocate a PTY running its CLI in the session workspace.
   * @param {object} request - agent definition, session, geometry, and cwd.
   * @returns {Promise<Pane>} the published pane, already streaming.
   */
  async spawn(request) {
    const { agent, sessionId, cwd, cols, rows, env } = request
    // Terminal capability first, so a deployment, a roster row, or one call
    // can still override it; everything after it is deliberate configuration.
    const childEnv = { ...TERMINAL_ENV, ...(this.#options.env ?? {}), ...(agent.env ?? {}), ...(env ?? {}) }
    const handle = await this.#options.spawnTerminal({
      argv: terminalArgv(agent, childEnv.TERM),
      cwd,
      env: childEnv,
      cols,
      rows,
      graceMs: this.#options.graceMs ?? 3000,
    })
    const pane = new Pane({
      id: `pane-${randomUUID().slice(0, 8)}`,
      sessionId,
      agentId: agent.id,
      label: agent.label ?? agent.id,
      accent: agent.accent ?? '#8b8b8b',
      cwd,
      cols,
      rows,
      handle,
      now: Date.now(),
      scrollbackBytes: this.#options.scrollbackBytes,
    })
    this.#panes.set(pane.id, pane)

    handle.output.setEncoding('utf8')
    handle.output.on('data', (chunk) => { pane.emit(chunk) })
    // A transport failure and a normal exit are the same fact to a watcher: the
    // terminal stopped producing. The code distinguishes them for the row.
    handle.done.then(
      outcome => { pane.settle(outcome?.exitCode ?? null) },
      () => { pane.settle(null) },
    )
    return pane
  }

  /**
   * @param {string} id - pane id.
   * @returns {Pane | undefined} the live pane.
   */
  get(id) {
    return this.#panes.get(id)
  }

  /**
   * @param {string | undefined} sessionId - restrict to one dsh session, or all.
   * @returns {Array<object>} listed pane rows, oldest first.
   */
  list(sessionId) {
    const rows = []
    for (const pane of this.#panes.values()) {
      if (sessionId !== undefined && pane.sessionId !== sessionId) continue
      rows.push(pane.describe())
    }
    return rows.sort((a, b) => a.startedAt - b.startedAt)
  }

  /**
   * Mint a single-use, short-lived credential for one WebSocket attach.
   *
   * The control route that mints it has already passed the request fence; the
   * upgrade route cannot re-run that check as usefully, because a WebSocket
   * handshake carries neither a body nor a content type. Redeeming a token is
   * therefore the upgrade's proof that a fence-passing caller asked for it.
   * @param {string} paneId - the pane the token authorizes.
   * @returns {string} the opaque token.
   */
  mintToken(paneId) {
    const token = randomUUID()
    this.#tokens.set(token, { paneId, expiresAt: Date.now() + TOKEN_TTL_MS })
    return token
  }

  /**
   * Redeem a token exactly once.
   * @param {string | undefined} token - value from the upgrade query string.
   * @returns {Pane | undefined} the authorized live pane, or undefined.
   */
  redeemToken(token) {
    if (typeof token !== 'string') return undefined
    const grant = this.#tokens.get(token)
    this.#tokens.delete(token)
    if (grant === undefined || grant.expiresAt < Date.now()) return undefined
    return this.#panes.get(grant.paneId)
  }

  /**
   * Attach one watcher to a pane and replay its retained screen first.
   * @param {Pane} pane - the target pane.
   * @param {(frame: object) => void} watcher - receives output and lifecycle frames.
   * @returns {() => void} detach.
   */
  attach(pane, watcher) {
    const retained = pane.scrollback.read()
    if (retained !== '') watcher({ t: 'out', d: retained })
    if (pane.status.kind === 'exited') watcher({ t: 'exit', code: pane.status.exitCode })
    pane.watchers.add(watcher)
    return () => { pane.watchers.delete(watcher) }
  }

  /**
   * Terminate one pane's process tree and forget it.
   * @param {string} id - pane id.
   * @returns {Promise<boolean>} whether a pane by that id existed.
   */
  async close(id) {
    const pane = this.#panes.get(id)
    if (pane === undefined) return false
    this.#panes.delete(id)
    for (const watcher of pane.watchers) watcher({ t: 'closed' })
    pane.watchers.clear()
    try {
      await pane.handle.terminate()
    } finally {
      pane.screen.dispose()
    }
    return true
  }

  /**
   * Terminate every pane and await quiescence. Idempotent.
   * @returns {Promise<void>} settles after the last process tree exits.
   */
  async closeAll() {
    const ids = [...this.#panes.keys()]
    await Promise.all(ids.map(id => this.close(id)))
    this.#tokens.clear()
  }
}
