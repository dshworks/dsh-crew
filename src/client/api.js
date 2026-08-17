/**
 * Browser client for the crew control route.
 *
 * One POST shape for every operation, because the operations are few and the
 * alternative — a path per verb — buys nothing and spreads the request fence
 * over several handlers. Failures arrive as the host's own message and are
 * surfaced verbatim: "claude is not on the host PATH" is a better error than
 * anything this layer could invent from a status code.
 */

/** The host route; same origin as the app, so no base URL is needed. */
const CONTROL_PATH = '/dsh-crew/rpc'

/** Where a pane's byte stream is upgraded. */
const ATTACH_PATH = '/dsh-crew/attach'

/**
 * Call one control operation.
 * @param {object} body - the operation and its arguments.
 * @returns {Promise<object>} the response value.
 */
export async function control(body) {
  const response = await fetch(CONTROL_PATH, {
    method: 'POST',
    // The host requires this media type: it is what a cross-site "simple"
    // request cannot set, and therefore what keeps a hostile page off a route
    // that starts processes.
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(text || `crew: request failed (${response.status})`)
  }
  if (!response.ok) throw new Error(value?.error ?? `crew: request failed (${response.status})`)
  return value
}

/**
 * Open the byte stream for one pane.
 *
 * The token is minted by the control route and redeemable once, so the socket
 * URL cannot be replayed or shared; a reconnect asks for a fresh one.
 * @param {string} token - the single-use attach token.
 * @returns {WebSocket} the open-in-progress socket.
 */
export function attach(token) {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return new WebSocket(`${scheme}://${window.location.host}${ATTACH_PATH}?token=${encodeURIComponent(token)}`)
}
