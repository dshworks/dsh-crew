# Security

## What this plugin touches

`dsh-crew` **starts processes on the operator's machine** and gives a
browser pane a keyboard into them. That is a larger surface than a
read-only plugin route, so the fence is stricter and worth reading.

It makes no outbound network call of its own and needs no credential.

### The routes

Two, both this plugin's own:

- `POST /dsh-crew/rpc` — JSON control (roster, spawn, attach, input,
  signal, peek, close).
- `GET /dsh-crew/attach?token=…` — one WebSocket per attached pane.

Both are fenced on:

- **The `Host` authority.** Loopback, or an authority you declared in
  `trustedHosts`. `Host` is the one header DNS rebinding cannot forge, and
  it binds every request — including the ones a browser sends without
  `Origin` or Fetch-Metadata over plain HTTP. A `trustedHosts` entry that
  is not a bare `host[:port]` **throws at load**, because
  `user@evil.example` would otherwise silently authorize `evil.example`.
- **`Sec-Fetch-Site` / `Origin`.** A present marker naming another site is
  decisive. Absent markers are not treated as failure — non-browser
  clients send none.
- **`application/json`, on the control route.** This is a control, not a
  formality: a cross-site "simple" request is exactly the one a browser
  sends with no CORS preflight, and it cannot set this media type. A
  hostile page therefore cannot reach a side-effectful operation blind.
- **A single-use attach token**, minted only by the fence-passing control
  route and redeemable for 30 seconds, on the WebSocket upgrade.

### The workspace

A pane's working directory is read from the dsh session the request names
— never from request data — exactly as the harness's own subagent
providers derive theirs. An unresolvable session is **refused**. Falling
back to the server's cwd would start a coding agent with write access to
whatever directory dsh happened to be launched from, on nothing more than
an unrecognized id.

### Bounds

`maxPanesPerSession` (6 by default) caps concurrent processes per session,
control bodies are capped at 64 KiB, pane geometry is clamped, and closing
a pane escalates SIGTERM to SIGKILL after `graceMs`. A tool call may only
touch panes belonging to its own session.

### What it does not do

It does not write the session log — raw terminal bytes are not
conversation state — and it does not persist a pane's output anywhere on
disk.

## The honest limit

The fence answers *"did this request come from the dsh UI on this
machine"*. It is not authentication, and it is not a substitute for one.

Anyone who can reach your dsh Web UI can seat a crew member and type into
it — which is the same capability they already have by driving the agent
in the center column. **If you expose dsh beyond localhost, that is the
decision that matters, not this plugin.** Use `trustedHosts` to match the
`--trusted-host` values the deployment already runs with, and put real
authentication in front of the whole harness.

## Reporting

Open a [private security advisory](https://github.com/dshworks/dsh-crew/security/advisories/new),
or a normal issue if the problem is not sensitive. Expect a reply within a
few days; this is a small volunteer-maintained plugin, not a product with
an on-call rotation.

Please do not include an API key, a session log, or a terminal capture
containing credentials in a report — a redacted description of the
behavior is enough.
