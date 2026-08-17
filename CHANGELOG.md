# Changelog

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
