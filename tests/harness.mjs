/**
 * A composition stand-in for the tests: the smallest cordis context and
 * subprocess seam this plugin actually consumes, over a real `node:http` server
 * and a real PTY.
 *
 * It exists so the host half can be exercised the way the browser will drive it
 * — real sockets, real terminals, real agent binaries — without booting the
 * whole harness. It deliberately implements the seam's published contract rather
 * than a convenient subset; a test that passes against a softer fake would prove
 * nothing about the plugin running inside dsh.
 */
import { createServer } from 'node:http'
import { PassThrough } from 'node:stream'
import pty from 'node-pty'

/**
 * A `SubprocessTerminalHandle` over node-pty — the same implementation shape
 * `@deepseek-ai/dsh-subprocess-local` provides in production.
 * @param {object} spec - argv, cwd, env, cols, rows.
 * @returns {object} the terminal handle.
 */
export function spawnTerminal(spec) {
  const [command, ...args] = spec.argv
  const child = pty.spawn(command, args, {
    // `dumb`, exactly as `@deepseek-ai/dsh-subprocess-local` hardcodes it, and
    // NOT the value the pane would like. node-pty resolves `opt.name ||
    // env.TERM` and then assigns `env.TERM = name`, so the provider's constant
    // wins over anything a caller puts in `spec.env`. A double that passed
    // `xterm-256color` here would honour a `TERM` the real seam silently
    // discards — which is exactly how a broken pane once shipped a green suite.
    name: 'dumb',
    cols: spec.cols,
    rows: spec.rows,
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
  })
  const output = new PassThrough({ encoding: 'utf8' })
  child.onData(data => { output.write(data) })
  let settle
  const done = new Promise((resolve) => { settle = resolve })
  child.onExit(({ exitCode, signal }) => {
    output.end()
    settle({ exitCode, signal: signal ?? null })
  })
  return {
    pid: child.pid,
    output,
    done,
    async write(data) { child.write(data) },
    async inspectForeground() { return undefined },
    async signalForeground(signal) {
      process.kill(child.pid, signal)
      return child.pid
    },
    async terminate() {
      try {
        child.kill()
      } catch {
        // Already reaped: terminate is idempotent by contract.
      }
      // Escalate exactly as `@deepseek-ai/dsh-subprocess-local` does. Without
      // this the double is WEAKER than the seam it stands in for: node-pty's
      // kill sends SIGHUP, an interactive shell is entitled to ignore it, and
      // `terminate` would then await a `done` that never settles. That is a
      // hang, not a failure — locally the shell happened to die and the suite
      // stayed green; on a slower CI runner it did not, and the teardown test
      // timed out with nothing to point at.
      const escalation = setTimeout(() => {
        try {
          process.kill(child.pid, 'SIGKILL')
        } catch {
          // Exited between the timer firing and the signal: nothing to kill.
        }
      }, spec.graceMs ?? 3000)
      try {
        await done
      } finally {
        clearTimeout(escalation)
      }
    },
  }
}

/**
 * A stand-in for the harness's background-job registry (`ctx.jobs`).
 *
 * It implements the producer side of the published `JobStart` contract, which is
 * the half this plugin has to get right: `run()` is called once, synchronously,
 * and must hand back `cancel` and `done` before `start` returns an id. What it
 * deliberately does NOT emulate is the runtime's own half — the session fence,
 * the controller requirement, completion notices — because a double cannot
 * prove those and pretending to would only hide where they actually live.
 * @returns {object} the service plus the records a test inspects.
 */
export function createJobsService() {
  const records = []
  return {
    service: {
      /**
       * @param {object} spec - the `JobStart` a producer supplies.
       * @returns {string} the issued job id.
       */
      start(spec) {
        for (const key of ['kind', 'label']) {
          if (typeof spec[key] !== 'string' || spec[key] === '') throw new Error(`a job needs a ${key}`)
        }
        if (typeof spec.run !== 'function') throw new Error('a job needs a starter')
        const hooks = spec.run()
        if (typeof hooks?.cancel !== 'function' || typeof hooks?.done?.then !== 'function') {
          throw new Error('a job starter must return cancel and done')
        }
        const record = { id: `${spec.kind}-${records.length + 1}`, spec, hooks, outcome: undefined }
        // The registry records the outcome and never lets `done` reject.
        void hooks.done.then((outcome) => { record.outcome = outcome })
        records.push(record)
        return record.id
      },
    },
    records,
    /**
     * @param {string} id - an issued job id.
     * @returns {object | undefined} that job's record.
     */
    get(id) {
      return records.find(record => record.id === id)
    },
  }
}

/**
 * A cordis-shaped context carrying only what this plugin injects.
 * @param {object} options - `sessions` map, `jobs` service, and the web server route tables.
 * @returns {object} the context plus test-side controls.
 */
export function createContext(options = {}) {
  const disposers = []
  const routes = new Map()
  const upgrades = new Map()
  const tools = new Map()
  const services = {
    // Overridable so a test can watch the wire: what a pane writes to its child
    // is a contract in its own right, and the shell these tests seat is far more
    // forgiving about it than the products the plugin exists to carry.
    subprocess: { spawnTerminal: options.spawnTerminal ?? spawnTerminal },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
      registerUpgrade(route) {
        upgrades.set(route.path, route)
        return () => upgrades.delete(route.path)
      },
    },
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
    sessions: options.sessions,
    // Absent unless a test supplies it: a deployment without the job seam is a
    // real configuration, and `crew_send` has to say so rather than throw.
    jobs: options.jobs,
  }

  const ctx = {
    get: name => services[name],
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    inject(names, fn) {
      if (names.every(name => services[name] !== undefined)) fn(ctx)
    },
    get subprocess() { return services.subprocess },
    get webServer() { return services.webServer },
    get tools() { return services.tools },
  }

  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname
    const route = routes.get(path)
    if (route === undefined) {
      res.writeHead(404).end()
      return
    }
    void route.handler(req, res)
  })
  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url, 'http://localhost').pathname
    const route = upgrades.get(path)
    if (route === undefined) {
      socket.destroy()
      return
    }
    route.handler(req, socket, head)
  })

  return {
    ctx,
    tools,
    /** @returns {Promise<number>} the listening port. */
    async listen() {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      return server.address().port
    },
    /** Dispose every registered effect, then close the server. */
    async close() {
      for (const dispose of disposers.reverse()) await dispose()
      // `fetch` keeps its sockets alive between calls; closing the server
      // without dropping them leaves the client reading a half-open connection
      // and reporting ECONNRESET after the test has already passed.
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

/**
 * POST one control operation the way the browser does.
 * @param {number} port - the listening port.
 * @param {object} body - the operation.
 * @param {object} [init] - header overrides for fence tests.
 * @returns {Promise<{status: number, body: any}>} the response.
 */
export async function control(port, body, init = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/dsh-crew/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...init.headers },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, body: text === '' ? undefined : safeJson(text) }
}

/**
 * @param {string} text - a response body.
 * @returns {any} parsed JSON, or the raw text when the body is a plain message.
 */
function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
