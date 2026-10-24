import type { On, SessionMeasureInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { breakStep, valveStep } from '../hooks/usage'
import { isBreak } from '../hooks/worklog'

const PANE = { component: 'Pane', requestId: 'progress-panel', props: { title: 'Claudeの進捗', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} } } as const

const fill = (tokens: number): SessionMeasureInput => ({
  context: { percent: Math.floor((tokens / 200_000) * 100), tokens, window: 200_000 },
  rateLimits: [],
  changed: ['context'],
})

function world(on: On, valve = 180_000) {
  mock.clock(on, { now: new Date(2026, 9, 18, 22, 0).getTime() })
  const toasts: string[] = []
  on('ui.toast', async (_$, e) => {
    toasts.push(e.text)

    return { value: undefined } as never
  })
  on('ui.status', async () => ({ value: undefined }) as never)
  on('session.measure', async (_$, e) => ({ changed: e.changed }))
  on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 200_000, breakdown: { rawMaxTokens: valve } }, rateLimits: [] } }) as never)
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', async () => ({ text: '' }))
  on('tool.call', async (_$, e) => {
    const call = e as unknown as { tool: string; command?: string }
    if (call.tool === 'Bash' && call.command?.includes('git commit')) return { result: { stdout: '[main abc1234] Done', stderr: '', interrupted: false }, text: 'ok' } as never
    if (call.tool === 'Bash' && call.command?.includes('broken')) return { result: { stdout: '', stderr: '', interrupted: false }, isError: true, text: 'Exit code 1' } as never

    return { result: { stdout: '', stderr: '', interrupted: false, oldTodos: [], newTodos: [] }, text: 'ok' } as never
  })

  return { toasts, warnings: () => toasts.filter(t => t.startsWith('まもなく')), breaks: () => toasts.filter(t => t.startsWith('区切りどき')) }
}

const done = (turnId: string) => ({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId }) as const

test('the last warning comes once at 90% of where automatic compaction starts, and again after a compaction', async ($, on) => {
  const w = world(on)
  await $.session.measure(fill(150_000))
  expect(w.warnings()).toEqual([])
  await $.session.measure(fill(163_000))
  expect(w.warnings()).toEqual(['まもなく自動で圧縮されます（基準の 90%）。区切りのよいところで /compact をおすすめします。'])
  await $.session.measure(fill(170_000))
  expect(w.warnings()).toHaveLength(1)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'progress-panel', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /自動圧縮の基準 約 180k まで あと 10k/ })).toBeDefined()
    await ui.unmount()
  }

  await $.session.measure(fill(60_000))
  await $.session.measure(fill(165_000))
  expect(w.warnings()).toHaveLength(2)
})

test('below 50% the compaction window is not read and nothing warns', async ($, on) => {
  const w = world(on, 90_000)
  // 85,000 is past 90% of a 90,000 window, but at 42% the window has not been read.
  await $.session.measure(fill(85_000))
  expect(w.warnings()).toEqual([])
})

test('a break in the work past 50% is a good moment, said again only ten points on', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: '作って', turnId: 't1' })
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: '作る', status: 'completed', activeForm: '作っている' }] })
  await $.session.measure(fill(110_000))
  await $.turn.complete(done('t1'))
  expect(w.breaks()).toEqual(['区切りどきです（文脈 55%）。/handoff で引き継ぎメモを作り、新しい会話へ移るのがおすすめです。'])

  // A commit at 58% is a break, but too close to the last notice.
  await $.turn.start({ text: 'コミットして', turnId: 't2' })
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "Done"' } as never)
  await $.session.measure(fill(116_000))
  await $.turn.complete(done('t2'))
  expect(w.breaks()).toHaveLength(1)

  await $.turn.start({ text: 'もう一度', turnId: 't3' })
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "More"' } as never)
  await $.session.measure(fill(132_000))
  await $.turn.complete(done('t3'))
  expect(w.breaks().at(-1)).toBe('区切りどきです（文脈 66%）。/handoff で引き継ぎメモを作り、新しい会話へ移るのがおすすめです。')
})

test('mid-work past 50% stays quiet, and a /compact arms the notice again', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: '直して', turnId: 't1' })
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: '直す', status: 'in_progress', activeForm: '直している' }] })
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  await $.session.measure(fill(110_000))
  await $.turn.complete(done('t1'))
  expect(w.breaks()).toEqual([])

  await $.turn.start({ text: '続けて', turnId: 't2' })
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: '直す', status: 'completed', activeForm: '直している' }] })
  await $.turn.complete(done('t2'))
  expect(w.breaks()).toHaveLength(1)

  await $.session.measure(fill(40_000))
  await $.turn.start({ text: '次', turnId: 't3' })
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "x"' } as never)
  await $.session.measure(fill(104_000))
  await $.turn.complete(done('t3'))
  expect(w.breaks().at(-1)).toBe('区切りどきです（文脈 52%）。/handoff で引き継ぎメモを作り、新しい会話へ移るのがおすすめです。')
})

test('a break is a done list, a commit, or a failing check that now passes', () => {
  const since = 100
  expect(isBreak([], since, [{ status: 'completed' }])).toBe(true)
  expect(isBreak([], since, [{ status: 'completed' }, { status: 'pending' }])).toBe(false)
  expect(isBreak([{ kind: 'commit', t: 100, hash: 'a', subject: 's' }], since, [])).toBe(true)
  expect(isBreak([{ kind: 'commit', t: 50, hash: 'a', subject: 's' }], since, [])).toBe(false)
  const run = (t: number, outcome: 'pass' | 'fail') => ({ kind: 'test', t, command: 'npm test', outcome }) as const
  expect(isBreak([run(50, 'fail'), run(120, 'pass')], since, [])).toBe(true)
  expect(isBreak([run(120, 'pass')], since, [])).toBe(false)
  // Fixed in an earlier turn: passing again now is no new break.
  expect(isBreak([run(30, 'fail'), run(60, 'pass'), run(120, 'pass')], since, [])).toBe(false)
})

test('the steps hold their thresholds', () => {
  expect(valveStep(162_000, 180_000, false)).toEqual({ warn: 90, isWarned: true })
  expect(valveStep(150_000, 180_000, true)).toEqual({ isWarned: true })
  expect(valveStep(100_000, 180_000, true)).toEqual({ isWarned: false })
  expect(valveStep(170_000, 0, false)).toEqual({ isWarned: false })
  expect(breakStep(49, true, 0)).toEqual({ notify: false, notified: 0 })
  expect(breakStep(55, true, 0)).toEqual({ notify: true, notified: 55 })
  expect(breakStep(64, true, 55)).toEqual({ notify: false, notified: 55 })
  expect(breakStep(45, false, 55)).toEqual({ notify: false, notified: 0 })
})
