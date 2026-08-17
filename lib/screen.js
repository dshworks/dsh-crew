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
    for (let y = start; y < end; y += 1) out.push(this.#lineAt(buffer, y))
    while (out.length > 0 && out.at(-1).trim() === '') out.pop()
    return out.join('\n')
  }

  /**
   * A reference point to measure later output against: where the viewport sat
   * and what it held.
   *
   * A buffer row keeps its index as the screen scrolls — the row moves up and
   * out of the viewport, not out of the buffer — so the pair (top, contents)
   * identifies rows that had already been shown. Everything below that viewport
   * is output the mark never saw.
   * @returns {{top: number, lines: Array<string>}} the mark.
   */
  mark() {
    const buffer = this.#term.buffer.active
    const lines = []
    for (let y = buffer.baseY; y < buffer.baseY + this.#term.rows; y += 1) {
      lines.push(this.#lineAt(buffer, y))
    }
    return { top: buffer.baseY, lines }
  }

  /**
   * The rendered lines that are new since a mark.
   *
   * Two kinds qualify: rows below the marked viewport, which had not been drawn
   * yet, and rows inside it whose text has since been overwritten — that second
   * kind is how a short answer that never scrolled the screen is caught, and how
   * the submitted prompt itself is included where the CLI echoes it into the
   * composer line. A row that merely went blank is a cleared prompt, not output.
   *
   * Scrollback is finite, so a burst longer than the retained history shifts the
   * rows the mark named. The result then degrades to "the newest `maxLines`
   * lines", which is what a caller would have fallen back to anyway; the end of
   * the range is always the live screen.
   * @param {{top: number, lines: Array<string>}} mark - from {@link mark}.
   * @param {number} maxLines - keep at most this many trailing lines.
   * @returns {string} new lines in buffer order, outer blanks trimmed.
   */
  since(mark, maxLines) {
    const buffer = this.#term.buffer.active
    const end = buffer.baseY + this.#term.rows
    const overlapEnd = Math.min(mark.top + this.#term.rows, end)
    const out = []
    for (let y = Math.max(0, mark.top); y < overlapEnd; y += 1) {
      const line = this.#lineAt(buffer, y)
      if (line.trim() !== '' && line !== mark.lines[y - mark.top]) out.push(line)
    }
    for (let y = Math.max(0, overlapEnd); y < end; y += 1) out.push(this.#lineAt(buffer, y))
    while (out.length > 0 && out[0].trim() === '') out.shift()
    while (out.length > 0 && out.at(-1).trim() === '') out.pop()
    return out.slice(Math.max(0, out.length - maxLines)).join('\n')
  }

  /**
   * One buffer row as text, by absolute index.
   * @param {object} buffer - the active buffer.
   * @param {number} y - absolute row index.
   * @returns {string} the row, trailing whitespace trimmed.
   */
  #lineAt(buffer, y) {
    return buffer.getLine(y)?.translateToString(true) ?? ''
  }

  /** Release the emulator's buffers. */
  dispose() {
    this.#term.dispose()
  }
}
