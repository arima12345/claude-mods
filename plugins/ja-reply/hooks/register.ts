import type { Register } from 'claude-code'

import { isMostlyEnglish, japaneseShare, REWRITE } from './language'

const ASKED = { plugin: 'ja-reply', key: 'isAsked' } as const
// Where the person's own prompts come from; a mod's or a reminder's are not theirs.
const USER_ORIGINS = ['composer', 'bridge', 'sdk']

export const register: Register = (on, options) => {
  const isRewrite = String(options.mode ?? 'rewrite') !== 'notify'

  // A new request from the person allows one rewrite again.
  on('prompt.submit', async ($, e, next) => {
    if (USER_ORIGINS.includes(e.origin.kind) && e.command === undefined && e.isMeta !== true) {
      await $.state.set(ASKED, false).catch(() => {})
    }

    return next(e)
  })

  // When the main Claude is about to stop: a report in English is written again in Japanese.
  // Other hooks speak first; one that keeps Claude working means this is not the last word yet.
  on('classic.Stop', async ($, e, next) => {
    const below = await next(e)
    if (e.agent_id !== undefined || below.block !== undefined) return below
    const text = e.last_assistant_message ?? ''
    if (!isMostlyEnglish(text)) return below

    if (!isRewrite) {
      $.ui.toast(`返事がほとんど英語でした（日本語の割合 ${Math.round(japaneseShare(text).share * 100)}%）`)

      return below
    }
    const { value: isAsked = false } = await $.state.get(ASKED)
    if (isAsked) {
      $.ui.toast('書き直しも英語でした。必要なら「日本語で」と頼んでください')

      return below
    }
    await $.state.set(ASKED, true)
    $.ui.toast('返事がほとんど英語だったので、日本語で書き直すよう頼みました')

    return { ...below, block: REWRITE }
  })
}
