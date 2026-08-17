/**
 * The Crew view: a split of live agent terminals beside the dsh conversation.
 *
 * It takes a seat in the conversation's view ring — the same additive slot the
 * shipped trajectory view uses — so it is a tab on the session, not a floating
 * window and not a replacement for anything. Switch to it and you are looking at
 * the same session from a different angle: the chat tab shows what dsh said, the
 * crew tab shows what the rest of the team is doing about it.
 *
 * Layout is a grid rather than draggable splitters: with a hard cap of six panes
 * the useful arrangements are few, and a grid that reflows on its own beats a set
 * of handles nobody adjusts twice. Panes divide the space evenly, one column up
 * to two members, two columns after that.
 */
import { control } from './api.js'
import { composerClearance, geometryFor, mountPane } from './pane.js'

/**
 * Build the Crew view component against the host's React.
 * @param {object} React - the shell's React instance.
 * @returns {Function} the slot component.
 */
export function createCrewView(React) {
  const { createElement: h, useCallback, useEffect, useRef, useState } = React

  /**
   * One pane: its chrome and the terminal element the emulator mounts into.
   * @param {object} props - the pane row, callbacks, and translator.
   * @returns {object} the rendered pane.
   */
  function CrewPane({ pane, onClose, onError, t }) {
    const body = useRef(null)
    const controller = useRef(null)
    const [exit, setExit] = useState(pane.status === 'exited' ? pane.exitCode ?? null : undefined)

    useEffect(() => {
      if (body.current === null) return undefined
      const handle = mountPane(body.current, pane, {
        onExit: code => setExit(code),
        onError,
      })
      controller.current = handle
      return () => {
        handle.dispose()
        controller.current = null
      }
      // Bound to the pane id: a new pane is a new terminal, and nothing else
      // about the row can change the emulator it is attached to.
    }, [pane.id])

    return h('div', { className: 'dshCrewPane', style: { '--crew-accent': pane.accent } },
      h('div', { className: 'dshCrewPaneBar' },
        h('span', { className: 'dshCrewDot' }),
        h('span', { className: 'dshCrewPaneName' }, pane.label),
        h('span', { className: 'dshCrewPaneMeta' },
          exit === undefined ? `pid ${pane.pid} · ${pane.cols}×${pane.rows}` : t('crew.exited', { code: String(exit ?? '—') })),
        h('button', {
          className: 'dshCrewPaneAction',
          onClick: () => controller.current?.interrupt(),
          title: t('crew.interrupt'),
          type: 'button',
        }, '^C'),
        h('button', {
          className: 'dshCrewPaneAction',
          onClick: () => onClose(pane.id),
          title: t('crew.dismiss'),
          type: 'button',
        }, '×'),
      ),
      h('div', {
        className: 'dshCrewPaneBody',
        ref: body,
        onMouseDown: () => controller.current?.focus(),
      }),
    )
  }

  /**
   * The view: launch bar, pane grid, and the broadcast line.
   * @param {object} props - framework session props plus this plugin's inject face.
   * @returns {object} the rendered view.
   */
  return function CrewView(props) {
    const { sessionId, t } = props
    const [roster, setRoster] = useState([])
    const [panes, setPanes] = useState([])
    const [error, setError] = useState(null)
    const [busy, setBusy] = useState(null)
    const [broadcast, setBroadcast] = useState('')
    const grid = useRef(null)
    const root = useRef(null)

    // Keep the view clear of the session's sticky composer. A transcript is
    // happy to scroll under it; a terminal's bottom rows are the ones being
    // typed into, so they have to stay visible.
    useEffect(() => {
      const element = root.current
      if (element === null) return undefined
      const reserve = () => { element.style.paddingBottom = `${composerClearance(element) + 12}px` }
      reserve()
      const observer = new ResizeObserver(reserve)
      observer.observe(element)
      observer.observe(document.body)
      return () => observer.disconnect()
    }, [])

    const refresh = useCallback(async () => {
      try {
        const [rosterResult, listResult] = await Promise.all([
          control({ op: 'roster' }),
          control({ op: 'list', sessionId }),
        ])
        setRoster(rosterResult.agents)
        setPanes(listResult.panes)
      } catch (cause) {
        setError(cause.message)
      }
    }, [sessionId])

    useEffect(() => { void refresh() }, [refresh])

    const seat = useCallback(async (agentId) => {
      setBusy(agentId)
      setError(null)
      try {
        // Geometry is final: the PTY cannot be resized afterwards, so a pane is
        // seated at the width it will live at once it has company — two columns,
        // even when it is the first one in. Measuring the empty grid instead
        // would seat a full-width terminal that the next seat halves, and a
        // terminal too wide for its column can only be scaled down until it is
        // unreadable. A pane that ends up alone scales UP to fill, which costs
        // nothing; one that ends up too wide is clipped, which costs the view.
        const box = grid.current?.getBoundingClientRect() ?? { width: 900, height: 560 }
        const columns = 2
        const rows = Math.ceil((panes.length + 1) / columns)
        const { cols, rows: termRows } = geometryFor({
          width: box.width / columns,
          height: box.height / rows,
        })
        const result = await control({ op: 'spawn', sessionId, agentId, cols, rows: termRows })
        setPanes(current => [...current, result.pane])
      } catch (cause) {
        setError(cause.message)
      } finally {
        setBusy(null)
      }
    }, [sessionId, panes.length])

    const close = useCallback(async (paneId) => {
      try {
        await control({ op: 'close', paneId })
        setPanes(current => current.filter(pane => pane.id !== paneId))
      } catch (cause) {
        setError(cause.message)
      }
    }, [])

    const sendToAll = useCallback(async () => {
      const message = broadcast.trim()
      if (message === '') return
      setBroadcast('')
      // Sent through the host rather than each socket: one round trip per pane
      // either way, and the host is the only place that knows a pane exited
      // between render and click.
      //
      // Typed first, then Enter on its own. A coding CLI reads one burst ending
      // in a return as a paste and keeps the return as a newline, so sending
      // both together fills every composer and submits none of them.
      const targets = panes.filter(pane => pane.status === 'running')
      const type = data => Promise.all(targets.map(pane =>
        control({ op: 'input', paneId: pane.id, data }).catch(() => {})))
      await type(message)
      await new Promise(resolve => setTimeout(resolve, 250))
      await type('\r')
    }, [broadcast, panes])

    const live = panes.filter(pane => pane.status === 'running')

    return h('div', { className: 'dshCrewRoot', ref: root },
      h('div', { className: 'dshCrewBar' },
        h('span', { className: 'dshCrewBarLabel' }, t('crew.seat')),
        ...roster.map(agent => h('button', {
          key: agent.id,
          type: 'button',
          className: 'dshCrewSeat',
          style: { '--crew-accent': agent.accent },
          disabled: !agent.available || busy !== null,
          title: agent.available ? t('crew.seatAgent', { agent: agent.label }) : agent.reason,
          onClick: () => void seat(agent.id),
        }, busy === agent.id ? '…' : `+ ${agent.label}`)),
        h('span', { className: 'dshCrewSpacer' }),
        panes.length === 0 ? null : h('button', {
          type: 'button',
          className: 'dshCrewGhost',
          onClick: () => void refresh(),
        }, t('crew.refresh')),
      ),

      error === null ? null : h('div', { className: 'dshCrewError' }, error),

      h('div', {
        className: 'dshCrewGrid',
        ref: grid,
        'data-columns': panes.length <= 1 ? 1 : 2,
      },
        panes.length === 0
          ? h('div', { className: 'dshCrewEmpty' },
            h('p', { className: 'dshCrewEmptyLead' }, t('crew.emptyLead')),
            h('p', null, t('crew.emptyBody')),
          )
          : panes.map(pane => h(CrewPane, { key: pane.id, pane, onClose: close, onError: cause => setError(cause.message), t })),
      ),

      live.length < 2 ? null : h('form', {
        className: 'dshCrewBroadcast',
        onSubmit: (event) => {
          event.preventDefault()
          void sendToAll()
        },
      },
        h('input', {
          className: 'dshCrewBroadcastInput',
          value: broadcast,
          placeholder: t('crew.broadcastPlaceholder', { count: String(live.length) }),
          onChange: event => setBroadcast(event.target.value),
        }),
        h('button', { type: 'submit', className: 'dshCrewBroadcastSend', disabled: broadcast.trim() === '' },
          t('crew.broadcastSend')),
      ),
    )
  }
}
