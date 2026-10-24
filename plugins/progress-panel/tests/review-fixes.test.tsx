import type { On, SessionMeasureInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { addSample, clockTime, contextGrowth, fiveHourPace, nextHistory, noticeFor, sameReset, valveOf } from '../hooks/usage'
import { classify, isBreak, maskCommand, outcomeOf, parseCommit } from '../hooks/worklog'

// The cases the 0.4.0 review found, each as it went wrong.

const PANE = { component: 'Pane', requestId: 'progress-panel', props: { title: 'Claudeの進捗', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const
const at = (h: number, m: number, day = 18) => new Date(2026, 9, day, h, m).getTime()
const MINUTE = 60_000

type Breakdown = { rawMaxTokens?: number; autoCompactThreshold?: number; isAutoCompactEnabled?: boolean }

function world(on: On, breakdown: Breakdown | ((window: number) => Breakdown) = { rawMaxTokens: 200_000, autoCompactThreshold: 167_000, isAutoCompactEnabled: true }) {
  const clock = mock.clock(on, { now: at(15, 0) })
  mock.store(on, {})
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  let window = 200_000
  on('ui.toast', async (_$, e) => {
    toasts.push(e.text)

    return { value: undefined } as never
  })
  on('ui.status', async (_$, e) => {
    statuses.push(e.text)

    return { value: undefined } as never
  })
  on('ui.notify', async () => ({ value: { isSent: false, reason: 'no-surface' } }) as never)
  on('session.measure', async (_$, e) => ({ changed: e.changed }))
  on('session.usage', async () => ({ value: { startedAt: 0, context: { window, breakdown: typeof breakdown === 'function' ? breakdown(window) : breakdown }, rateLimits: [] } }) as never)
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', async () => ({ text: '' }))
  on('tool.call', async (_$, e) => {
    const call = e as unknown as { tool: string; command?: string }
    if (call.command?.startsWith('git commit')) return { result: { stdout: '[main abc1234] Fix flaky jest test', stderr: '', interrupted: false }, text: 'ok' } as never
    if (call.command?.includes('broken')) return { result: undefined, isError: true, text: 'Exit code 1' } as never
    if (call.command?.includes('stopped')) return { result: '[Request interrupted by user for tool use]', isError: true, text: '[Request interrupted by user for tool use]' } as never

    return { result: { stdout: '', stderr: '', interrupted: false, oldTodos: [], newTodos: [] }, text: 'ok' } as never
  })

  return {
    clock,
    toasts,
    statuses,
    setWindow: (w: number) => {
      window = w
    },
    warnings: () => toasts.filter(t => t.startsWith('まもなく')),
    breaks: () => toasts.filter(t => t.startsWith('区切りどき')),
  }
}

const fill = (tokens: number, window = 200_000, rateLimits: SessionMeasureInput['rateLimits'] = []): SessionMeasureInput => ({
  context: { percent: Math.floor((tokens / window) * 100), tokens, window },
  rateLimits,
  changed: ['context'],
})
const done = (turnId: string) => ({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId }) as const

// --- Compaction ---

test('the last warning is measured against where automatic compaction runs, not the whole window', async ($, on) => {
  const w = world(on)
  await $.session.measure(fill(120_000))
  await $.session.measure(fill(149_000))
  expect(w.warnings()).toEqual([])
  // 90% of the 167k threshold is 150.3k: warned well before compaction, not at 180k.
  await $.session.measure(fill(151_000))
  expect(w.warnings()).toEqual(['まもなく自動で圧縮されます（基準の 90%）。区切りのよいところで /compact をおすすめします。'])
  const ui = await $.ui.mount({ plugin: 'progress-panel', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Text', text: /自動圧縮の基準 約 167k まで あと 16k/ })).toBeDefined()
  await ui.unmount()
})

test('with automatic compaction off, nothing says it will compact', async ($, on) => {
  const w = world(on, { rawMaxTokens: 200_000, isAutoCompactEnabled: false })
  for (const tokens of [120_000, 170_000, 190_000]) await $.session.measure(fill(tokens))
  expect(w.warnings()).toEqual([])
  const ui = await $.ui.mount({ plugin: 'progress-panel', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /自動圧縮の基準/ })).toBeUndefined()
  await ui.unmount()
})

test('a /model switch to a bigger window reads its compaction point again', async ($, on) => {
  const w = world(on, window => ({ rawMaxTokens: window, autoCompactThreshold: window - 33_000, isAutoCompactEnabled: true }))
  await $.session.measure(fill(160_000))
  expect(w.warnings()).toHaveLength(1)
  // Now a 1M window: 300k is far from its point, so no "150%" warning and no stale line.
  w.setWindow(1_000_000)
  await $.session.measure(fill(300_000, 1_000_000))
  await $.session.measure(fill(520_000, 1_000_000))
  expect(w.warnings()).toHaveLength(1)
  const ui = await $.ui.mount({ plugin: 'progress-panel', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /自動圧縮の基準 約 967k まで あと 447k/ })).toBeDefined()
  await ui.unmount()
})

test('the compaction point comes from the threshold, then the window, and -1 when off', () => {
  expect(valveOf({ rawMaxTokens: 200_000, autoCompactThreshold: 167_000, isAutoCompactEnabled: true })).toBe(167_000)
  expect(valveOf({ rawMaxTokens: 180_000 })).toBe(180_000)
  expect(valveOf({ rawMaxTokens: 200_000, isAutoCompactEnabled: false })).toBe(-1)
  expect(valveOf(undefined)).toBe(0)
})

// --- Breaks ---

test('a break whose fill arrives only after the turn ends is still noticed', async ($, on) => {
  const w = world(on)
  await $.session.measure(fill(96_000))
  await $.turn.start({ text: '仕上げて', turnId: 't1' })
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: '仕上げる', status: 'completed', activeForm: '仕上げている' }] } as never)
  // The turn ends at 48% as last read; its own measurement, 53%, comes after.
  await $.turn.complete(done('t1'))
  expect(w.breaks()).toEqual([])
  await $.session.measure(fill(106_000))
  expect(w.breaks()).toEqual(['区切りどきです（文脈 53%）。/handoff で引き継ぎメモを作り、新しい会話へ移るのがおすすめです。'])
  // Said once: a later reading of the same idle moment does not repeat it.
  await $.session.measure(fill(107_000))
  expect(w.breaks()).toHaveLength(1)
})

test('a measurement does not undo the spacing a break notice just set', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'a', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "One"' } as never)
  await $.session.measure(fill(110_000))
  await $.turn.complete(done('t1'))
  expect(w.breaks()).toHaveLength(1)
  // A reading after the notice, then another break two points on: still too close to say again.
  await $.session.measure(fill(112_000))
  await $.turn.start({ text: 'b', turnId: 't2' })
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "Two"' } as never)
  await $.session.measure(fill(114_000))
  await $.turn.complete(done('t2'))
  expect(w.breaks()).toHaveLength(1)
})

// --- Work log ---

test('only commands that run tests or checks count, from their start', () => {
  expect(classify('git commit -m "Fix flaky jest test"')).toBeUndefined()
  expect(classify('rg pytest src')).toBeUndefined()
  expect(classify('cat jest.config.js')).toBeUndefined()
  expect(classify('grep -r "npm test" docs')).toBeUndefined()
  expect(classify('cd app && npx vitest run')).toBe('test')
  expect(classify('npm test | tail -5')).toBe('test')
  expect(classify('uv run pytest -q')).toBe('test')
  expect(classify('CI=1 pnpm exec tsc --noEmit')).toBe('check')
  expect(classify('cargo clippy -- -D warnings')).toBe('check')
  expect(classify('npm test && git commit -m "Done"')).toBe('test')
})

test('a commit whose message says "test" is logged as a commit only', async ($, on) => {
  world(on)
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "Fix flaky jest test"' } as never)
  const out = String((await $.command.run({ command: 'worklog', args: '' } as never)).text)
  expect(out).toContain('コミット abc1234 Fix flaky jest test')
  expect(out).not.toMatch(/テスト (成功|失敗|中断)/)
})

test('secrets in URLs, headers, and after a space are masked', () => {
  expect(maskCommand('DATABASE_URL=postgres://alice:hunter2@localhost/db pytest')).toBe('DATABASE_URL=postgres://***@localhost/db pytest')
  expect(maskCommand('git clone https://alice:s3cr3tpw@github.com/a/b')).toBe('git clone https://***@github.com/a/b')
  expect(maskCommand('curl -H "Authorization: Basic dXNlcjpwYXNzd29yZA==" https://x')).toBe('curl -H "Authorization: Basic ***" https://x')
  expect(maskCommand('curl -u alice:s3cr3t https://x')).toBe('curl -u *** https://x')
  expect(maskCommand('mysql --password hunter2 db')).toBe('mysql --password *** db')
  expect(maskCommand('npm test -- --token abc123secret')).toBe('npm test -- --token ***')
  expect(maskCommand('npm test glpat-abcdefghij1234567890')).toBe('npm test ***')
  expect(maskCommand('aws s3 ls AKIAIOSFODNN7EXAMPLE')).toBe('aws s3 ls ***')
  // Plain arguments around a secret flag stay readable.
  expect(maskCommand('npm test --password-file .pw')).toBe('npm test --password-file .pw')
})

test('long test paths stay apart, so one failing and another passing is no break', () => {
  const a = maskCommand('pytest tests/integration/test_payment_gateway_flow')
  const b = maskCommand('pytest tests/integration/test_user_service_flows')
  expect(a).toBe('pytest tests/integration/test_payment_gateway_flow')
  expect(a).not.toBe(b)
  const log = [
    { kind: 'test', t: 1, command: a, outcome: 'fail' },
    { kind: 'test', t: 2, command: b, outcome: 'pass' },
  ] as const
  expect(isBreak([...log], 0, [])).toBe(false)
  // A key-like run is still masked.
  expect(maskCommand(`run ${'ab12'.repeat(10)}`)).toBe('run ***')
})

test('an interrupted run is told from a failing one, and a failure with no result is still logged', async ($, on) => {
  expect(outcomeOf({ isError: true, result: '[Request interrupted by user for tool use]', text: '[Request interrupted by user for tool use]' })).toBe('interrupted')
  expect(outcomeOf({ isError: true, result: undefined, text: 'Exit code 1\nFAIL handles interrupted uploads' })).toBe('fail')

  world(on)
  await $.tool.call({ tool: 'Bash', command: 'npm test -- broken' } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm test -- stopped' } as never)
  const out = String((await $.command.run({ command: 'worklog', args: '' } as never)).text)
  expect(out).toContain('テスト 失敗: `npm test -- broken`')
  expect(out).toContain('テスト 中断: `npm test -- stopped`')
})

test('a commit made off a branch is read too', () => {
  expect(parseCommit('[detached HEAD abc1234] Rebased fix')).toEqual({ hash: 'abc1234', subject: 'Rebased fix' })
  expect(parseCommit('[main (root-commit) abc1234] First')).toEqual({ hash: 'abc1234', subject: 'First' })
  expect(parseCommit('[feature/x 1a2b3c4d] Work')).toEqual({ hash: '1a2b3c4d', subject: 'Work' })
})

// --- Limits ---

test('the pace holds through a few seconds of drift in the reported reset', () => {
  const reset = Date.UTC(2026, 9, 18, 9, 40)
  const limitAt = (sec: number, pct: number) => ({ kind: 'five_hour', percentUsed: pct, resetsAt: new Date(reset + sec * 1000).toISOString() })
  const t0 = reset - 60 * MINUTE
  let samples = addSample([], limitAt(0, 50), t0)
  samples = addSample(samples, limitAt(1, 56), t0 + 5 * MINUTE)
  samples = addSample(samples, limitAt(0, 62), t0 + 10 * MINUTE)
  samples = addSample(samples, limitAt(1, 68), t0 + 15 * MINUTE)
  expect(samples).toHaveLength(4)
  expect(fiveHourPace(samples, limitAt(1, 68), t0 + 15 * MINUTE, false)).toBeDefined()
  expect(sameReset('x', limitAt(0, 1).resetsAt)).toBe(false)
  expect(sameReset(undefined, undefined)).toBe(true)
})

test('a reset near a ten-minute mark is still one window, announced once', async ($, on) => {
  const w = world(on)
  const five = (pct: number, iso: string) => [{ kind: 'five_hour', percentUsed: pct, resetsAt: iso }]
  await $.session.measure(fill(20_000, 200_000, five(81, '2026-10-18T09:44:59.600Z')))
  await $.session.measure(fill(20_000, 200_000, five(82, '2026-10-18T09:45:00.200Z')))
  expect(w.toasts.filter(t => t.startsWith('5時間枠'))).toHaveLength(1)
})

test('a window that names no reset is announced again once it falls well under', () => {
  const spend = (pct: number) => ({ kind: 'spend_limit', percentUsed: pct })
  const first = { ...noticeFor(undefined, spend(85)), level: 80 }
  expect(noticeFor(first, spend(83)).level).toBe(80)
  expect(noticeFor(first, spend(60)).level).toBe(0)
  // A 0.4.0 record keyed by its reset still counts as the same window.
  expect(noticeFor({ resetKey: 0, level: 80, isFastNotified: false }, spend(85)).level).toBe(80)
})

test('a reset that passes while idle is shown without waiting for an event', async ($, on) => {
  const w = world(on)
  await w.clock.set(at(18, 30))
  await $.session.measure(fill(20_000, 200_000, [{ kind: 'five_hour', percentUsed: 92, resetsAt: new Date(at(18, 40)).toISOString() }]))
  expect(w.statuses.at(-1)).toContain('⚠5時間 92%（18:40 回復）')
  await w.clock.advance(11 * MINUTE)
  expect(w.statuses.at(-1)).toContain('5時間 回復済み')
})

// --- Context ---

test('after a /compact the context reads a dash, not the old figure', async ($, on) => {
  const w = world(on)
  const five = [{ kind: 'five_hour', percentUsed: 30, resetsAt: new Date(at(18, 40)).toISOString() }]
  await $.session.measure(fill(110_000, 200_000, five))
  await $.session.measure({ context: { window: 200_000 }, rateLimits: five, changed: ['context'] })
  expect(w.statuses.at(-1)).toBe('待機中 ｜ 5時間 30%（18:40 回復）・文脈 —')
  const ui = await $.ui.mount({ plugin: 'progress-panel', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Text', text: /コンテキスト —/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /コンテキスト 55%/ })).toBeUndefined()
  await ui.unmount()
})

test('the growth per turn counts turns whose fill did not move', () => {
  // Turns 0 to 3 at 40, 40, 40, 43: only turns 0 and 3 were measured with a change.
  let history = nextHistory([], 40, 0)
  history = nextHistory(history, 43, 3)
  expect(contextGrowth(history)).toBe(1)
  // A mid-turn reading is replaced by the turn's last one.
  expect(nextHistory(nextHistory(history, 44, 4), 46, 4)).toEqual([{ turn: 0, pct: 40 }, { turn: 3, pct: 43 }, { turn: 4, pct: 46 }])
  // 0.4.0 kept bare numbers: they start over.
  expect(nextHistory([30, 33], 36, 2)).toEqual([{ turn: 2, pct: 36 }])
})

test('clock readings are HH:MM', () => {
  expect(clockTime(at(9, 5))).toBe('09:05')
  expect(clockTime(at(18, 40))).toBe('18:40')
})
