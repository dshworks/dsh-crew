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
  `tests/tools.spec.mjs`.
- Security changes get a test that fails without the fix. `lib/trust.js`
  is the file where a plausible-looking simplification is most likely to
  be a hole — the `application/json` requirement and the `Host` check are
  controls, not formalities.
- UI changes need a screenshot from a real dsh session, not a mock. If the
  visible surface changes, the READMEs' images change with it.
- Adding a crew member should be a **config row**, not code. If it needs
  code, the roster abstraction is wrong and that is the thing to fix.

## Translations

`README.md` and `README.zh.md` are peers — a change to one that affects
meaning belongs in both. The UI dictionaries live in
`src/client/locales.js`; a new key needs both `en` and `zh` entries, and
`en` doubles as the fallback when no locale service is installed.
