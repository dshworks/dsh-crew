/**
 * Host-half behavior against real sockets and real terminals.
 *
 * These tests seat `bash` rather than Claude Code or Codex: the plugin's job is
 * to carry a terminal, and bash proves that with a deterministic screen and no
 * account. The real agent binaries are exercised by the live-composition check
 * in the README's verification section, where a wrong answer is visible.
 */
import { request } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { apply, Config } from '../lib/index.js'
import { control, createContext } from './harness.mjs'

/**
 * POST a control operation with headers `fetch` refuses to let a caller set.
 * @param {number} target - the listening port.
 * @param {Record<string, string>} headers - headers layered over the defaults.
 * @returns {Promise<{status: number}>} the response status.
 */
function rawPost(target, headers) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port: target,
      path: '/dsh-crew/rpc',
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
    }, (res) => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode }))
    })
    req.on('error', reject)
    req.end(JSON.stringify({ op: 'roster' }))
  })
}

const SESSION = 'session-under-test'

let fixture
let port

/**
 * Wait for a predicate to hold, sampling until the deadline.
 *
 * The predicate is awaited. An async one returns a promise, which is truthy
 * whatever it resolves to, so a version that only tested the return value would
 * pass on the first sample and leave its request in flight past the teardown —
 * an unhandled socket error attributed to whichever test ran next.
 * @param {() => boolean | Promise<boolean>} predicate - the condition.
 * @param {number} [timeoutMs] - deadline.
 * @returns {Promise<void>} resolves once true; rejects at the deadline.
 */
async function until(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

beforeEach(async () => {
  fixture = createContext({
    sessions: { get: id => (id === SESSION ? { header: { cwd: process.cwd() } } : undefined) },
  })
  apply(fixture.ctx, Config({
    agents: [{ id: 'shell', label: 'Shell', command: 'bash', args: ['--norc', '--noprofile', '-i'] }],
    cols: 80,
    rows: 24,
  }))
  port = await fixture.listen()
})

afterEach(async () => {
  await fixture.close()
})

describe('the request fence', () => {
  it('refuses a body that is not declared as JSON', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/dsh-crew/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{"op":"roster"}',
    })
    // A cross-site "simple" request cannot set application/json, so refusing
    // everything else is what keeps a malicious page off a spawning route.
    expect(response.status).toBe(415)
  })

  it('refuses a request a browser marked as cross-site', async () => {
    const response = await control(port, { op: 'roster' }, {
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    expect(response.status).toBe(403)
  })

  it('refuses a Host header naming somewhere else', async () => {
    // Raw `http.request`, not `fetch`: Host is a forbidden header name, so
    // undici silently rewrites it and the request would pass the fence it is
    // supposed to test. This is the DNS-rebinding shape — the socket reaches
    // us while the header names the attacker.
    const response = await rawPost(port, { host: 'attacker.example' })
    expect(response.status).toBe(403)
  })

  it('refuses an upgrade without a redeemable token', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/dsh-crew/attach?token=not-a-token`)
    const failed = await new Promise((resolve) => {
      socket.on('error', () => resolve(true))
      socket.on('open', () => resolve(false))
    })
    expect(failed).toBe(true)
  })
})

describe('the roster', () => {
  it('reports which crew members this host can actually start', async () => {
    const { body } = await control(port, { op: 'roster' })
    const shell = body.agents.find(agent => agent.id === 'shell')
    expect(shell.available).toBe(true)
    expect(body.agents.find(agent => agent.id === 'claude')).toBeDefined()
  })

  it('names the missing binary on a crew member this host cannot start', async () => {
    const local = createContext({ sessions: { get: () => undefined } })
    apply(local.ctx, Config({ agents: [{ id: 'ghost', command: 'definitely-not-installed-xyz' }] }))
    const localPort = await local.listen()
    const { body } = await control(localPort, { op: 'roster' })
    const ghost = body.agents.find(agent => agent.id === 'ghost')
    expect(ghost.available).toBe(false)
    expect(ghost.reason).toContain('definitely-not-installed-xyz')
    await local.close()
  })
})

describe('a seated pane', () => {
  it('carries terminal output to an attached socket and input back', async () => {
    const spawned = await control(port, { op: 'spawn', sessionId: SESSION, agentId: 'shell', cols: 80, rows: 24 })
    expect(spawned.status).toBe(200)
    const { pane, token } = spawned.body

    const socket = new WebSocket(`ws://127.0.0.1:${port}/dsh-crew/attach?token=${token}`)
    let received = ''
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString('utf8'))
      if (frame.t === 'out') received += frame.d
    })
    await new Promise(resolve => socket.on('open', resolve))

    socket.send(JSON.stringify({ t: 'in', d: 'echo crew-reached-the-terminal\r' }))
    await until(() => received.includes('crew-reached-the-terminal\r\n'))

    socket.close()
    await control(port, { op: 'close', paneId: pane.id })
  })

  it('replays its screen to a socket that attaches later', async () => {
    const spawned = await control(port, { op: 'spawn', sessionId: SESSION, agentId: 'shell' })
    const { pane, token } = spawned.body

    const first = new WebSocket(`ws://127.0.0.1:${port}/dsh-crew/attach?token=${token}`)
    let seen = ''
    first.on('message', (raw) => {
      const frame = JSON.parse(raw.toString('utf8'))
      if (frame.t === 'out') seen += frame.d
    })
    await new Promise(resolve => first.on('open', resolve))
    first.send(JSON.stringify({ t: 'in', d: 'echo before-the-reload\r' }))
    await until(() => seen.includes('before-the-reload\r\n'))
    first.close()

    // A browser reload takes a fresh token for the same pane and must find the
    // screen intact — the pane outlives the socket, which is the whole point of
    // keeping panes in the host rather than the tab.
    const again = await control(port, { op: 'attach', paneId: pane.id })
    const second = new WebSocket(`ws://127.0.0.1:${port}/dsh-crew/attach?token=${again.body.token}`)
    let replayed = ''
    second.on('message', (raw) => {
      const frame = JSON.parse(raw.toString('utf8'))
      if (frame.t === 'out') replayed += frame.d
    })
    await new Promise(resolve => second.on('open', resolve))
    await until(() => replayed.includes('before-the-reload'))

    second.close()
    await control(port, { op: 'close', paneId: pane.id })
  })

  it('reports the rendered screen rather than the raw byte stream', async () => {
    const spawned = await control(port, { op: 'spawn', sessionId: SESSION, agentId: 'shell' })
    const { pane, token } = spawned.body
    const socket = new WebSocket(`ws://127.0.0.1:${port}/dsh-crew/attach?token=${token}`)
    await new Promise(resolve => socket.on('open', resolve))
    socket.send(JSON.stringify({ t: 'in', d: 'printf "\\033[32mgreen-text\\033[0m\\n"\r' }))

    let screen = ''
    await until(async () => {
      screen = (await control(port, { op: 'peek', paneId: pane.id })).body.screen
      return screen.includes('green-text')
    })
    // The colour escape reached the browser but must not reach a model.
    // Written as an escape, not a literal ESC byte: the assertion is the
    // point of the test and must stay visible in a diff.
    expect(screen).not.toContain('\u001b[32m')

    socket.close()
    await control(port, { op: 'close', paneId: pane.id })
  })

  it('refuses to seat more panes than the session cap', async () => {
    const local = createContext({ sessions: { get: () => ({ header: { cwd: process.cwd() } }) } })
    apply(local.ctx, Config({
      agents: [{ id: 'shell', command: 'bash', args: ['--norc', '--noprofile', '-i'] }],
      maxPanesPerSession: 1,
    }))
    const localPort = await local.listen()
    const first = await control(localPort, { op: 'spawn', sessionId: SESSION, agentId: 'shell' })
    expect(first.status).toBe(200)
    const second = await control(localPort, { op: 'spawn', sessionId: SESSION, agentId: 'shell' })
    expect(second.status).toBe(400)
    expect(second.body.error).toContain('1 panes')
    await local.close()
  })

  it('starts in the workspace of the session that opened it, not the server cwd', async () => {
    const local = createContext({ sessions: { get: () => ({ header: { cwd: '/tmp' } }) } })
    apply(local.ctx, Config({ agents: [{ id: 'shell', command: 'bash', args: ['--norc', '--noprofile', '-i'] }] }))
    const localPort = await local.listen()
    const { body } = await control(localPort, { op: 'spawn', sessionId: SESSION, agentId: 'shell' })
    expect(body.pane.cwd).toBe('/tmp')
    await local.close()
  })

  it('refuses to start anything for a session this host does not know', async () => {
    // Defaulting to the server's own cwd would hand an agent write access to
    // whatever directory dsh was launched from, on nothing but an unknown id.
    const response = await control(port, { op: 'spawn', sessionId: 'no-such-session', agentId: 'shell' })
    expect(response.status).toBe(400)
    expect(response.body.error).toContain('no session "no-such-session"')
  })

  it('tells the child it is on a colour terminal, whatever the server inherited', async () => {
    // A harness started from a non-interactive shell carries TERM=dumb, and the
    // subprocess seam passes it straight through; a coding CLI that reads it
    // turns off exactly the output a pane exists to show.
    const spawned = await control(port, { op: 'spawn', sessionId: SESSION, agentId: 'shell' })
    const { pane, token } = spawned.body
    const socket = new WebSocket(`ws://127.0.0.1:${port}/dsh-crew/attach?token=${token}`)
    let received = ''
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString('utf8'))
      if (frame.t === 'out') received += frame.d
    })
    await new Promise(resolve => socket.on('open', resolve))
    socket.send(JSON.stringify({ t: 'in', d: 'echo "TERM=$TERM COLORTERM=$COLORTERM"\r' }))
    await until(() => received.includes('TERM=xterm-256color COLORTERM=truecolor\r\n'))
    socket.close()
    await control(port, { op: 'close', paneId: pane.id })
  })

  it('reports an exit instead of leaving the pane looking alive', async () => {
    const local = createContext({ sessions: { get: () => ({ header: { cwd: process.cwd() } }) } })
    apply(local.ctx, Config({ agents: [{ id: 'brief', command: 'bash', args: ['-c', 'exit 7'] }] }))
    const localPort = await local.listen()
    const { body } = await control(localPort, { op: 'spawn', sessionId: SESSION, agentId: 'brief' })
    await until(async () => {
      const listed = await control(localPort, { op: 'list', sessionId: SESSION })
      return listed.body.panes[0]?.status === 'exited'
    })
    const listed = await control(localPort, { op: 'list', sessionId: SESSION })
    expect(listed.body.panes[0].id).toBe(body.pane.id)
    expect(listed.body.panes[0].exitCode).toBe(7)
    await local.close()
  })
})

describe('teardown', () => {
  it('terminates every pane when the plugin fiber disposes', async () => {
    const spawned = await control(port, { op: 'spawn', sessionId: SESSION, agentId: 'shell' })
    const pid = spawned.body.pane.pid
    expect(() => process.kill(pid, 0)).not.toThrow()
    await fixture.close()
    await until(() => {
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    })
    // afterEach closes again; closeAll is idempotent by contract.
    //
    // The budget has to clear `graceMs` with room to spare: an interactive bash
    // ignores SIGTERM, so this pane is always the SIGKILL escalation three
    // seconds later, and the default per-test limit would cut `until`'s own
    // deadline off before it could ever be reached.
  }, 20_000)
})
