# Contributing

Small repo, few rules.

## The one that bites

`dist/client.js` is **generated** and **committed** — installing this
package must not require a build step. Edit `src/client/`, then:

```sh
node scripts/build-client.mjs
```

`pnpm test` runs `--check` first and fails if you forgot, and CI runs the
same check, so a stale bundle cannot reach npm.

Two things in that build are load-bearing and easy to break:

- The module-loader **`id` must equal the package name**. That is the id
  the Node half puts in the boot graph. A different id registers a factory
  nobody resolves and the client half silently never materializes — no
  error, just a missing tab.
- The output is **IIFE, not CJS**. esbuild's CJS output tags exports with
  `__esModule`, which the Loader reads as an ES module and then looks for
  a default export that is not there. `react` stays external; two React
  copies in one document break hooks.

The same naming rule applies to `cordis.patch.yml`: its `name` is the
specifier the Loader resolves, so it carries the **scoped** package name.
An unscoped name boots fine from a linked folder and fails from npm with
`Cannot find package`. CI checks this.

## Before opening a PR

```sh
pnpm install
pnpm test
```

The suite runs against real PTYs, real sockets, and the real fence —
`node-pty` is a devDependency for exactly that reason. Keep it that way:
a test that mocks the terminal proves nothing about a plugin whose whole
job is carrying terminal bytes.

- New behavior gets a test.
- **Anything that changes what a pane writes to its child must be checked
  against the real `claude` and `codex`, not just the suite.** The suite
  seats `bash`, which is deterministic and far more forgiving than a
  full-screen coding CLI: it submits on a carriage return no matter how
  that return arrives, so it cannot see paste detection, first-paint
  delay, or a trust dialog. `crew_send` shipped its Enter in the same
  write as the message for exactly one day of green tests, and against
  both real products that submitted nothing at all. Where a wire shape is
  the fix, assert the wire shape — see the two-writes test in
  `tests/tools.spec.mjs` — and then run the products:

  ```sh
  CREW_REAL_CLI=1 pnpm test
  ```

  `tests/real-cli.spec.mjs` seats each of `claude` and `codex` in a fresh
  temporary workspace, answers whatever dialog it opens on, and makes it
  answer a two-line message foreground and background. It is opt-in because
  it needs credentials and spends model tokens; the temporary workspace is
  deliberate, so answering a product's trust prompt in a test never leaves a
  real project marked trusted.
- Security changes get a test that fails without the fix. `lib/trust.js`
  is the file where a plausible-looking simplification is most likely to
  be a hole — the `application/json` requirement and the `Host` check are
  controls, not formalities.
- UI changes need a screenshot from a real dsh session, not a mock. If the
  visible surface changes, the READMEs' images change with it.
- Adding a crew member should be a **config row**, not code. If it needs
  code, the roster abstraction is wrong and that is the thing to fix.

## When dsh releases

dsh checks every `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer range
against its own version, with prereleases included, when a plugin is
installed and again when a profile starts. A range that does not admit the
running dsh gets the plugin refused or disabled. So:

- **Port first, then widen.** Read the upstream diff for every seam this
  plugin touches, run the plugin on the new dsh, and only then OR the new
  line into the peer ranges. A plugin installs into a profile with
  `autoInstallPeers: false` and imports the host's own harness copies, so
  an OR'd range never pulls a second harness in.
- **Anything the host already ships is a peer, never a dependency.** A
  profile is a hoisted pnpm project; a copy we install there shadows the
  host's copy for every plugin in that profile. `ws`, `@xterm/headless`,
  and `@deepseek-ai/schemastery` are peers (and devDependencies, for the
  tests) for that reason.

`scripts/check-dsh-release.mjs` proves both on the path users take: it
installs the published dsh into a scratch prefix, runs `dsh plugin
--profile web add` in a scratch `DSH_HOME`, and fails if dsh refuses the
plugin or if the profile gains a package the host supplies.

```sh
node scripts/check-dsh-release.mjs --tree-only   # this tree on dsh `latest`
node scripts/check-dsh-release.mjs               # + the published package; `next` as advisory
DSH_VERSION=0.2.0-rc.1 node scripts/check-dsh-release.mjs --tree-only
```

It needs `pnpm` on PATH, downloads a full dsh per host version, and
deletes its scratch directory on exit (`--keep` leaves it for debugging).
`dsh-release-watch.yml` runs it daily and on pull requests that touch
`package.json`.

## Translations

`README.md` and `README.zh.md` are peers — a change to one that affects
meaning belongs in both. The UI dictionaries live in
`src/client/locales.js`; a new key needs both `en` and `zh` entries, and
`en` doubles as the fallback when no locale service is installed.
