import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { done, isRepeat, keyOf, minutes, ntfyRequest } from '../hooks/message'

type Sent = { url: string; topic: string; title: string; message: string; priority: number; tags: string[] }
type World = { sent: Sent[]; toasts: string[]; clock: ReturnType<typeof mock.clock>; status: number; isDown: boolean }

const TOPIC = { topic: 'arima-claude-test' }

function world(on: On): World {
  const w: World = { sent: [], toasts: [], clock: mock.clock(on, { now: 1_000_000 }), status: 200, isDown: false }
  on('http.fetch', async (_$, e) => {
    if (w.isDown) return { deny: 'network down' } as never
    const body = JSON.parse(String(e.init?.body ?? '{}')) as Omit<Sent, 'url'>
    w.sent.push({ url: e.url, ...body })

    return { value: { status: w.status, ok: w.status < 300, headers: {}, text: '{}' } } as never
  })
  on('ui.toast', async (_$, e) => {
    w.toasts.push(String(e.text))

    return { value: undefined } as never
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async () => ({ value: undefined }) as never)
  on('classic.Notification', async () => ({}))
  on('classic.StopFailure', async () => ({}))
  on('turn.complete', async () => ({ text: '' }))
  on('tool.call', async () => ({ result: { answers: {} }, text: 'ok' }) as never)

  return w
}

// Notes go out without the hook waiting for them (0.1.1): let the sends finish before looking.
async function flush(w: World) {
  for (let n = 0; n < 10; n++) await w.clock.advance(1)
}

const start = { cwd: 'C:\\ARIMA\\claude-mods', surface: 'desktop', isInteractive: true } as never
const finished = (durationMs: number, extra: Record<string, unknown> = {}) =>
  ({ reason: 'answer', answer: 'できました', durationMs, isAborted: false, turnId: 't1', ...extra }) as never

test('each moment goes to the phone under the folder name', { options: TOPIC }, async ($, on) => {
  const w = world(on)
  await $.session.start(start)

  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' } as never)
  await flush(w)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: 'どちらの案で進めますか？', header: '方針', options: [], multiSelect: false }] } as never)
  await flush(w)
  await $.turn.complete(finished(12 * 60_000))
  await flush(w)
  await $.classic.StopFailure({ error: 'overloaded' } as never)
  await flush(w)
  await $.classic.Notification({ message: '同じ理由で3回続けて未達です', title: 'ゴール一時停止', notification_type: 'plugin_notification' } as never)
  await flush(w)

  expect(w.sent.map(s => [s.title, s.message, s.priority])).toEqual([
    ['【claude-mods】入力待ち', 'Claude needs your permission to use Bash', 4],
    ['【claude-mods】質問があります', 'どちらの案で進めますか？', 4],
    ['【claude-mods】作業が終わりました', '12分かかりました', 3],
    ['【claude-mods】エラーで止まりました', 'overloaded', 4],
    ['【claude-mods】ゴール一時停止', '同じ理由で3回続けて未達です', 4],
  ])
  expect(w.sent[0]?.url).toBe('https://ntfy.sh')
  expect(w.sent[0]?.topic).toBe('arima-claude-test')
  expect(w.sent[0]?.tags).toEqual(['hourglass'])
})

test('short turns, interruptions, idle waits and subagents stay quiet', { options: TOPIC }, async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  await $.turn.complete(finished(2 * 60_000))
  await $.turn.complete(finished(10 * 60_000, { reason: 'aborted', isAborted: true }))
  await $.turn.complete(finished(10 * 60_000, { agentId: 'a1' }))
  await $.classic.Notification({ message: 'Claude is waiting for your input', notification_type: 'idle_prompt' } as never)
  await $.classic.StopFailure({ error: 'overloaded', agent_id: 'a1', agent_type: 'worker' } as never)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: 'x' }], agentId: 'a1' } as never)
  await flush(w)
  expect(w.sent).toEqual([])
})

test('the same note within a minute goes once', { options: TOPIC }, async ($, on) => {
  const w = world(on)
  const note = { message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' } as never
  await $.classic.Notification(note)
  await flush(w)
  await $.classic.Notification(note)
  await flush(w)
  expect(w.sent).toHaveLength(1)
  await w.clock.advance(61_000)
  await $.classic.Notification(note)
  await flush(w)
  expect(w.sent).toHaveLength(2)
})

test('without a topic nothing is sent and the setup is shown', async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  await $.classic.Notification({ message: 'x', notification_type: 'permission_prompt' } as never)
  await flush(w)
  expect(w.sent).toEqual([])
  expect(w.toasts[0]).toContain('/plugin configure phone-notify@claude-mods')
  const out = (await $.command.run({ command: 'phone-notify', args: '' } as never)) as { text?: string }
  expect(out.text).toContain('トピック名が未設定です')
})

test('moments can be turned off one by one, and the server changed', {
  options: { ...TOPIC, server: 'https://ntfy.example.com/', notifyDone: false, notifyMods: false, doneAfterMinutes: 1 },
}, async ($, on) => {
  const w = world(on)
  await $.turn.complete(finished(5 * 60_000))
  await $.classic.Notification({ message: 'm', title: 't', notification_type: 'plugin_notification' } as never)
  await $.classic.StopFailure({ error: 'rate_limit' } as never)
  await flush(w)
  expect(w.sent.map(s => [s.url, s.title])).toEqual([['https://ntfy.example.com', 'エラーで止まりました']])
})

test('a failed send shows once and never stops the work', { options: TOPIC }, async ($, on) => {
  const w = world(on)
  w.status = 403
  await $.classic.StopFailure({ error: 'overloaded' } as never)
  await flush(w)
  await $.classic.Notification({ message: 'x', notification_type: 'permission_prompt' } as never)
  await flush(w)
  w.isDown = true
  await $.turn.complete(finished(10 * 60_000))
  await flush(w)
  expect(w.toasts).toEqual(['スマホ通知を送れませんでした（HTTP 403）'])
})

test('/phone-notify sends a test and says whether it went', { options: TOPIC }, async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  const ok = (await $.command.run({ command: 'phone-notify', args: '' } as never)) as { text?: string }
  expect(ok.text).toContain('テスト通知を送りました')
  expect(w.sent[0]?.title).toBe('【claude-mods】テスト通知')

  w.status = 500
  const ng = (await $.command.run({ command: 'phone-notify', args: '' } as never)) as { text?: string }
  expect(ng.text).toContain('テスト通知を送れませんでした（HTTP 500）')
  // A test's failure is said in the reply, not as a toast.
  expect(w.toasts).toEqual([])
})

test('notes are short, and long times read in hours', () => {
  expect(minutes(75 * 60_000)).toBe('1時間15分')
  expect(done('', 3 * 60_000).title).toBe('作業が終わりました')
  const long = ntfyRequest('https://ntfy.sh', 't', { title: 'x', message: 'あ'.repeat(10), priority: 3, tags: [] })
  expect(JSON.parse(long.body).topic).toBe('t')
  const note = done('a', 60_000)
  expect(isRepeat({ key: keyOf(note), at: 0 }, note, 59_999)).toBe(true)
  expect(isRepeat({ key: keyOf(note), at: 0 }, note, 60_000)).toBe(false)
})
