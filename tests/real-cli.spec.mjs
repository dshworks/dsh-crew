/**
 * The tools against the products they exist to carry.
 *
 * Every other suite seats `bash`, because a shell has a deterministic screen and
 * no account. That is also its limit: a shell submits a line however it arrives,
 * paints instantly, and never asks whether it trusts the directory — so the three
 * corrections that matter most to `crew_send` are all invisible to it. They were
 * found by running the real products, and this is where that stays proven.
 *
 * Opt-in, because it needs `claude`/`codex` on PATH with working credentials and
 * spends real model tokens (two turns per crew member per run):
 *
 *     CREW_REAL_CLI=1 pnpm test
 *
 * Each crew member is seated in a fresh temporary workspace rather than the
 * repository, so answering a product's trust dialog here never leaves a real
 * project marked trusted.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterAll, describe, expect, it } from 'vitest'
import { apply, Config } from '../lib/index.js'
import { resolveCommand } from '../lib/roster.js'
import { createContext, createJobsService } from './harness.mjs'

const SESSION = 'real-cli-session'

/** Opt-in flag: without it this suite is skipped, credentials or not. */
const ENABLED = process.env.CREW_REAL_CLI === '1'

/**
 * A real turn takes tens of seconds, and the watcher only reports quiet three
 * seconds after the last repaint.
 */
const TURN_MS = 300_000

/** Crew members this suite exercises, when the machine has them. */
const CANDIDATES = ['claude', 'codex']

// Resolved before the suite is declared, so a machine without one of the
// products skips that crew member instead of failing it.
const available = new Set(ENABLED
  ? (await Promise.all(CANDIDATES.map(async id => (await resolveCommand(id) === undefined ? undefined : id))))
    .filter(id => id !== undefined)
  : [])

/** Workspaces to remove once the suite is done. */
const workspaces = []

afterAll(async () => {
  for (const dir of workspaces) await rm(dir, { recursive: true, force: true })
})

/**
 * Stand up the plugin over a throwaway workspace, with the job seam present.
 * @returns {Promise<object>} the fixture, the job double, and a tool caller.
 */
async function boot() {
  const cwd = await mkdtemp(`${tmpdir()}/dsh-crew-real-`)
  workspaces.push(cwd)
  const jobs = createJobsService()
  const local = createContext({
    sessions: { get: id => (id === SESSION ? { header: { cwd } } : undefined) },
    jobs: jobs.service,
  })
  apply(local.ctx, Config({}))
  const exec = { agent: { session: { id: SESSION } }, signal: new AbortController().signal }
  return {
    cwd,
    jobs,
    local,
    call: (name, args) => local.tools.get(name).execute(args, exec),
  }
}

/**
 * Seat a crew member and get it past whatever it opens on.
 *
 * A fresh directory is a directory neither product trusts, so the first screen
 * is a dialog rather than a composer. The plugin never answers a product's dialog
 * on its own — the caller does, with an empty message, and only then sends the
 * task. Sending the task first types it INTO the dialog, where its digits can
 * pick an option.
 * @param {object} fixture - from {@link boot}.
 * @param {string} id - the crew member to seat.
 * @returns {Promise<object>} the seated pane's first screen and its id.
 */
async function seatAndClear(fixture, id) {
  const seated = await fixture.call('crew_seat', { agent: id })
  expect(seated.cwd).toBe(fixture.cwd)
  // Readiness is "painted AND quiet": claude takes about four seconds to draw
  // its first frame and is perfectly quiet until then, so a quiet-only rule
  // hands back a blank screen and calls the crew member seated.
  expect(seated.screen.trim().length).toBeGreaterThan(0)
  if (/trust/i.test(seated.screen)) {
    const answered = await fixture.call('crew_send', { pane: seated.paneId, message: '' })
    expect(answered.screen).not.toMatch(/do you trust/i)
  }
  return seated
}

describe.skipIf(!ENABLED)('against the real coding agents', () => {
  for (const id of CANDIDATES) {
    describe.skipIf(!available.has(id))(id, () => {
      it('answers a two-line message it was actually sent', async () => {
        const fixture = await boot()
        const seated = await seatAndClear(fixture, id)
        const asked = await fixture.call('crew_send', {
          pane: seated.paneId,
          message: 'Reply with exactly the word PONG and nothing else.\nThis is line two of the same message; if you see it, also say TWO.',
        })
        // Both products read one burst ending in a carriage return as a paste and
        // keep the return as a newline. If Enter were not a separate keystroke,
        // this message would still be sitting unsent in the composer — and the
        // pane would be quiet, so the send would report it as the answer.
        expect(asked.settled).toBe(true)
        expect(asked.output).toContain('PONG')
        expect(asked.output).toContain('TWO')
        await fixture.local.close()
      }, TURN_MS)

      it('answers a background send through the job seam', async () => {
        const fixture = await boot()
        const seated = await seatAndClear(fixture, id)
        const started = await fixture.call('crew_send', {
          pane: seated.paneId,
          message: 'Reply with exactly the word BACKGROUND and nothing else.',
          run_in_background: true,
        })
        expect(started.kind).toBe('background')
        const record = fixture.jobs.get(started.jobId)
        // The call returned while the crew member was still reading the message.
        expect(record.outcome).toBeUndefined()

        const outcome = await record.hooks.done
        expect(outcome.status).toBe('completed')
        expect(outcome.output).toContain('BACKGROUND')
        await fixture.local.close()
      }, TURN_MS)
    })
  }
})
