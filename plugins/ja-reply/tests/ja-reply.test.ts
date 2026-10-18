import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { isMostlyEnglish, japaneseShare, REWRITE } from '../hooks/language'

const ENGLISH = `I've finished the work. The usage meter now shows the five-hour and weekly windows in the status line, the context fill is announced at forty, fifty and sixty percent, and the pane lists the subagents and the work log. All tests pass and the branch is pushed.`

const JAPANESE = `作業が終わりました。画面下の行に5時間枠と週の枠の使用率を出し、コンテキストが40%・50%・60%を超えたときに知らせるようにしました。パネルにはサブエージェントと作業ログが出ます。テストはすべて通り、ブランチも push しました。`

// Japanese prose with many English names left outside backticks.
const JAPANESE_WITH_NAMES = `progress-panel を 0.4.0 に更新し、compact-memo をインストールしました。add-compact-memo ブランチは削除し、main を pull して最新にしてあります。PR は arima12345/claude-mods の 7 番で、validate と test と tsc はすべて通りました。`

const CODE_HEAVY = `次のように直しました。地の文は日本語です。

\`\`\`ts
export function register(on: On) { on('classic.Stop', async ($, e, next) => { const below = await next(e); return below }) }
export const something = 'a long english string that would otherwise count as many many latin letters in the text'
\`\`\`

変更したのは \`plugins/ja-reply/hooks/register.ts\` と C:\\ARIMA\\wt\\claude-mods-ja-reply\\plugins\\ja-reply\\SPEC.md です。詳しくは https://github.com/arima12345/claude-mods/pull/9 を見てください。`

type World = { toasts: string[] }

function world(on: On): World {
  const w: World = { toasts: [] }
  on('classic.Stop', async () => ({}))
  on('prompt.submit', async (_$, e) => ({ text: e.text }) as never)
  on('ui.toast', async (_$, e) => {
    w.toasts.push(String(e.text))

    return { value: undefined } as never
  })

  return w
}

const stop = (text: string | undefined, extra: Record<string, unknown> = {}) => ({ stop_hook_active: false, last_assistant_message: text, ...extra }) as never
const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as never

test('a report mostly in English is sent back to be written in Japanese', async ($, on) => {
  const w = world(on)
  const out = await $.classic.Stop(stop(ENGLISH))
  expect((out as { block?: string }).block).toBe(REWRITE)
  expect(w.toasts).toEqual(['返事がほとんど英語だったので、日本語で書き直すよう頼みました'])

  // The rewrite comes back in Japanese: it may stop.
  const after = await $.classic.Stop(stop(JAPANESE, { stop_hook_active: true }))
  expect((after as { block?: string }).block).toBeUndefined()
})

test('Japanese, names, code, paths, short and empty replies pass untouched', async ($, on) => {
  const w = world(on)
  for (const text of [JAPANESE, JAPANESE_WITH_NAMES, CODE_HEAVY, 'Done.', 'All tests pass.', '', undefined]) {
    const out = await $.classic.Stop(stop(text))
    expect((out as { block?: string }).block).toBeUndefined()
  }
  expect(w.toasts).toEqual([])
})

test('one rewrite per request: a second English reply is only told about', async ($, on) => {
  const w = world(on)
  await $.classic.Stop(stop(ENGLISH))
  const again = await $.classic.Stop(stop(ENGLISH, { stop_hook_active: true }))
  expect((again as { block?: string }).block).toBeUndefined()
  expect(w.toasts.at(-1)).toBe('書き直しも英語でした。必要なら「日本語で」と頼んでください')

  // A mod's own prompt does not count as a new request.
  await $.prompt.submit({ text: 'continue', wait: false, origin: { kind: 'plugin', name: 'goal2' }, isMeta: true } as never)
  expect((await $.classic.Stop(stop(ENGLISH)) as { block?: string }).block).toBeUndefined()

  await $.prompt.submit(typed('次をお願い'))
  expect((await $.classic.Stop(stop(ENGLISH)) as { block?: string }).block).toBe(REWRITE)
})

test('subagents and a stop another hook already held are left alone', async ($, on) => {
  const w = world(on)
  const sub = await $.classic.Stop(stop(ENGLISH, { agent_id: 'a1', agent_type: 'worker' }))
  expect((sub as { block?: string }).block).toBeUndefined()
  expect(w.toasts).toEqual([])
})

test('a block from beneath is kept as it is', async ($, on) => {
  const w: World = { toasts: [] }
  on('classic.Stop', async () => ({ block: 'ゴールはまだ達成されていません' }))
  on('ui.toast', async (_$, e) => {
    w.toasts.push(String(e.text))

    return { value: undefined } as never
  })
  const out = await $.classic.Stop(stop(ENGLISH))
  expect((out as { block?: string }).block).toBe('ゴールはまだ達成されていません')
  expect(w.toasts).toEqual([])
})

test('in notify mode the reply only shows a toast', { options: { mode: 'notify' } }, async ($, on) => {
  const w = world(on)
  const out = await $.classic.Stop(stop(ENGLISH))
  expect((out as { block?: string }).block).toBeUndefined()
  expect(w.toasts).toEqual(['返事がほとんど英語でした（日本語の割合 0%）'])
})

test('the share counts prose letters only', () => {
  expect(japaneseShare(ENGLISH).share).toBe(0)
  expect(japaneseShare(JAPANESE).share).toBeGreaterThan(0.8)
  expect(japaneseShare(JAPANESE_WITH_NAMES).share).toBeGreaterThan(0.3)
  expect(isMostlyEnglish(CODE_HEAVY)).toBe(false)
  expect(japaneseShare('```\nconst x = 1\n```').letters).toBe(0)
  // English with a few Japanese words quoted is still English.
  expect(isMostlyEnglish(`${ENGLISH} The status reads 「待機中」 now.`)).toBe(true)
})
