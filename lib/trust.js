/**
 * Request fence for the two routes this plugin mounts.
 *
 * These routes start processes on the operator's machine, so they are held to a
 * stricter standard than a read-only plugin route. The threats a local HTTP API
 * actually faces from a browser are DNS rebinding (a page on the attacker's
 * domain resolves it to 127.0.0.1, so the socket reaches this server while the
 * Host header names the attacker) and ordinary cross-site requests. Neither is
 * an authentication problem and neither is solved by one: the fence answers
 * "did this request come from the dsh UI on this machine", and network
 * reachability remains the webserver's bind policy.
 *
 * The checks mirror `@deepseek-ai/dsh-client-connection`'s own `/api` fence
 * rather than importing it, because that module is published as TypeScript
 * source and this package ships plain JavaScript.
 */

/** Hostnames that mean "this machine" for a fence decision. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * Read one header from a Node request in a case-insensitive, single-value way.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {string} name - lowercase header name.
 * @returns {string | undefined} the value when exactly one string is present.
 */
function header(req, name) {
  const value = req.headers[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * Normalize an authority to `host` or `host:port` with a lowercased hostname and
 * default ports stripped, or undefined when it does not parse.
 * @param {string | undefined} authority - a Host or Origin authority.
 * @returns {string | undefined} the canonical form.
 */
function canonical(authority) {
  if (authority === undefined || authority === '') return undefined
  try {
    // http: is a WHATWG special scheme: parsing yields a hostname or throws.
    const url = new URL(`http://${authority}`)
    return url.port === '' ? url.hostname : `${url.hostname}:${url.port}`
  } catch {
    return undefined
  }
}

/**
 * Assert one configured `trustedHosts` entry is a bare authority in canonical
 * form. A value the URL parser would silently rewrite is a typo that must fail
 * the load rather than quietly authorize something else — `user@evil.example`
 * would otherwise grant `evil.example`, and a dangling port would broaden an
 * intended exact-port grant to every port.
 * @param {string} entry - the configured value, verbatim.
 */
export function assertTrustedAuthority(entry) {
  if (canonical(entry) !== entry.toLowerCase()) {
    throw new Error(`dsh-crew: trustedHosts entry ${JSON.stringify(entry)} is not a bare host[:port] authority`)
  }
}

/**
 * Whether a request's own Host authority is one this deployment answers for.
 *
 * The Host header binds every request, browser-looking or not: over plain HTTP a
 * browser attaches neither Origin nor Fetch-Metadata to some reads, so an
 * unmarked request may still be a rebound browser read, and Host is the one
 * header rebinding cannot forge.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {ReadonlyArray<string>} trustedHosts - extra authorities from config.
 * @returns {boolean} true when the authority is loopback or declared.
 */
function hostIsOurs(req, trustedHosts) {
  const host = canonical(header(req, 'host'))
  if (host === undefined) return false
  const hostname = host.replace(/:\d+$/, '')
  if (LOOPBACK.has(hostname)) return true
  return trustedHosts.some(entry => entry.toLowerCase() === host || entry.toLowerCase() === hostname)
}

/**
 * Whether a request that a browser marked as cross-site should be refused.
 *
 * Absent markers are not a failure — non-browser clients send none — but a
 * present marker naming another site is decisive.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {boolean} true when the request is same-origin or unmarked.
 */
function siteIsOurs(req) {
  const site = header(req, 'sec-fetch-site')
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false
  const origin = header(req, 'origin')
  if (origin === undefined || origin === 'null') return true
  try {
    return canonical(new URL(origin).host) === canonical(header(req, 'host'))
  } catch {
    return false
  }
}

/**
 * The fence for the JSON control route.
 *
 * The media-type requirement is load-bearing, not decoration: a cross-site
 * "simple" request is exactly the one a browser sends without a CORS preflight,
 * and it cannot set `application/json`. Refusing anything else means a malicious
 * page cannot reach a side-effectful operation blind.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {ReadonlyArray<string>} trustedHosts - extra authorities from config.
 * @returns {{ok: true} | {ok: false, status: number, message: string}} the verdict.
 */
export function checkControlRequest(req, trustedHosts) {
  if (!hostIsOurs(req, trustedHosts) || !siteIsOurs(req)) {
    return { ok: false, status: 403, message: 'forbidden' }
  }
  const type = header(req, 'content-type') ?? ''
  if (!type.split(';')[0].trim().toLowerCase().startsWith('application/json')) {
    return { ok: false, status: 415, message: 'application/json required' }
  }
  return { ok: true }
}

/**
 * The fence for the WebSocket upgrade.
 *
 * A handshake carries no body and no content type, so the media-type guard has
 * no counterpart here; the single-use attach token minted by the control route
 * is what proves a fence-passing caller asked for this stream. Browsers do send
 * Origin on WebSocket handshakes, so that check is reliable on this route.
 * @param {import('node:http').IncomingMessage} req - the upgrade request.
 * @param {ReadonlyArray<string>} trustedHosts - extra authorities from config.
 * @returns {boolean} true when the handshake may proceed to token redemption.
 */
export function checkUpgradeRequest(req, trustedHosts) {
  return hostIsOurs(req, trustedHosts) && siteIsOurs(req)
}
