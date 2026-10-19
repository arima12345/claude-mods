import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { fromMod, modLead } from '../hooks/message'

// The cases the 0.1.0 review found, each as it went wrong.

const TOPIC = { topic: 'arima-claude-test' }
type Sent = { title: string; message: string; priority: number }

function world(on: On) {
  const w = {
    sent: [] as Sent[],
    toasts: [] as string[],
    clock: mock.clock(on, { now: 1_000_000 }),
    hold: undefined as Promise<void> | undefined,
    reached: [] as string[],
  }
  on('http.fetch', async (_$, e) => {
    if (w.hold) await w.hold
    w.sent.push(JSON.parse(String(e.init?.body ?? '{}')) as Sent)

    return { value: { status: 200, ok: true, headers: {}, text: '{}' } } as never
  })
  on('ui.toast', async (_$, e) => {
    w.toasts.push(String(e.text))

    return { value: undefined } as never
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async () => ({ value: undefined }) as never)
  on('classic.Notification', async () => ({}))
  on('classic.StopFailure', async () => ({}))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', async () => ({ text: '' }))
  on('tool.call', async (_$, e) => {
    w.reached.push(e.tool)

    return { result: { answers: {} }, text: 'ok' } as never
  })

  return w
}

async function flush(w: { clock: ReturnType<typeof mock.clock> }) {
  for (let n = 0; n < 10; n++) await w.clock.advance(1)
}

const start = { cwd: 'C:\\ARIMA\\claude-mods', surface: 'desktop', isInteractive: false } as never
const finished = (durationMs: number) => ({ reason: 'answer', answer: 'できました', durationMs, isAborted: false, turnId: 't1' }) as never
const ask = (text: string) => ({ tool: 'AskUserQuestion', questions: [{ question: text, header: 'h', options: [], multiSelect: false }] }) as never
const wrapUp = (over: Record<string, unknown>) => ({ tool: 'mcp__ccd_turn__wrap_up', recap: '直しました', ...over }) as never

// --- 1. ntfy never holds the work ---

test('a question shows at once, however slow ntfy is', { options: TOPIC }, async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  let open = () => {}
  w.hold = new Promise<void>(r => (open = r))
  await $.tool.call(ask('どちらにしますか？'))
  // The question reached the person while ntfy had not answered.
  expect(w.reached).toEqual(['AskUserQuestion'])
  expect(w.sent).toEqual([])
  open()
  await flush(w)
  expect(w.sent.map(s => s.title)).toEqual(['【claude-mods】質問があります'])
})

test('a turn ends, and an error is told, without waiting for ntfy', { options: TOPIC }, async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  w.hold = new Promise<void>(() => {})
  let isEnded = false
  await $.turn.complete(finished(10 * 60_000)).then(() => {
    isEnded = true
  })
  expect(isEnded).toBe(true)
  await $.classic.StopFailure({ error: 'overloaded' } as never)
})

test('a send ntfy never answers is given up after ten seconds, said once', { options: TOPIC }, async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  w.hold = new Promise<void>(() => {})
  await $.classic.StopFailure({ error: 'overloaded' } as never)
  await w.clock.advance(9_000)
  expect(w.toasts).toEqual([])
  await w.clock.advance(1_500)
  expect(w.toasts).toEqual(['スマホ通知を送れませんでした（10秒で応答なし）'])
  await $.classic.StopFailure({ error: 'rate_limit' } as never)
  await w.clock.advance(11_000)
  expect(w.toasts).toHaveLength(1)
})

test('the same note raised twice at once goes once', { options: TOPIC }, async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  const note = { message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' } as never
  await Promise.all([$.classic.Notification(note), $.classic.Notification(note)])
  await flush(w)
  expect(w.sent).toHaveLength(1)
})

// --- 2. The desktop app's next-step box ---

test('a short turn that ends asking in the next-step box is told as a question', { options: TOPIC }, async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  await $.turn.start({ text: '直して', turnId: 't1' })
  await $.tool.call(wrapUp({ ask: 'PR を作りますか？', actions: [], blocked: true }))
  await $.turn.complete(finished(40_000))
  await flush(w)
  expect(w.sent.map(s => [s.title, s.message, s.priority])).toEqual([['【claude-mods】質問があります', 'PR を作りますか？', 4]])
})

test('a long turn that ends asking is told once, as the question', { options: TOPIC }, async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  await $.turn.start({ text: '直して', turnId: 't1' })
  await $.tool.call(wrapUp({ ask: 'マージしますか？' }))
  await $.turn.complete(finished(12 * 60_000))
  await flush(w)
  expect(w.sent.map(s => s.title)).toEqual(['【claude-mods】質問があります'])

  // The next turn, with no question at its end, is told as finished work again.
  await $.turn.start({ text: '続けて', turnId: 't2' })
  await $.tool.call(wrapUp({}))
  await $.turn.complete(finished(12 * 60_000))
  await flush(w)
  expect(w.sent.map(s => s.title)).toEqual(['【claude-mods】質問があります', '【claude-mods】作業が終わりました'])
})

test('a question mid-turn leaves the long turn\'s end still news', { options: TOPIC }, async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  await $.turn.start({ text: '作って', turnId: 't1' })
  await $.tool.call(ask('どちらの案にしますか？'))
  await flush(w)
  await $.turn.complete(finished(12 * 60_000))
  await flush(w)
  expect(w.sent.map(s => s.title)).toEqual(['【claude-mods】質問があります', '【claude-mods】作業が終わりました'])
})

test('a wrap-up with no question, or a subagent\'s, sends nothing', { options: TOPIC }, async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  await $.tool.call(wrapUp({}))
  await $.tool.call(wrapUp({ ask: '   ' }))
  await $.tool.call({ ...(wrapUp({ ask: 'x' }) as object), agentId: 'a1' } as never)
  await flush(w)
  expect(w.sent).toEqual([])
})

// --- 3. Other mods' notices carry their lead only ---

test('a mod\'s notice goes as its lead, not the work it names', { options: TOPIC }, async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  await $.classic.Notification({
    notification_type: 'plugin_notification',
    title: 'ゴール一時停止',
    message: 'あなたの判断が必要です: 顧客リストの CSV（田中様ほか12件）を外部に送ってよいか確認が必要。/goal2 resume で再開できます。',
  } as never)
  await flush(w)
  expect(w.sent.map(s => `${s.title} / ${s.message}`)).toEqual(['【claude-mods】ゴール一時停止 / あなたの判断が必要です（続きはパソコンで）'])
})

test('the whole text goes when the person asked for it', { options: { ...TOPIC, modDetail: true } }, async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  await $.classic.Notification({ notification_type: 'plugin_notification', title: 'ゴール達成', message: '確認役が確認しました: 日記を追加できる' } as never)
  await flush(w)
  expect(w.sent.map(s => s.message)).toEqual(['確認役が確認しました: 日記を追加できる'])
})

test('a notice with nothing after its lead goes whole', () => {
  expect(modLead('5時間枠が96%です。まもなく上限です（18:40 回復）。')).toBe('5時間枠が96%です。まもなく上限です')
  expect(fromMod('', 'ゴール一時停止', '同じ理由で5回続けて未達です').message).toBe('同じ理由で5回続けて未達です')
})

// --- Notification kinds ---

test('only waits are told as waits; a sign-in is quiet, and an unknown kind is a plain notice', { options: TOPIC }, async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  for (const [kind, message] of [
    ['elicitation_dialog', 'MCP サーバーが入力を求めています'],
    ['auth_success', 'Authentication successful'],
    ['something_new', 'A new kind of notice'],
  ] as const) {
    await $.classic.Notification({ notification_type: kind, message } as never)
    await flush(w)
  }
  expect(w.sent.map(s => [s.title, s.priority])).toEqual([
    ['【claude-mods】入力待ち', 4],
    ['【claude-mods】お知らせ', 3],
  ])
})
