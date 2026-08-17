/**
 * Crew styling, expressed in the host theme's own alias tokens.
 *
 * A pane sits inside dsh's UI, so it wears dsh's material: the same surfaces,
 * separators, and label ramp the conversation uses, and the same mono face the
 * rest of the app sets code in. The one colour a crew member brings is its own
 * accent, and it is spent in exactly two places — a 2px rail down the left of
 * the pane and the dot in its title bar — so four panes stay legible as four
 * agents without turning the split into a paint chart.
 *
 * xterm's stylesheet is bundled rather than fetched: the client module loader
 * has no network step, and a plugin's side effects belong in its factory.
 */
import xtermCss from '@xterm/xterm/css/xterm.css'

const CREW_CSS = `
.dshCrewRoot{display:flex;flex-direction:column;height:100%;max-height:100%;min-height:0;gap:8px;
  padding:10px 12px 12px;box-sizing:border-box;overflow:hidden}

.dshCrewBar{display:flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap}
.dshCrewBarLabel{font-size:10px;line-height:14px;letter-spacing:.09em;text-transform:uppercase;
  color:var(--dsw-alias-label-caption)}
.dshCrewSpacer{flex:1}
.dshCrewSeat{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 11px;border-radius:13px;
  border:1px solid var(--dsw-alias-border-l2);background:transparent;cursor:pointer;
  font-size:12px;line-height:1;color:var(--dsw-alias-label-secondary);
  transition:background-color 120ms ease-out,border-color 120ms ease-out,color 120ms ease-out}
.dshCrewSeat:hover:not(:disabled){border-color:var(--crew-accent);color:var(--crew-accent)}
.dshCrewSeat:disabled{opacity:.4;cursor:not-allowed}
.dshCrewGhost{height:26px;padding:0 10px;border:none;background:transparent;cursor:pointer;
  font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dshCrewGhost:hover{color:var(--dsw-alias-label-secondary)}

.dshCrewError{flex:none;padding:7px 10px;border-radius:8px;font-size:12px;line-height:17px;
  color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover)}

.dshCrewGrid{flex:1;min-height:0;display:grid;gap:10px;
  grid-template-columns:repeat(var(--crew-columns,1),minmax(0,1fr));grid-auto-rows:minmax(0,1fr)}
.dshCrewGrid[data-columns="1"]{--crew-columns:1}
.dshCrewGrid[data-columns="2"]{--crew-columns:2}

.dshCrewEmpty{grid-column:1/-1;display:flex;flex-direction:column;justify-content:center;align-items:center;
  gap:4px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:19px}
.dshCrewEmptyLead{margin:0;font-size:13px;color:var(--dsw-alias-label-secondary)}
.dshCrewEmpty p{margin:0;max-width:44ch}

.dshCrewPane{display:flex;flex-direction:column;min-height:0;min-width:0;overflow:hidden;
  border:1px solid var(--dsw-alias-border-l2);border-left:2px solid var(--crew-accent);border-radius:10px;
  background:var(--dsw-alias-markdown-code-block-banner,var(--dsw-alias-bg-base))}
.dshCrewPaneBar{display:flex;align-items:center;gap:8px;flex:none;height:28px;padding:0 8px 0 10px;
  border-bottom:1px solid var(--dsw-alias-border-l1)}
.dshCrewDot{width:6px;height:6px;border-radius:3px;background:var(--crew-accent);flex:none}
.dshCrewPaneName{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshCrewPaneMeta{flex:1;font-family:var(--ds-font-family-code);font-size:10px;
  color:var(--dsw-alias-label-caption);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshCrewPaneAction{height:20px;min-width:22px;padding:0 5px;border:none;border-radius:5px;background:transparent;
  cursor:pointer;font-family:var(--ds-font-family-code);font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dshCrewPaneAction:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshCrewPaneBody{flex:1;min-height:0;overflow:hidden;padding:6px}
.dshCrewPaneBody .xterm{height:100%;background:transparent}
.dshCrewPaneBody .xterm-viewport{background:transparent!important}

.dshCrewBroadcast{flex:none;display:flex;gap:8px;align-items:center}
.dshCrewBroadcastInput{flex:1;height:30px;padding:0 11px;border-radius:15px;
  border:1px solid var(--dsw-alias-border-l2);background:transparent;
  font-size:12px;color:var(--dsw-alias-label-primary);outline:none}
.dshCrewBroadcastInput:focus{border-color:var(--dsw-alias-state-business-primary)}
.dshCrewBroadcastSend{height:30px;padding:0 14px;border-radius:15px;border:none;cursor:pointer;
  font-size:12px;color:#fff;background:var(--dsw-alias-state-business-primary)}
.dshCrewBroadcastSend:disabled{opacity:.35;cursor:not-allowed}
`

/**
 * Inject the crew stylesheet once per document.
 *
 * Idempotent by id: the module loader materializes a factory once, but a plugin
 * reload during development runs this again.
 */
export function installStyles() {
  const id = 'dsh-crew-styles'
  if (document.getElementById(id) !== null) return
  const style = document.createElement('style')
  style.id = id
  style.textContent = `${xtermCss}\n${CREW_CSS}`
  document.head.append(style)
}
