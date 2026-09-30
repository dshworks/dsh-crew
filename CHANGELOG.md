# Changelog

## 0.2.4 — 2026-09-30

- **No more `dsh` seat.** The built-in `dsh` row spawned bare `dsh`, which
  exits with `--profile <name> is required`. dsh has required a profile
  since before it launched, and it ships no terminal profile to seat (acp,
  web, headless, sdk), so that button has never started anything. The row
  is gone from the roster, the seat bar, the README and the hero. An
  `agents:` row with `id: dsh` still works if you have something to seat.
- Checked on dsh 0.2.0-rc.2 (npm `latest` since 2026-09-29): the published
  0.2.3 installs through dsh's gate and its Crew tab, panes and `crew_*`
  tools work unchanged.

## 0.2.3 — 2026-09-29

- **Works on dsh 0.1.7 and 0.2.0.** The harness peers are now
  `^0.1.7-alpha.1 || ^0.2.0-rc.1`. dsh 0.1.7 checks a plugin's
  `@deepseek-ai/dsh*` peer ranges itself, at install and at profile start,
  and refuses one that does not admit the running version; 0.1.7-alpha.1 is
  the first dsh that has every seam contract below.
- **Background delegation works again on dsh 0.1.7.** 0.2.2 was broken
  there in two ways. The job registry now takes the owner as a session id,
  so handing it the Agent object made every `crew_send(run_in_background:
  true)` fail with `session "[object Object]" has no live agent`. And the
  registry now reads a job's answer from `result` only, so the answer 0.2.2
  returned as `output` would have reached `job_output` as nothing, with
  status `completed`. Both follow the new contract.
- **The pane declares its terminal through the seam.** `spawnTerminal`
  requires `terminalType` since dsh 0.1.7 and writes it over `TERM`; the
  `env TERM=… <agent>` wrapper that worked around the old hardcoded `dumb`
  is gone. The SSH subprocess provider refuses a spawn without it.
- **Installs one package, not six.** `ws`, `@xterm/headless`, and
  `@deepseek-ai/schemastery` moved from `dependencies` to
  `peerDependencies`. dsh ships all three, and `dsh plugin add` used to
  hoist copies of them (plus `@deepseek-ai/cosmokit` and
  `@standard-schema/spec`) into the profile, where they shadowed the host's
  own for every plugin in it.
- **The release check measures the real install path.**
  `scripts/check-dsh-release.mjs` installs the published dsh, runs `dsh
  plugin --profile web add` in a scratch `DSH_HOME`, and fails if dsh
  refuses the plugin or the profile gains a host-supplied package. It used
  to install dsh and the plugin into one npm tree, where npm resolves peers
  itself; that reported split harness trees a real install never has, so
  the 0.1.7 alert (#5) was a false positive, and the rule it taught, never
  OR in the next dsh line, does not hold for a profile install. The check
  now deletes its scratch directory on every exit path.
- **The test doubles follow dsh 0.1.7.** The PTY double requires
  `terminalType`; the job double resolves the owner against live session
  ids, calls `run(job)`, and hands back only `result`. Each old call, put
  back, turns the suite red.

## 0.2.2 — 2026-09-17

- **Installs beside dsh 0.1.5-rc.x.** dsh moved npm `latest` to 0.1.5-rc.2
  on 2026-09-10, and npm never lets a prerelease satisfy a caret with a
  different version tuple, so the 0.2.1 ranges matched no current harness.
  Installed alone, npm kept the old `@deepseek-ai/dsh-*` copies at the root
  and pushed the host's own into a nested `node_modules`: two harnesses,
  no warning. The `dsh-subprocess` and `dsh-tools` peer ranges now OR in
  `^0.1.5-rc.1`, and nothing further — peers resolve to the highest match,
  so naming the 0.1.6 alpha line would split the tree again the other way.
- **The harness packages are now explicit devDependencies**, mirroring the
  peer ranges. As auto-installed peers they had sat in `pnpm-lock.yaml` at
  0.1.0-rc.6 since the first release, so a local `pnpm install` tested
  against a 0.1.0-rc harness. They lock at 0.1.5-rc.2 now.
- No code change was needed: every seam the crew touches — the terminal
  handle of `ctx.subprocess.spawnTerminal`, `webServer.register` /
  `registerUpgrade`, `sessions.get()`, `defineTool`, `ctx.jobs`, and the
  client's `conversation.view` slot — has the same shape in 0.1.5-rc.2.

## 0.2.1 — 2026-09-04

- **Installs beside dsh 0.1.2-rc.1.** Peer ranges OR in `^0.1.2-rc.1`; the
  0.2.0 ranges matched no published dsh once 0.1.2-rc.1 became `latest`.
- **A dsh release now turns this repo red.** `scripts/check-dsh-release.mjs`
  installs this tree and the published package beside dsh `latest` and
  asserts one version of every harness package; `dsh-release-watch.yml`
  runs it daily and opens an issue on drift.

## 0.2.0 — 2026-08-17

Background delegation, and the corrections that only the real products
reveal.

- **Background delegation on the harness's job seam.** `crew_send(…,
  run_in_background: true)` returns a job id instead of blocking the turn:
  the model keeps working, the completion notice wakes it, and
  `job_output` collects what the crew member said. `job_kill` stops the
  watch, sends SIGINT to the pane's foreground, and leaves the pane
  **seated** — a cancelled delegation is not a reason to close a terminal
  someone is watching, and whether that signal ends the crew member's turn
  is the product's own decision. Needs `ctx.jobs` plus a job controller the
  calling agent can reach, and says so plainly when either is missing;
  `enableRunInBackground: false` removes the parameter.
- **A send returns the new lines, not the whole viewport.** The screen is
  diffed against a mark taken just before typing, so the model reads the
  answer instead of finding it again inside a banner it has already seen.
  A CLI that repaints in place yields no usable delta and gets the
  viewport, which `screen` carries either way.
- **Three corrections only the real products show.** Enter is written
  separately from the message — both read one burst ending in a carriage
  return as a *paste*, so a single write fills the composer and submits
  nothing, and the quiet pane then reads as an answer. Seating waits for a
  painted screen, not merely a quiet one. And a first screen that is a
  dialog — the trust prompt an untrusted directory produces — is handed to
  the caller to answer with `crew_send` (empty message = Enter) rather than
  answered by the plugin. `bash` cannot see any of the three, so
  `tests/real-cli.spec.mjs` seats the real `claude` and `codex` behind
  `CREW_REAL_CLI=1`.

## 0.1.0 — 2026-08-16

First release, as `@dshworks/dsh-crew`.

- **Crew panes.** Each seated agent gets a real PTY running its own CLI in
  the dsh session's workspace, streamed to an xterm.js pane in a new
  **Crew** tab beside Chat and Trajectory. The human can type into any
  pane at any time. The PTY comes from the harness subprocess seam, so the
  package ships no native dependency.
- **Five agent tools** — `crew_list`, `crew_seat`, `crew_send`,
  `crew_peek`, `crew_dismiss` — so the dsh agent runs the team while the
  human watches the same terminal. `crew_send` waits for the pane to
  settle instead of forcing the model to poll. Set `tools: false` to keep
  the split view and drive the crew by hand only.
- **A roster that is data, not code.** `claude`, `codex`, and `dsh` built
  in; `agents` config rows override them by `id` or append new ones.
  Availability is resolved against PATH before any spawn, so an
  unavailable agent is a disabled button naming what is missing.
- **A headless screen mirror on the host.** The same emulator the browser
  runs, over the same bytes, so `crew_peek` returns the rendered grid
  rather than escape sequences and repaints.
- **A request fence on both routes.** `Host` authority plus
  `Sec-Fetch-Site`/`Origin`, an `application/json` requirement on the
  control route, and a single-use 30-second token for the WebSocket. A
  malformed `trustedHosts` entry fails the load, not a later request.
- **The workspace is never taken from request data.** It is read from the
  named session; an unresolvable session is refused rather than defaulted
  to the server's own cwd.
- **Panes declare their own `TERM`** (`xterm-256color` / `truecolor`).
  The harness server usually inherits `TERM=dumb` from a non-interactive
  shell, which makes a coding CLI turn off exactly the output a pane
  exists to show.
