import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { cardRows, othersSection, othersStatus, requestLine, sortCards } from '../hooks/sessions'
import type { SessionCard } from '../types'

const PANE = { component: 'Pane', requestId: 'progress-panel', props: { title: 'Claudeの進捗', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as const
const T0 = new Date(2026, 9, 19, 10, 0).getTime()
const MINUTE = 60_000

const card = (id: string, over: Partial<SessionCard> = {}): SessionCard => ({
  id,
  folder: id,
  branch: 'main',
  request: '',
  isWorking: false,
  action: '',
  done: 0,
  total: 0,
  current: '',
  updatedAt: T0,
  ...over,
})

type World = { store: Map<string, unknown>; writes: string[]; statuses: (string | undefined)[]; setId: (id: string) => void; setSurfaces: (s: string[]) => void }

// A session with its own id, folder and branch, over a store the test can look into.
function world(on: On, entries: Record<string, unknown> = {}): World & { clock: ReturnType<typeof mock.clock> } {
  const clock = mock.clock(on, { now: T0 })
  const store = new Map<string, unknown>(Object.entries(entries))
  const writes: string[] = []
  const statuses: (string | undefined)[] = []
  let id = 's1'
  let surfaces: string[] = []
  on('store.get', async (_$, e) => ({ value: store.get(e.key) }) as never)
  on('store.set', async (_$, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    writes.push(e.key)

    return { value: undefined } as never
  })
  on('store.delete', async (_$, e) => {
    store.delete(e.key)

    return { value: undefined } as never
  })
  on('store.keys', async () => ({ value: [...store.keys()] }) as never)
  on('session.id', async () => ({ value: id }) as never)
  on('session.surfaces', async () => ({ value: surfaces }) as never)
  on('session.cwd', async () => ({ value: 'C:\\ARIMA\\wt\\claude-mods-session-board' }) as never)
  on('process.run', async () => ({ value: { exitCode: 0, stdout: 'add-session-board\n', stderr: '' } }) as never)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }) as never)
  on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.status', async (_$, e) => {
    statuses.push(e.text)

    return { value: undefined } as never
  })
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', async () => ({ text: '' }))
  on('prompt.submit', async (_$, e) => ({ text: e.text }) as never)
  on('tool.call', async () => ({ result: { content: [{ type: 'text', text: 'ok' }] }, text: 'ok' }) as never)

  return { clock, store, writes, statuses, setId: next => (id = next), setSurfaces: next => (surfaces = next) }
}

const start = { cwd: 'C:\\ARIMA\\wt\\claude-mods-session-board', surface: 'desktop', isInteractive: true } as const
const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as never
const plan = (items: { content: string; status: string }[]) => ({ tool: 'mcp__ccd_turn__update_plan', items, scope: 'first_task' }) as never

test('a session shares its state, a run of changes at most every five seconds', async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  // activeAt (0.5.1): it has not worked yet, so it counts from when sharing began.
  expect(w.store.get('session:s1')).toEqual(card('s1', { folder: 'claude-mods-session-board', branch: 'add-session-board', activeAt: T0 }))

  await $.prompt.submit(typed('並行セッションの一覧を作って\n細かい条件は次のとおり'))
  await $.turn.start({ text: '並行セッションの一覧を作って', turnId: 't1' })
  await $.tool.call(plan([{ content: '仕様を書く', status: 'in_progress' }, { content: '実装する', status: 'pending' }]))
  await $.tool.call({ tool: 'Read', file_path: 'SPEC.md' } as never)
  // Still within the gap: nothing new is written yet.
  expect(w.writes).toEqual(['session:s1'])

  await w.clock.advance(5_000)
  expect(w.writes).toEqual(['session:s1', 'session:s1'])
  expect(w.store.get('session:s1')).toMatchObject({
    request: '並行セッションの一覧を作って',
    isWorking: true,
    action: 'ファイルを読んでいる',
    done: 0,
    total: 2,
    current: '仕様を書く',
    updatedAt: T0 + 5_000,
  })

  // Once the gap has passed, the next change is written at once.
  await w.clock.advance(5_000)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true } as never)
  expect(w.store.get('session:s1')).toMatchObject({ done: 1, current: '実装する' })
})

test('the card is written again every minute while nothing changes', async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  await w.clock.advance(MINUTE)
  expect(w.store.get('session:s1')).toMatchObject({ updatedAt: T0 + MINUTE, isWorking: false })
  await w.clock.advance(MINUTE)
  expect(w.store.get('session:s1')).toMatchObject({ updatedAt: T0 + 2 * MINUTE })
})

test('a desktop app session, driven through the SDK, shares once the app draws it', async ($, on) => {
  const w = world(on)
  await $.session.start({ ...start, surface: null, isInteractive: false })
  expect(w.writes).toEqual([])
  w.setSurfaces(['desktop'])
  await $.turn.start({ text: 'x', turnId: 't1' })
  expect(w.store.get('session:s1')).toMatchObject({ isWorking: true, branch: 'add-session-board' })
})

test('a session nobody sits at shares nothing', async ($, on) => {
  const w = world(on)
  await $.session.start({ ...start, surface: null, isInteractive: false })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await w.clock.advance(MINUTE)
  expect(w.writes).toEqual([])
})

test('the card goes when the session ends, and after /clear the new id is written', async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  await $.prompt.submit(typed('前の依頼'))
  await w.clock.advance(5_000)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as never)
  expect(w.store.has('session:s1')).toBe(false)

  w.setId('s2')
  await w.clock.advance(MINUTE)
  expect(w.store.get('session:s2')).toMatchObject({ id: 's2', request: '' })

  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's2', resume: {} } as never)
  expect(w.store.has('session:s2')).toBe(false)
  // Ended for good: no more heartbeats.
  await w.clock.advance(MINUTE)
  expect(w.store.has('session:s2')).toBe(false)
})

test('other sessions show in the pane and the status line, itself left out', async ($, on) => {
  const w = world(on, {
    limitNotices: {},
    'session:s1': card('s1', { folder: 'mine' }),
    'session:o1': card('o1', { folder: 'claude-mods-x', branch: 'add-x', isWorking: true, action: 'コマンドを実行中', done: 2, total: 5, current: 'テストを書く', context: 45, updatedAt: T0 - 5_000 }),
    'session:o2': card('o2', { folder: 'second-brain', request: '週次レポートを作って', updatedAt: T0 - 2 * MINUTE - 30_000 }),
    'session:o3': card('o3', { folder: 'old-one', updatedAt: T0 - 12 * MINUTE }),
    'session:o4': card('o4', { folder: 'gone', updatedAt: T0 - 31 * MINUTE }),
    'session:junk': 'not a card',
  })
  await $.session.start(start)
  // Left too long, or not a card: removed by whoever reads it.
  expect(w.store.has('session:o4')).toBe(false)
  expect(w.store.has('session:junk')).toBe(false)
  expect(w.store.has('limitNotices')).toBe(true)
  expect(w.statuses.some(s => s?.endsWith('｜ 他 作業中1 待機1'))).toBe(true)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'progress-panel', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: 'ほかのセッション（作業中 1・待機 1）' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '● claude-mods-x（add-x）' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  作業中 2/5・コマンドを実行中・文脈 45%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  ▶ テストを書く' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '○ second-brain（main）' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  待機中・2分前' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  依頼：週次レポートを作って' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '? old-one（main） 応答なし・12分前' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /mine/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('a session that starts later shows at the next read, and none means no section', async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  let ui = await $.ui.mount({ plugin: 'progress-panel', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /ほかのセッション/ })).toBeUndefined()
  await ui.unmount()

  w.store.set('session:o1', card('o1', { folder: 'later', isWorking: true, action: '考え中', updatedAt: T0 + 3_000 }))
  await w.clock.advance(10_000)
  ui = await $.ui.mount({ plugin: 'progress-panel', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: '● later（main）' })).toBeDefined()
  await ui.unmount()
  expect(w.statuses.at(-1)).toBe('待機中 ｜ 他 作業中1')
})

test('working sessions come first, then waiting, then not answering; six at most', () => {
  const now = T0
  const cards = [
    card('a', { updatedAt: now - 10 * MINUTE }),
    card('b', { updatedAt: now - MINUTE }),
    card('c', { isWorking: true, updatedAt: now - 2 * MINUTE }),
    card('d', { updatedAt: now - 30_000 }),
    card('e', { isWorking: true, updatedAt: now - 10_000 }),
  ]
  expect(sortCards(cards, now).map(c => c.id)).toEqual(['e', 'c', 'd', 'b', 'a'])
  expect(othersStatus(cards, now)).toBe('他 作業中2 待機2')
  expect(othersStatus([card('x', { updatedAt: now - 5 * MINUTE })], now)).toBe('')

  const many = Array.from({ length: 8 }, (_, i) => card(`m${i}`, { updatedAt: now - i * 1000 }))
  const section = othersSection(many, now)
  expect(section.hidden).toBe(2)
  expect(section.rows.filter(r => r.text.startsWith('○')).length).toBe(6)
})

test('a session outside git shows its folder alone, and a long request is masked and cut', () => {
  expect(cardRows(card('x', { folder: 'notes', branch: '' }), T0)[0]?.text).toBe('○ notes')
  expect(requestLine('\n\ntoken=abc123 を使って API を叩いて')).toBe('token=*** を使って API を叩いて')
  expect(requestLine('あ'.repeat(50))).toBe(`${'あ'.repeat(40)}…`)
})
