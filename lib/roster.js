/**
 * The crew roster: which coding agents this plugin knows how to seat, and
 * whether this machine can actually start them.
 *
 * A roster entry is data, not code. It names an executable, the argv that puts
 * that executable into its interactive terminal UI, and the presentation facts
 * the browser needs (label, accent). Adding a third agent is one object here,
 * or one `agents:` row in cordis.yml — never a new package.
 *
 * Resolution is deliberately separate from spawning: the Web UI asks for the
 * roster before any process exists so it can show an agent's button disabled,
 * with the reason, instead of offering a launch that fails a second later.
 */
import { delimiter, isAbsolute, join } from 'node:path'
import { access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'

/**
 * Built-in crew members. `argv` is the interactive form of each product: the
 * plain command with no prompt argument, which is what drops the CLI into its
 * own terminal UI rather than one-shot mode.
 */
export const BUILTIN_AGENTS = [
  {
    id: 'claude',
    label: 'Claude Code',
    command: 'claude',
    args: [],
    /** Brand accent used for the pane rail and the launch button. */
    accent: '#d97757',
    /** Probe that reports the installed version without starting a session. */
    versionArgs: ['--version'],
  },
  {
    id: 'codex',
    label: 'Codex',
    command: 'codex',
    args: [],
    accent: '#10a37f',
    versionArgs: ['--version'],
  },
  {
    id: 'dsh',
    label: 'dsh',
    command: 'dsh',
    args: [],
    accent: '#4d6bfe',
    versionArgs: ['--version'],
  },
]

/**
 * Merge configured agent rows over the built-ins by `id`, then append the rest.
 * A configured row may override any field of a built-in (a different `command`
 * for a wrapper script, extra `args`, a new accent) without restating the ones
 * it keeps.
 * @param {ReadonlyArray<object>} configured - `agents` rows from plugin config.
 * @returns {Array<object>} the effective roster in display order.
 */
export function composeRoster(configured = []) {
  const roster = BUILTIN_AGENTS.map(agent => ({ ...agent }))
  for (const row of configured) {
    if (typeof row?.id !== 'string' || row.id === '') continue
    const existing = roster.findIndex(agent => agent.id === row.id)
    if (existing === -1) roster.push({ args: [], accent: '#8b8b8b', ...row })
    else roster[existing] = { ...roster[existing], ...row }
  }
  return roster.filter(agent => agent.enabled !== false && typeof agent.command === 'string')
}

/**
 * Whether one path is an executable regular file.
 * @param {string} candidate - absolute path to test.
 * @returns {Promise<boolean>} true when it can be spawned.
 */
async function isExecutableFile(candidate) {
  try {
    const info = await stat(candidate)
    if (!info.isFile()) return false
    await access(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve a bare command name against a PATH string, the way a shell would.
 *
 * The harness's subprocess seam performs its own resolution when it spawns; this
 * copy exists only to answer "can I offer this button?" before any spawn, so a
 * disagreement between the two costs a misleading enabled state, never a
 * security decision.
 * @param {string} command - bare name or an explicit path.
 * @param {string | undefined} path - PATH to search; the ambient one by default.
 * @returns {Promise<string | undefined>} the resolved absolute path, or undefined.
 */
export async function resolveCommand(command, path = process.env.PATH) {
  if (command.includes('/') || isAbsolute(command)) {
    return await isExecutableFile(command) ? command : undefined
  }
  for (const dir of (path ?? '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, command)
    if (await isExecutableFile(candidate)) return candidate
  }
  return undefined
}

/**
 * Project the roster for the browser: presentation facts plus whether each
 * command resolves on this host right now.
 * @param {ReadonlyArray<object>} roster - the effective roster.
 * @returns {Promise<Array<object>>} rows the launch bar renders directly.
 */
export async function describeRoster(roster) {
  return await Promise.all(roster.map(async (agent) => {
    const resolved = await resolveCommand(agent.command)
    return {
      id: agent.id,
      label: agent.label ?? agent.id,
      accent: agent.accent ?? '#8b8b8b',
      command: agent.command,
      available: resolved !== undefined,
      // The browser shows this verbatim on a disabled button, so it names the
      // missing thing rather than describing the failure abstractly.
      reason: resolved === undefined ? `${agent.command} is not on the host PATH` : undefined,
    }
  }))
}
