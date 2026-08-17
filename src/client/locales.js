/**
 * Crew dictionaries.
 *
 * The empty state carries the plugin's whole explanation, so it is written as
 * product copy rather than a placeholder: a first-time reader should learn what
 * a pane is and why it is worth opening one, in two lines, without leaving the
 * tab.
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'crew'

export const en = {
  'view.crew': 'Crew',
  'crew.seat': 'seat',
  'crew.seatAgent': 'Start {agent} in a pane, in this workspace',
  'crew.refresh': 'refresh',
  'crew.interrupt': 'Interrupt (Ctrl-C)',
  'crew.dismiss': 'Dismiss this pane',
  'crew.exited': 'exited ({code})',
  'crew.emptyLead': 'No crew seated yet.',
  'crew.emptyBody': 'Seat a coding agent above and it runs in this session\'s workspace, in a real terminal you can type into. dsh can hand it work and read its screen; you can take the keyboard whenever you want to.',
  'crew.broadcastPlaceholder': 'Send to all {count} panes…',
  'crew.broadcastSend': 'Send to all',
}

export const zh = {
  'view.crew': '团队',
  'crew.seat': '入座',
  'crew.seatAgent': '在本工作区开一个 {agent} 面板',
  'crew.refresh': '刷新',
  'crew.interrupt': '中断 (Ctrl-C)',
  'crew.dismiss': '关闭该面板',
  'crew.exited': '已退出（{code}）',
  'crew.emptyLead': '还没有成员入座。',
  'crew.emptyBody': '在上方选一个编程 agent，它会在本会话的工作区里跑起来，是一个你可以直接打字的真终端。dsh 可以给它派活、读它的屏幕；键盘随时可以由你接管。',
  'crew.broadcastPlaceholder': '发给全部 {count} 个面板…',
  'crew.broadcastSend': '群发',
}

/**
 * Fill `{name}` placeholders — the fallback path when no locale service is
 * installed and the raw dictionary string arrives unformatted.
 * @param {string} template - the dictionary value.
 * @param {Record<string, string>} params - placeholder values.
 * @returns {string} the filled string.
 */
export function format(template, params = {}) {
  return template.replace(/\{(\w+)\}/g, (match, key) => params[key] ?? match)
}

/**
 * Wrap a slot-provided translator so a missing locale service still renders
 * this plugin's own English rather than a raw key.
 * @param {Function | undefined} provided - the `t` prop, when the shell supplies one.
 * @returns {Function} a translator that always returns readable text.
 */
export function translator(provided) {
  return (key, params) => {
    const value = provided?.(key, params)
    if (typeof value === 'string' && value !== key) return value
    return format(en[key] ?? key, params)
  }
}
