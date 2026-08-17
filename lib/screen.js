/**
 * A server-side mirror of what each pane is actually showing.
 *
 * Raw terminal bytes are the right thing to send a browser emulator and the
 * wrong thing to put in a model's context: a full-screen agent CLI positions its
 * cursor absolutely and repaints, so the byte stream is mostly escape sequences
 * and the same text written several times. Stripping the escapes does not fix
 * it — it produces overlapping fragments in arrival order, not the screen.
 *
 * So the host runs the same emulator the browser runs, headless, over the same
 * bytes. `read()` then returns exactly the grid a human is looking at. That is
 * what makes `crew_peek` a real observation rather than a guess, and it is the
 * only reason this plugin depends on a terminal emulator at all.
 */
// The headless build ships a CommonJS namespace with no named ESM exports, so
// the class comes off the default import rather than a named one.
import headless from '@xterm/headless'

const { Terminal } = headless

/**
 * One headless emulator following one PTY.
 */
export class ScreenMirror {
  #term
  #pending = 0

  /**
   * @param {object} geometry - the PTY's fixed `cols` and `rows`.
   */
  constructor(geometry) {
    this.#term = new Terminal({
      cols: geometry.cols,
      rows: geometry.rows,
      // Enough history that a scrolling build log stays readable through peek,
      // without holding a session's whole output in memory per pane.
      scrollback: 2000,
      allowProposedApi: true,
    })
  }

  /**
   * Feed the emulator the same bytes the browser receives.
   * @param {string} chunk - terminal output as text.
   */
  write(chunk) {
    this.#pending += 1
    this.#term.write(chunk, () => { this.#pending -= 1 })
  }

  /**
   * Settle every parse the emulator has queued.
   *
   * `write` is asynchronous by contract, so a read taken immediately after the
   * last chunk would miss it. Callers that need the current screen — every model
   * -facing read — await this first.
   * @returns {Promise<void>} resolves once no write is outstanding.
   */
  async drain() {
    // One empty write settles after every write queued before it.
    await new Promise(resolve => { this.#term.write('', resolve) })
  }

  /**
   * The rendered screen as plain text.
   * @param {number} [lines] - how many trailing lines to return; the viewport by default.
   * @returns {string} rendered lines, trailing blanks trimmed.
   */
  read(lines) {
    const buffer = this.#term.buffer.active
    const end = buffer.baseY + this.#term.rows
    const count = lines === undefined ? this.#term.rows : lines
    const start = Math.max(0, end - count)
    const out = []
    for (let y = start; y < end; y += 1) {
      out.push(buffer.getLine(y)?.translateToString(true) ?? '')
    }
    while (out.length > 0 && out.at(-1).trim() === '') out.pop()
    return out.join('\n')
  }

  /** Release the emulator's buffers. */
  dispose() {
    this.#term.dispose()
  }
}
