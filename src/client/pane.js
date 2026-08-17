/**
 * One crew pane: a real terminal emulator bound to a real PTY on the host.
 *
 * The emulator is xterm.js — the same engine VS Code, Zed, and every serious web
 * terminal use, and the only reason a full-screen agent CLI renders correctly in
 * a browser at all. Nothing here interprets the agent's output; the bytes go in
 * and the human's keystrokes come back out. That is what makes the pane show
 * Claude Code and Codex exactly as their authors drew them, with no adapter to
 * fall behind their next release.
 *
 * Geometry is fixed at spawn. The harness's subprocess seam allocates a PTY with
 * `rows`/`cols` and exposes no resize, so a pane cannot renegotiate its grid
 * without killing the agent. The pane therefore measures itself once, seats the
 * terminal at that size, and afterwards shrinks the rendered grid when the pane
 * it lives in gets narrower — the text gets smaller, the line wrapping never
 * moves under the agent.
 */
import { Terminal } from '@xterm/xterm'
import { attach, control } from './api.js'

/** Cell size at the terminal's base font, used to derive a spawn geometry. */
const CELL = { width: 8.4, height: 17 }

/** Never seat a terminal narrower than this, however small the pane starts. */
const MIN_COLS = 60

/** Never seat a terminal shorter than this. */
const MIN_ROWS = 16

/**
 * Terminal colours taken from the host theme, so a pane belongs to the app it
 * sits in rather than importing a second palette.
 *
 * The surface is the theme's own code-block background — the colour this app
 * already reserved for monospaced content — and the text colour is read off the
 * mounted element rather than a token, because inheritance is the one source
 * that is right in every theme including ones this plugin has never seen.
 * @param {HTMLElement} probe - the pane element, already in the themed tree.
 * @returns {object} an xterm theme object.
 */
function themeFrom(probe) {
  const styles = getComputedStyle(probe)
  const token = name => styles.getPropertyValue(name).trim()
  const foreground = styles.color || '#0f1115'
  return {
    background: token('--dsw-alias-markdown-code-block-banner') || token('--dsw-alias-bg-base') || '#ffffff',
    foreground,
    cursor: foreground,
    selectionBackground: token('--dsw-alias-interactive-bg-hover') || 'rgba(38,49,72,.14)',
  }
}

/**
 * Height of the session's sticky composer, or zero when there is none.
 *
 * A conversation view shares its scrollport with the composer seat, which sticks
 * to the bottom and floats over whatever scrolls under it. A transcript is happy
 * to scroll under it; a terminal is not, because the covered rows are the ones
 * being typed into.
 *
 * The clearance is the composer's own height, deliberately, and not the measured
 * overlap: reserving space changes where this view ends, so measuring the
 * overlap would feed its own result back in and grow on every observation. The
 * composer's height depends only on what the user has typed into it.
 * @param {HTMLElement} element - the view root.
 * @returns {number} pixels to reserve at the bottom.
 */
export function composerClearance(element) {
  for (let node = element; node !== null && node !== document.body; node = node.parentElement) {
    const sibling = node.nextElementSibling
    if (sibling !== null && getComputedStyle(sibling).position === 'sticky') {
      return Math.round(sibling.getBoundingClientRect().height)
    }
  }
  return 0
}

/**
 * Choose the terminal geometry for a pane of a given pixel size.
 * @param {DOMRect} box - the pane body's measured box.
 * @returns {{cols: number, rows: number}} the grid to spawn.
 */
export function geometryFor(box) {
  return {
    cols: Math.max(MIN_COLS, Math.floor((box.width - 16) / CELL.width) || MIN_COLS),
    rows: Math.max(MIN_ROWS, Math.floor((box.height - 12) / CELL.height) || MIN_ROWS),
  }
}

/**
 * Bind an xterm instance to a pane element and a host pane id.
 *
 * Returns a controller rather than taking React state callbacks, so the React
 * layer owns rendering and this owns the emulator — the two never re-render each
 * other.
 * @param {HTMLElement} element - the pane body to mount into.
 * @param {object} pane - the pane row from the host.
 * @param {object} handlers - `onExit` and `onError` notifications.
 * @returns {object} the pane controller.
 */
export function mountPane(element, pane, handlers) {
  const term = new Terminal({
    cols: pane.cols,
    rows: pane.rows,
    fontFamily: getComputedStyle(element).getPropertyValue('--ds-font-family-code').trim() || 'monospace',
    fontSize: 13,
    lineHeight: 1.2,
    theme: themeFrom(element),
    cursorBlink: true,
    scrollback: 5000,
    // The pane is a viewport onto someone else's terminal; a bell from a crew
    // member should not sound like the user's own shell.
    bellStyle: 'none',
    allowProposedApi: true,
  })
  term.open(element)

  let socket
  let closed = false

  /**
   * Scale the rendered grid to fill the pane without changing its dimensions.
   *
   * A CSS transform, not a reflow: the agent's PTY keeps the columns it was
   * started with, so its own line breaks stay where it put them.
   */
  const fit = () => {
    const viewport = element.querySelector('.xterm')
    // `.xterm` is the container and stretches to whatever box it is given, so
    // measuring it would always report the space already available and compute a
    // scale of 1 — the fit would silently do nothing and a terminal too wide for
    // its pane would simply be clipped. `.xterm-screen` is the rendered grid, and
    // its width is the only thing that has to be made to fit.
    const grid = element.querySelector('.xterm-screen')
    if (viewport === null || grid === null) return
    // Measure unscaled: a transformed box reports its scaled size, so reading it
    // without clearing first would compound each resize into the next.
    viewport.style.transform = 'none'
    const natural = grid.getBoundingClientRect().width
    if (natural === 0) return
    // Shrink to fit, never enlarge. A terminal's grid is a fixed number of
    // cells, and blowing it up to fill a wide pane makes soft, oversized text
    // that misrepresents how much screen the agent actually has. Leftover space
    // beside a narrow pane is what a terminal honestly looks like. The floor
    // stops a pane that is far too wide from shrinking into illegibility — it
    // clips instead, which at least stays readable.
    const scale = Math.min(1, Math.max(0.4, (element.clientWidth - 12) / natural))
    viewport.style.transformOrigin = 'top left'
    viewport.style.transform = `scale(${scale})`
  }

  /**
   * Open the byte stream, replaying whatever the pane already showed.
   * @returns {Promise<void>} resolves once the socket is opening.
   */
  const connect = async () => {
    const { token } = await control({ op: 'attach', paneId: pane.id })
    if (closed) return
    socket = attach(token)
    socket.addEventListener('message', (event) => {
      const frame = JSON.parse(event.data)
      if (frame.t === 'out') term.write(frame.d)
      else if (frame.t === 'exit') handlers.onExit?.(frame.code)
      else if (frame.t === 'closed') handlers.onExit?.(null)
    })
    socket.addEventListener('error', () => {
      if (!closed) handlers.onError?.(new Error('crew: the pane stream dropped'))
    })
  }

  term.onData((data) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: 'in', d: data }))
  })

  void connect().catch(error => handlers.onError?.(error))
  const observer = new ResizeObserver(() => fit())
  observer.observe(element)
  // The grid is observed as well as the pane. It has no width until xterm has
  // painted, which is after the frame this runs in — an initial fit alone would
  // measure zero, bail, and never be asked again, because the pane's own box
  // never changes afterwards. A transform does not alter layout size, so the
  // scale this applies cannot feed the observer back into a loop.
  const grid = element.querySelector('.xterm-screen')
  if (grid !== null) observer.observe(grid)
  requestAnimationFrame(fit)

  return {
    /** Move keyboard focus into this terminal. */
    focus: () => term.focus(),
    /** Send text as if typed, without waiting for focus. */
    send: (text) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: 'in', d: text }))
    },
    /** Interrupt the pane's foreground process group. */
    interrupt: () => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: 'sig', s: 'SIGINT' }))
    },
    /** Detach the socket and dispose the emulator. */
    dispose: () => {
      closed = true
      observer.disconnect()
      socket?.close()
      term.dispose()
    },
  }
}
