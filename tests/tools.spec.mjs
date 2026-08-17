/**
 * The agent half: the five tools the dsh model runs the crew with.
 *
 * The split view has a human to notice when it misbehaves. These do not — a
 * model calls them unattended, so the contract each one advertises has to hold
 * without anyone watching: `crew_send` really waits for the answer, `crew_peek`
 * really returns the rendered screen, and a pane really belongs to one session.
 *
 * Like the host suite, these seat `bash` rather than a coding agent: the tools
 * carry a terminal, and a shell proves that with a deterministic screen and no
 * account.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply, Config } from '../lib/index.js'
import { createContext, createJobsService, spawnTerminal } from './harness.mjs'

const SESSION = 'session-under-test'
const OTHER = 'someone-elses-session'

/** A shell whose screen only changes when this test types into it. */
const SHELL = { id: 'shell', label: 'Shell', command: 'bash', args: ['--norc', '--noprofile', '-i'] }

let fixture
let tools

/**
 * The tool-execution identity a session's model call carries.
 * @param {string} sessionId - the calling session.
 * @returns {object} an `exec` argument.
 */
function execFor(sessionId) {
  return { agent: { session: { id: sessionId } }, signal: new AbortController().signal }
}

/**
 * Run one registered tool the way the tool runtime does, argument validation
 * included.
 * @param {string} name - the tool name.
 * @param {object} args - its arguments.
 * @param {string} [sessionId] - the calling session.
 * @returns {Promise<object>} the tool's return value.
 */
function call(name, args, sessionId = SESSION) {
  return tools.get(name).execute(args, execFor(sessionId))
}

/**
 * Stand up the plugin over a session table.
 * @param {Record<string, string | undefined>} workspaces - session id to cwd.
 * @param {object} [options] - `jobs` service and `config` overrides.
 * @returns {object} the fixture.
 */
function boot(workspaces = { [SESSION]: process.cwd(), [OTHER]: process.cwd() }, options = {}) {
  const local = createContext({
    sessions: {
      get: id => (id in workspaces ? { header: { cwd: workspaces[id] } } : undefined),
    },
    jobs: options.jobs,
  })
  apply(local.ctx, Config({ agents: [SHELL], ...options.config }))
  return local
}

/**
 * A fixture whose panes record every byte and signal sent to their child.
 *
 * What a pane puts on the wire is a contract in its own right: the shell these
 * tests seat submits a line however it arrives, while the products this plugin
 * exists to carry do not. So the wire shape is asserted directly.
 * @param {object} [options] - `jobs` service and `config` overrides.
 * @returns {object} the fixture, plus the recorded writes and signals.
 */
function bootWatchingTheWire(options = {}) {
  const writes = []
  const signals = []
  const local = createContext({
    sessions: { get: () => ({ header: { cwd: process.cwd() } }) },
    jobs: options.jobs,
    spawnTerminal: async (spec) => {
      const handle = await spawnTerminal(spec)
      return {
        ...handle,
        write: async (data) => { writes.push(data); return handle.write(data) },
        signalForeground: async (signal) => { signals.push(signal); return handle.signalForeground(signal) },
      }
    },
  })
  apply(local.ctx, Config({ agents: [SHELL], ...options.config }))
  return { local, writes, signals }
}

beforeEach(() => {
  fixture = boot()
  tools = fixture.tools
})

afterEach(async () => {
  await fixture.close()
})

describe('the crew tools', () => {
  it('registers exactly the five the README documents', () => {
    expect([...tools.keys()].sort()).toEqual(['crew_dismiss', 'crew_list', 'crew_peek', 'crew_seat', 'crew_send'])
  })

  it('is silent when configured off', async () => {
    const off = createContext({ sessions: { get: () => ({ header: { cwd: process.cwd() } }) } })
    apply(off.ctx, Config({ agents: [SHELL], tools: false }))
    expect(off.tools.size).toBe(0)
    await off.close()
  })

  it('seats a crew member and hands back its first screen', async () => {
    const seated = await call('crew_seat', { agent: 'shell' })
    expect(seated.paneId).toMatch(/^pane-/)
    expect(seated.cwd).toBe(process.cwd())
    // The point of returning the first screen is telling the model whether the
    // CLI is ready or sitting on a login wall, so it must not come back empty.
    expect(seated.screen.length).toBeGreaterThan(0)
    await call('crew_dismiss', { pane: seated.paneId })
  })

  it('names the crew members it knows when asked for one it does not', async () => {
    await expect(call('crew_seat', { agent: 'nobody' })).rejects.toThrow(/available: claude, codex, dsh, shell/)
  })

  it('refuses to seat anything for a session with no workspace', async () => {
    // The browser route refuses this; the tool path used to default to the
    // server's own cwd, which is write access to wherever dsh was launched.
    const orphan = boot({ [SESSION]: undefined })
    await expect(orphan.tools.get('crew_seat').execute({ agent: 'shell' }, execFor(SESSION)))
      .rejects.toThrow(/no workspace directory/)
    await orphan.close()
  })

  it('sends work, waits for the answer, and returns the rendered screen', async () => {
    const { paneId } = await call('crew_seat', { agent: 'shell' })
    const sent = await call('crew_send', { pane: paneId, message: 'printf "\\033[32mthe-crew-answered\\033[0m\\n"' })
    expect(sent.settled).toBe(true)
    expect(sent.screen).toContain('the-crew-answered')
    // A model must never be handed cursor addressing and colour escapes. The
    // echoed command line still reads `[32m` as ordinary text, because that is
    // what the human sees too — what must be gone is the ESC byte itself.
    expect(sent.screen).not.toContain('\u001b')
    await call('crew_dismiss', { pane: paneId })
  }, 30_000)

  it('types the message and presses Enter as two separate writes', async () => {
    // bash submits either way, so no end-to-end assertion can catch this. Both
    // Claude Code and Codex read one burst ending in a return as a PASTE: the
    // return lands in the composer as a newline, the task is never sent, the
    // pane goes quiet, and `crew_send` reports the unsent question as settled.
    // The wire shape is therefore the contract, and this is where it is held.
    const { local, writes } = bootWatchingTheWire()
    const exec = execFor(SESSION)
    const { paneId } = await local.tools.get('crew_seat').execute({ agent: 'shell' }, exec)

    await local.tools.get('crew_send').execute({ pane: paneId, message: 'echo two-writes-not-one' }, exec)
    expect(writes).toEqual(['echo two-writes-not-one', '\r'])

    await local.close()
  }, 30_000)

  it('presses Enter alone for an empty message, so a dialog can be answered', async () => {
    // The first screen may be a trust prompt or a login wall rather than a
    // composer. Answering it must not type anything into it.
    const { local, writes } = bootWatchingTheWire()
    const exec = execFor(SESSION)
    const { paneId } = await local.tools.get('crew_seat').execute({ agent: 'shell' }, exec)

    await local.tools.get('crew_send').execute({ pane: paneId, message: '' }, exec)
    expect(writes).toEqual(['\r'])

    await local.close()
  }, 30_000)

  it('returns what arrived since the send, and keeps the whole screen available', async () => {
    // The viewport is mostly banner and composer. A model asking "what did the
    // crew member say" should not have to find the answer in it again.
    const { paneId } = await call('crew_seat', { agent: 'shell' })
    await call('crew_send', { pane: paneId, message: 'echo answered-first' })
    const second = await call('crew_send', { pane: paneId, message: 'echo answered-second' })
    expect(second.kind).toBe('foreground')
    expect(second.output).toContain('answered-second')
    expect(second.output).not.toContain('answered-first')
    expect(second.screen).toContain('answered-first')
    await call('crew_dismiss', { pane: paneId })
  }, 40_000)

  it('peeks at what the pane shows now, as the human sees it', async () => {
    const { paneId } = await call('crew_seat', { agent: 'shell' })
    await call('crew_send', { pane: paneId, message: 'echo peeked-at-this' })
    const peeked = await call('crew_peek', { pane: paneId })
    expect(peeked.screen).toContain('peeked-at-this')
    expect(peeked.status).toBe('running')
    await call('crew_dismiss', { pane: paneId })
  }, 30_000)

  it('lists this session\'s crew and not another session\'s', async () => {
    const mine = await call('crew_seat', { agent: 'shell' })
    const theirs = await call('crew_seat', { agent: 'shell' }, OTHER)
    const listed = await call('crew_list', {})
    expect(listed.available).toContain('shell')
    expect(listed.panes.map(pane => pane.id)).toEqual([mine.paneId])
    await call('crew_dismiss', { pane: mine.paneId })
    await call('crew_dismiss', { pane: theirs.paneId }, OTHER)
  }, 30_000)

  it('refuses to touch a pane belonging to another session', async () => {
    const theirs = await call('crew_seat', { agent: 'shell' }, OTHER)
    // Every pane-addressed tool goes through the same ownership check, so a
    // guessed pane id is worthless from the wrong session.
    await expect(call('crew_send', { pane: theirs.paneId, message: 'whoami' })).rejects.toThrow(/another session/)
    await expect(call('crew_peek', { pane: theirs.paneId })).rejects.toThrow(/another session/)
    await expect(call('crew_dismiss', { pane: theirs.paneId })).rejects.toThrow(/another session/)
    await call('crew_dismiss', { pane: theirs.paneId }, OTHER)
  })

  it('dismisses a pane and refuses to work it afterwards', async () => {
    const { paneId } = await call('crew_seat', { agent: 'shell' })
    expect(await call('crew_dismiss', { pane: paneId })).toEqual({ closed: true })
    await expect(call('crew_peek', { pane: paneId })).rejects.toThrow(/no crew pane/)
  })

  it('rejects a call missing a required argument before it runs', async () => {
    await expect(call('crew_send', { pane: 'pane-whatever' })).rejects.toThrow()
  })

  it('says what is missing when the host has no job seam', async () => {
    // The default fixture is a deployment without `ctx.jobs`, which is a real
    // configuration — the split view and the four other tools work without it.
    const { paneId } = await call('crew_seat', { agent: 'shell' })
    await expect(call('crew_send', { pane: paneId, message: 'echo x', run_in_background: true }))
      .rejects.toThrow(/load @deepseek-ai\/dsh-jobs/)
    await call('crew_dismiss', { pane: paneId })
  }, 30_000)
})

describe('a background send', () => {
  /**
   * Seat a shell in a fixture that has the job seam.
   * @param {object} [options] - `config` overrides.
   * @returns {Promise<object>} the fixture, the job double, and a bound sender.
   */
  async function seat(options = {}) {
    const jobs = createJobsService()
    const wire = bootWatchingTheWire({ jobs: jobs.service, ...options })
    const exec = execFor(SESSION)
    const { paneId } = await wire.local.tools.get('crew_seat').execute({ agent: 'shell' }, exec)
    return {
      ...wire,
      jobs,
      exec,
      paneId,
      send: args => wire.local.tools.get('crew_send').execute({ pane: paneId, ...args }, exec),
    }
  }

  it('returns a job id instead of blocking, and reports the answer through it', async () => {
    const { jobs, local, exec, send } = await seat()
    const started = await send({ message: 'echo answered-in-background', run_in_background: true })
    expect(started).toEqual({ kind: 'background', jobId: 'crew-1' })

    const record = jobs.get(started.jobId)
    // The whole point: the call came back before the crew member had finished.
    expect(record.outcome).toBeUndefined()
    expect(record.spec.label).toBe('Shell ← echo answered-in-background')
    // The job registry fences access by the owning agent's session, so the live
    // agent — not a copy of its id — has to be handed over.
    expect(record.spec.owner).toBe(exec.agent)

    const outcome = await record.hooks.done
    expect(outcome.status).toBe('completed')
    expect(outcome.output).toContain('answered-in-background')
    await local.close()
  }, 40_000)

  it('cancels by interrupting the crew member, leaving the pane seated', async () => {
    const { jobs, local, signals, send, paneId } = await seat()
    const started = await send({ message: 'sleep 30', run_in_background: true })
    const record = jobs.get(started.jobId)
    // Let the submit land, so the interrupt reaches work that is really running.
    await new Promise(resolve => { setTimeout(resolve, 700) })

    record.hooks.cancel('changed my mind')
    const outcome = await record.hooks.done
    expect(outcome.status).toBe('killed')
    expect(signals).toEqual(['SIGINT'])
    // A cancelled delegation is not a reason to close a terminal the human is
    // watching, so the pane is still there to send the next message to.
    expect(await local.tools.get('crew_peek').execute({ pane: paneId }, execFor(SESSION))).toMatchObject({ status: 'running' })
    await local.close()
  }, 40_000)

  it('can be turned off, parameter and all', async () => {
    const { local, send } = await seat({ config: { enableRunInBackground: false } })
    expect(local.tools.get('crew_send').parameters.properties.run_in_background).toBeUndefined()
    // Undeclared arguments reach `execute` anyway, so the refusal is what holds.
    await expect(send({ message: 'echo nope', run_in_background: true }))
      .rejects.toThrow(/enableRunInBackground: false/)
    await local.close()
  }, 30_000)
})
