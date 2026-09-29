// Does this plugin still install into a current dsh the way users install it?
//
// What it measures: the supported install path, for real. Install a published
// dsh into a scratch prefix, point DSH_HOME at a scratch directory, and run
// `dsh plugin --profile web add <this plugin>`. Then assert two things.
//
// 1. dsh admits it. Since 0.1.7 dsh checks every `@deepseek-ai/dsh` and
//    `@deepseek-ai/dsh-*` peer range against the running version itself
//    (`semver.satisfies(runtime, range, { includePrerelease: true })`), before
//    and after pnpm runs, and rolls the profile back on a mismatch; the same
//    gate disables the plugin at profile startup. A non-zero exit here is the
//    gate refusing us, or the install failing outright.
// 2. Nothing the host already supplies lands in the profile. The profile is a
//    pnpm project with `nodeLinker: hoisted` and `autoInstallPeers: false`, and
//    dsh routes any import the profile does not physically hold to the host's
//    own copy. A package in our `dependencies` that the host also ships is
//    therefore hoisted into the profile and shadows the host's copy for every
//    plugin in that profile. Host-supplied packages belong in
//    peerDependencies.
//
// Why it no longer builds one npm tree: the previous version installed dsh and
// this plugin together into a fresh npm project and counted `@deepseek-ai/dsh-*`
// copies. That is not how anyone installs a dsh plugin. npm auto-installs peers
// and resolves them to the highest match, so it reported split harness trees
// that the real path never produces, raised a false release alarm, and taught
// the wrong rule ("never OR the next dsh line into a peer range").
//
// Two checks, because they fail separately: this tree (did we fix it?) and the
// PUBLISHED package (did the fix ship?). `--tree-only` checks this tree only,
// for pull requests, where the published package is by definition still the
// old one. Against dsh `latest` both must pass. Against `next`, when npm serves
// one ahead of `latest`, this tree is checked as an advisory: reported, never
// failing, because a red check nobody can clear yet gets switched off.
//
// `DSH_VERSION=<version>` replaces `latest` as the required host.
// `--keep` leaves the scratch directory in place and prints its path.
//
// Needs node, npm, and pnpm on PATH (`dsh plugin` runs pnpm). Each host install
// is several hundred MB; the scratch directory is removed on every exit path.
//
// Exit 0 clean, 1 drift, 2 could not check.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TREE_ONLY = process.argv.includes('--tree-only')
const KEEP = process.argv.includes('--keep')
const ROOT = new URL('..', import.meta.url).pathname
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const PROFILE = 'web'

/** A failure that means "could not check", not "the plugin drifted". */
class CouldNotCheck extends Error {}

const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...options })

/**
 * Every package name installed under a node_modules tree, nested ones included.
 * @param {string} dir - a directory holding `node_modules`.
 * @returns {Map<string, string>} package name to version.
 */
function installedPackages(dir) {
  const found = new Map()
  const walk = (nm) => {
    if (!existsSync(nm)) return
    for (const entry of readdirSync(nm, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const names = entry.name.startsWith('@')
        ? readdirSync(join(nm, entry.name)).map(child => `${entry.name}/${child}`)
        : [entry.name]
      for (const name of names) {
        const manifest = join(nm, name, 'package.json')
        if (!existsSync(manifest)) continue
        if (!found.has(name)) found.set(name, JSON.parse(readFileSync(manifest, 'utf8')).version)
        walk(join(nm, name, 'node_modules'))
      }
    }
  }
  walk(join(dir, 'node_modules'))
  return found
}

/**
 * Install one published dsh into its own prefix, once per version.
 * @param {string} scratch - the run's scratch root.
 * @param {string} version - an exact dsh version.
 * @returns {{bin: string, supplies: Map<string, string>}} its CLI and every package it ships.
 */
const hosts = new Map()
function host(scratch, version) {
  if (hosts.has(version)) return hosts.get(version)
  const prefix = join(scratch, `host-${version}`)
  try {
    run('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', `@deepseek-ai/dsh@${version}`])
  } catch (error) {
    throw new CouldNotCheck(`could not install dsh ${version}: ${lastLines(error)}`)
  }
  const installed = { bin: join(prefix, 'node_modules', '.bin', 'dsh'), supplies: installedPackages(prefix) }
  hosts.set(version, installed)
  return installed
}

/** The tail of a failed command's output, for the report. */
function lastLines(error, count = 8) {
  const out = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim()
  return out.split('\n').slice(-count).join('\n') || error.message
}

/**
 * Run `dsh plugin --profile web add <spec>` in a fresh DSH_HOME and judge it.
 * @param {string} scratch - the run's scratch root.
 * @param {string} version - the dsh host version.
 * @param {string} spec - a tarball path or a registry spec.
 * @param {string} label - what the report calls this check.
 * @returns {{ok: boolean, lines: string[]}} the verdict and its report lines.
 */
function check(scratch, version, spec, label) {
  const { bin, supplies } = host(scratch, version)
  const home = mkdtempSync(join(scratch, 'home-'))
  const added = spawnSync(bin, ['plugin', '--profile', PROFILE, 'add', spec], {
    cwd: scratch,
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const output = `${added.stdout ?? ''}${added.stderr ?? ''}`
  if (added.error !== undefined) throw new CouldNotCheck(`could not run dsh ${version}: ${added.error.message}`)
  if (added.status !== 0) {
    const refused = output.split('\n').filter(line => /incompatible with dsh|installation rejected/.test(line))
    if (refused.length === 0) {
      throw new CouldNotCheck(`\`dsh plugin add\` failed on dsh ${version} for a reason other than the gate:\n${output.trim().split('\n').slice(-8).join('\n')}`)
    }
    return { ok: false, lines: [`- FAIL  ${label} — dsh refused it:\n\n\`\`\`\n${refused.slice(0, 1).join('\n')}\n\`\`\`\n`] }
  }
  const profile = installedPackages(join(home, 'profiles', PROFILE))
  profile.delete(pkg.name)
  const shadows = [...profile].filter(([name]) => supplies.has(name))
  if (shadows.length > 0) {
    const rows = shadows.map(([name, v]) => `    ${name}@${v} (host ships ${supplies.get(name)})`)
    return {
      ok: false,
      lines: [`- FAIL  ${label} — the profile now holds copies of packages the host supplies, shadowing them for every plugin in it:\n\n\`\`\`\n${rows.join('\n')}\n\`\`\`\n`],
    }
  }
  const extra = profile.size === 0 ? 'nothing else' : `${profile.size} other package(s), none host-supplied`
  return { ok: true, lines: [`- ok    ${label} — admitted; the profile gained the plugin and ${extra}`] }
}

/** Read a dsh dist-tag, or undefined when npm has none. */
function distTag(tag) {
  const value = run('npm', ['view', '@deepseek-ai/dsh', `dist-tags.${tag}`]).trim()
  return value === '' ? undefined : value
}

const report = []
let failed = false
let unable = false
const scratch = mkdtempSync(join(tmpdir(), 'dsh-release-'))
try {
  try {
    run('pnpm', ['--version'])
  } catch {
    throw new CouldNotCheck('pnpm is not on PATH; `dsh plugin` needs it')
  }

  let latest
  try {
    latest = process.env.DSH_VERSION?.trim() || distTag('latest')
  } catch (error) {
    throw new CouldNotCheck(`could not read dsh dist-tags: ${error.message}`)
  }
  report.push(`dsh ${process.env.DSH_VERSION ? 'DSH_VERSION' : '`latest` on npm'}: **${latest}**\n`)

  let tarball
  try {
    const packDir = join(scratch, 'pack')
    mkdirSync(packDir)
    tarball = join(packDir, run('npm', ['pack', '--silent', '--ignore-scripts', '--pack-destination', packDir], { cwd: ROOT }).trim().split('\n').pop())
  } catch (error) {
    throw new CouldNotCheck(`could not pack this tree: ${lastLines(error)}`)
  }

  const required = [[tarball, `this tree on dsh ${latest}`]]
  if (!TREE_ONLY) required.push([`${pkg.name}@latest`, `published ${pkg.name}@latest on dsh ${latest}`])
  for (const [spec, label] of required) {
    const result = check(scratch, latest, spec, label)
    failed = failed || !result.ok
    report.push(...result.lines)
  }

  // Ahead of the tag: advisory. It says whether the next line would admit this
  // tree before `latest` moves, so the range can be widened on evidence — and
  // widening is safe here, because a profile install never pulls a peer.
  if (!TREE_ONLY) {
    try {
      const next = distTag('next')
      if (next !== undefined && next !== latest) {
        report.push(`\nnpm also serves **${next}** on \`next\` (advisory, never fails this run):\n`)
        report.push(...check(scratch, next, tarball, `this tree on dsh ${next}`).lines)
      }
    } catch (error) {
      report.push(`- advisory check could not run: ${error.message}`)
    }
  }
} catch (error) {
  // A bug in this script is not evidence about the plugin: report it as
  // "could not check" rather than letting it read as drift.
  unable = true
  report.push(`- could not check: ${error instanceof CouldNotCheck ? error.message : error.stack}`)
} finally {
  if (KEEP) console.error(`kept scratch directory: ${scratch}`)
  else rmSync(scratch, { recursive: true, force: true })
}

console.log(report.join('\n'))
process.exitCode = unable ? 2 : failed ? 1 : 0
