/**
 * dsh-crew — browser half.
 *
 * One registration: a Crew entry in the conversation's view ring, beside the
 * shipped Chat and Trajectory tabs. That ring is the harness's additive seat for
 * a whole view of a session, which is exactly what this is — the same session
 * seen from the team's side instead of the transcript's.
 *
 * The view takes no occupied seat and replaces nothing: a deployment that drops
 * this plugin loses a tab and nothing else.
 *
 * React arrives through the module loader's `require`, never from this bundle.
 * Two React copies in one document break hooks, so the build marks it external
 * and the shell supplies its own instance at materialization.
 */
import React from 'react'
import { createCrewView } from './crew-view.js'
import { en, NS, translator, zh } from './locales.js'
import { installStyles } from './styles.js'

/** Services this surface needs; the locale service is read optionally. */
export const inject = ['slots']

/**
 * Client plugin body: seat the Crew view tab.
 * @param {object} ctx - client root context.
 */
export function apply(ctx) {
  installStyles()
  const locale = ctx.get('locale')
  if (locale !== undefined) ctx.effect(() => locale.register(NS, { zh, en }), 'dsh-crew: dictionaries')

  // The tab label reads through the bound translator as a thunk, so it follows
  // a language change without re-registering the entry.
  const bound = translator(locale?.bind?.(NS))
  const CrewView = createCrewView(React)

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'crew',
    // After the shipped chat and trajectory tabs: the crew is a place you go on
    // purpose, not the view a session should open in.
    order: 20,
    locale: NS,
    label: () => bound('view.crew'),
  }, props => React.createElement(CrewView, { ...props, t: translator(props.t) })))
}
