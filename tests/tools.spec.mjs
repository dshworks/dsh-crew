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
import { createContext, spawnTerminal } from './harness.mjs'

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
 * @returns {object} the fixture.
 */
function boot(workspaces = { [SESSION]: process.cwd(), [OTHER]: process.cwd() }) {
  const local = createContext({
    sessions: {
      get: id => (id in workspaces ? { header: { cwd: workspaces[id] } } : undefined),
    },
  })
  apply(local.ctx, Config({ agents: [SHELL] }))
  return local
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
    const writes = []
    const watched = createContext({
      sessions: { get: () => ({ header: { cwd: process.cwd() } }) },
      spawnTerminal: async (spec) => {
        const handle = await spawnTerminal(spec)
        return { ...handle, write: async (data) => { writes.push(data); return handle.write(data) } }
      },
    })
    apply(watched.ctx, Config({ agents: [SHELL] }))
    const exec = execFor(SESSION)
    const { paneId } = await watched.tools.get('crew_seat').execute({ agent: 'shell' }, exec)

    await watched.tools.get('crew_send').execute({ pane: paneId, message: 'echo two-writes-not-one' }, exec)
    expect(writes).toEqual(['echo two-writes-not-one', '\r'])

    await watched.close()
  }, 30_000)

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
})
