import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { cardRows, requestLine, sortCards } from '../hooks/sessions'
import type { SessionCard } from '../types'

// The cases the 0.5.0 review found, each as it went wrong.

const PANE = { component: 'Pane', requestId: 'progress-panel', props: { title: 'Claudeの進捗', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as const
const T0 = new Date(2026, 9, 19, 10, 0).getTime()
const MINUTE = 60_000
const ROOT = 'C:\\ARIMA\\wt\\claude-mods-session-board'

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

type Gate = { wait: Promise<void>; open: () => void }
const gate = (): Gate => {
  let open = () => {}
  const wait = new Promise<void>(resolve => {
    open = resolve
  })

  return { wait, open }
}

type Git = (args: readonly string[]) => Promise<{ exitCode: number; stdout: string; stderr: string } | 'reject'>

// A session over a store the test can look into, with the store's writes and git's answers in its hands.
function world(on: On, entries: Record<string, unknown> = {}) {
  const clock = mock.clock(on, { now: T0 })
  const store = new Map<string, unknown>(Object.entries(entries))
  const statuses: (string | undefined)[] = []
  const w = {
    clock,
    store,
    statuses,
    id: 's1',
    cwd: ROOT,
    failNextSet: 0,
    setGate: undefined as Gate | undefined,
    git: (async args => ({ exitCode: 0, stdout: args.includes('--short') ? 'abc1234\n' : 'add-session-board\n', stderr: '' })) as Git,
  }
  on('store.get', async (_$, e) => ({ value: store.get(e.key) }) as never)
  on('store.set', async (_$, e) => {
    if (w.failNextSet > 0) {
      w.failNextSet -= 1
      throw new Error('EBUSY: the file is in use')
    }
    const held = w.setGate
    if (held) await held.wait
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))

    return { value: undefined } as never
  })
  on('store.delete', async (_$, e) => {
    store.delete(e.key)

    return { value: undefined } as never
  })
  on('store.keys', async () => ({ value: [...store.keys()] }) as never)
  on('session.id', async () => ({ value: w.id }) as never)
  on('session.surfaces', async () => ({ value: ['desktop'] }) as never)
  on('session.cwd', async () => ({ value: w.cwd }) as never)
  on('session.root', async () => ({ value: ROOT }) as never)
  on('process.run', async (_$, e) => {
    const answer = await w.git(e.argv.slice(1))
    if (answer === 'reject') throw new Error('timed out')

    return { value: { ...answer, isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
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
  on('prompt.submit', async (_$, e) => (e.text.startsWith('DROP') ? { drop: 'a hook dropped it' } : { text: e.text }) as never)
  on('tool.call', async () => ({ result: { content: [{ type: 'text', text: 'ok' }] }, text: 'ok' }) as never)

  return w
}

const start = { cwd: ROOT, surface: 'desktop', isInteractive: false } as const
const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as never
const ended = (turnId: string) => ({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId }) as const
const mine = (w: { store: Map<string, unknown>; id: string }) => w.store.get(`session:${w.id}`) as SessionCard | undefined

type Dollar = { turn: { start: (e: { text: string; turnId: string }) => Promise<unknown>; complete: (e: ReturnType<typeof ended>) => Promise<unknown> } }

async function aTurn($: Dollar, turnId: string) {
  await $.turn.start({ text: '作業', turnId })
  await $.turn.complete(ended(turnId))
}

// --- 1. Idle time ---

test('an idle session reads as idle since its turn ended, heartbeats or not', async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  await $.prompt.submit(typed('レポートを作って'))
  await aTurn($, 't1')
  await w.clock.advance(5 * MINUTE)
  const seen = mine(w)
  // The heartbeat wrote it a moment ago, but nothing happened for five minutes.
  expect(T0 + 5 * MINUTE - (seen?.updatedAt ?? 0)).toBeLessThan(MINUTE)
  expect(cardRows(seen as SessionCard, T0 + 5 * MINUTE).map(r => r.text)).toContain('  待機中・5分前')
})

test('idle sessions keep their order while their heartbeats come and go', () => {
  const now = T0 + 10 * MINUTE
  // a was busy more recently than b; b's heartbeat happens to be the latest.
  const a = card('a', { activeAt: T0 + 8 * MINUTE, updatedAt: now - 40_000 })
  const b = card('b', { activeAt: T0 + 2 * MINUTE, updatedAt: now - 5_000 })
  expect(sortCards([b, a], now).map(c => c.id)).toEqual(['a', 'b'])
  // A 0.5.0 card without activeAt is read by its write time.
  expect(cardRows(card('old', { updatedAt: now - 2 * MINUTE }), now).map(r => r.text)).toContain('  待機中・2分前')
})

// --- 2. /resume ---

test('after a /resume the session goes on sharing under its new id', async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  expect(mine(w)).toBeDefined()
  await $.session.end({ reason: 'resume', sessionId: 's1' } as never)
  expect(w.store.has('session:s1')).toBe(false)
  w.id = 's2'
  await aTurn($, 't1')
  await w.clock.advance(10_000)
  expect(mine(w)).toMatchObject({ id: 's2', request: '' })
  // And it still reads the others.
  w.store.set('session:o1', card('o1', { folder: 'other', isWorking: true, updatedAt: T0 + 10_000 }))
  await w.clock.advance(10_000)
  expect(w.statuses.some(s => s?.includes('他 作業中1'))).toBe(true)
})

// --- 3. A first write that fails ---

test('a first write that fails leaves the heartbeat and the reading running', async ($, on) => {
  const w = world(on, { 'session:o1': card('o1', { folder: 'other', isWorking: true, updatedAt: T0 }) })
  w.failNextSet = 1
  await $.session.start(start)
  expect(mine(w)).toBeUndefined()
  await w.clock.advance(MINUTE)
  expect(mine(w)).toBeDefined()
  expect(w.statuses.some(s => s?.includes('他 作業中1'))).toBe(true)
})

// --- 4. Folder and branch from the project ---

test('the folder and branch are the project\'s, wherever a hook or a shell cd stands', async ($, on) => {
  const w = world(on)
  const seenCwd: string[] = []
  w.git = async args => {
    seenCwd.push(args.join(' '))

    return { exitCode: 0, stdout: 'add-session-board\n', stderr: '' }
  }
  // A subagent's worktree, or a shell `cd plugins/progress-panel`.
  w.cwd = 'C:\\ARIMA\\wt\\agent-a1b2c3\\plugins\\progress-panel'
  await $.session.start(start)
  await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: 'a1' } as never)
  await w.clock.advance(10_000)
  expect(mine(w)).toMatchObject({ folder: 'claude-mods-session-board', branch: 'add-session-board' })
})

// --- 5. An end while a write is on its way ---

test('a write on its way when the session ends does not bring its card back', async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  const held = gate()
  w.setGate = held
  // The heartbeat's write starts, and waits on the file.
  await w.clock.advance(MINUTE)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1' } as never)
  w.setGate = undefined
  held.open()
  for (let n = 0; n < 5; n++) await w.clock.advance(1)
  expect(w.store.has('session:s1')).toBe(false)
})

test('after a /clear, the old id never shows up as another session', async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  const held = gate()
  w.setGate = held
  await w.clock.advance(MINUTE)
  await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  w.id = 's2'
  w.setGate = undefined
  held.open()
  for (let n = 0; n < 5; n++) await w.clock.advance(1)
  await w.clock.advance(10_000)
  expect(w.store.has('session:s1')).toBe(false)
  expect(w.statuses.some(s => s?.includes('他 '))).toBe(false)
})

// --- 6. The turn does not wait for git ---

test('the end of a turn does not wait for git to answer', async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  const held = gate()
  w.git = async args => {
    await held.wait

    return { exitCode: 0, stdout: args.includes('--short') ? 'abc1234\n' : 'feature-x\n', stderr: '' }
  }
  await $.turn.start({ text: '作業', turnId: 't1' })
  let isDone = false
  const done = $.turn.complete(ended('t1')).then(() => {
    isDone = true
  })
  for (let n = 0; n < 10; n++) await w.clock.advance(1)
  expect(isDone).toBe(true)
  held.open()
  await done
  await w.clock.advance(10_000)
  expect(mine(w)?.branch).toBe('feature-x')
})

// --- Branch ---

test('a branch read that fails keeps the last one, and a commit off any branch says so', async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  w.git = async () => 'reject'
  await aTurn($, 't1')
  await w.clock.advance(10_000)
  expect(mine(w)?.branch).toBe('add-session-board')

  w.git = async args => ({ exitCode: 0, stdout: args.includes('--short') ? 'abc1234\n' : 'HEAD\n', stderr: '' })
  await aTurn($, 't2')
  await w.clock.advance(10_000)
  expect(mine(w)?.branch).toBe('ブランチ外 abc1234')

  w.git = async () => ({ exitCode: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' })
  await aTurn($, 't3')
  await w.clock.advance(10_000)
  expect(mine(w)?.branch).toBe('')
})

// --- What is shared, and where it shows ---

test('a secret said in words, and one in a task title, are masked', async ($, on) => {
  expect(requestLine('パスワードは hunter2 で入って')).toBe('パスワードは *** で入って')
  expect(requestLine('APIキー: sk-abc123 を設定して')).toBe('APIキー: *** を設定して')
  // Whole characters only: an emoji at the cut stays whole.
  expect(requestLine(`${'あ'.repeat(39)}😀の続き`)).toBe(`${'あ'.repeat(39)}😀…`)

  const w = world(on)
  await $.session.start(start)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [{ content: 'token=abcdef123456 を登録する', status: 'in_progress' }], scope: 'first_task' } as never)
  await w.clock.advance(10_000)
  expect(mine(w)?.current).toBe('token=*** を登録する')
})

test('on a phone the other sessions are counted, their requests and tasks not shown', async ($, on) => {
  world(on, { 'session:o1': card('o1', { folder: 'other', request: '給与明細を整理して', current: '口座番号を確認する', updatedAt: T0 }) })
  await $.session.start(start)
  const phone = await $.ui.mount({ plugin: 'progress-panel', surface: 'mobile', ...PANE })
  expect(await phone.find({ type: 'Text', text: 'ほかのセッション（待機 1）' })).toBeDefined()
  expect(await phone.find({ type: 'Text', text: /給与明細|口座番号/ })).toBeUndefined()
  await phone.unmount()
  const desk = await $.ui.mount({ plugin: 'progress-panel', surface: 'desktop', ...PANE })
  // This machine's own screen shows them: the task in progress, which comes before the request.
  expect(await desk.find({ type: 'Text', text: '  ▶ 口座番号を確認する' })).toBeDefined()
  await desk.unmount()
})

test('another version\'s card is kept until it is old, and only then removed', async ($, on) => {
  const w = world(on, {
    'session:v6': { id: 'v6', schema: 6, state: { working: true }, updatedAt: T0 - MINUTE },
    'session:v6old': { id: 'v6old', schema: 6, updatedAt: T0 - 40 * MINUTE },
    'session:untimed': { id: 'u', note: 'no time' },
    'session:junk': 'not a card',
  })
  await $.session.start(start)
  expect(w.store.has('session:v6')).toBe(true)
  expect(w.store.has('session:untimed')).toBe(true)
  expect(w.store.has('session:v6old')).toBe(false)
  expect(w.store.has('session:junk')).toBe(false)
})

test('a dropped prompt, or one with no words, does not rename the session', async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  await $.prompt.submit(typed('週次レポートを作って'))
  await $.prompt.submit(typed('DROP これは止められる'))
  await $.prompt.submit(typed('   '))
  await w.clock.advance(10_000)
  expect(mine(w)?.request).toBe('週次レポートを作って')
})
