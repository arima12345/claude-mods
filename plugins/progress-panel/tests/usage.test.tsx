import type { On, SessionMeasureInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { contextStep, fiveHourPace, weeklyPace, windowKey } from '../hooks/usage'

const PANE = { component: 'Pane', requestId: 'progress-panel', props: { title: 'Claudeの進捗', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} } } as const

// Times are built in local time, so the expected clock readings hold in any time zone.
const at = (h: number, m: number, day = 18) => new Date(2026, 9, day, h, m).getTime()
const iso = (ms: number) => new Date(ms).toISOString()
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

const FIVE_RESET = iso(at(18, 40))
const WEEK_RESET = iso(at(12, 0, 22))

type Reading = { five?: number; week?: number; ctx?: number; fiveReset?: string; weekReset?: string }

function measured(r: Reading): SessionMeasureInput {
  const rateLimits = [
    ...(r.five === undefined ? [] : [{ kind: 'five_hour', percentUsed: r.five, resetsAt: r.fiveReset ?? FIVE_RESET }]),
    ...(r.week === undefined ? [] : [{ kind: 'seven_day', percentUsed: r.week, resetsAt: r.weekReset ?? WEEK_RESET }]),
  ]

  return {
    context: { percent: r.ctx, tokens: r.ctx === undefined ? undefined : r.ctx * 2000, window: 200_000 },
    rateLimits,
    changed: ['context', 'rateLimits'],
  }
}

function world(on: On, store?: Record<string, unknown>) {
  const clock = mock.clock(on, { now: at(15, 0) })
  mock.store(on, store)
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  const notices: string[] = []
  on('ui.status', async (_$, e) => {
    statuses.push(e.text)

    return { value: undefined } as never
  })
  on('ui.toast', async (_$, e) => {
    toasts.push(e.text)

    return { value: undefined } as never
  })
  on('ui.notify', async (_$, e) => {
    notices.push(e.text)

    return { value: { isSent: true, channel: 'terminal_bell' } } as never
  })
  on('session.measure', async (_$, e) => ({ changed: e.changed }))

  return { clock, statuses, toasts, notices }
}

test('the status line carries the windows and the context fill', async ($, on) => {
  const w = world(on)
  await $.session.measure(measured({ five: 62, week: 35, ctx: 45 }))
  expect(w.statuses.at(-1)).toBe('待機中 ｜ 5時間 62%（18:40 回復）・週 35%・文脈 45%▲')

  await $.session.measure(measured({ five: 83, week: 86, ctx: 61 }))
  // 86% of the week with 45% of it gone runs past the limit before the reset.
  expect(w.statuses.at(-1)).toBe('待機中 ｜ ⚠5時間 83%（18:40 回復）・⚠週 86%（10/22 回復・ペース速め）・文脈 61%‼')

  // Off a subscription there are no windows: only the context shows.
  await $.session.measure(measured({ ctx: 52 }))
  expect(w.statuses.at(-1)).toBe('待機中 ｜ 文脈 52%⚠')

  // A window past its reset is stale until the next response.
  await $.session.measure(measured({ five: 99 }))
  await w.clock.set(at(18, 45))
  await $.session.measure(measured({ five: 99 }))
  expect(w.statuses.at(-1)).toBe('待機中 ｜ 5時間 回復済み')
})

test('each window is announced once at 80% and once at 95%, and again after it resets', async ($, on) => {
  const w = world(on)
  await $.session.measure(measured({ five: 81 }))
  expect(w.toasts).toEqual(['5時間枠が81%になりました。18:40 に回復します。'])
  await $.session.measure(measured({ five: 85 }))
  expect(w.toasts).toHaveLength(1)

  await $.session.measure(measured({ five: 96 }))
  expect(w.toasts.at(-1)).toBe('5時間枠が96%です。まもなく上限です（18:40 回復）。')
  expect(w.notices).toEqual(['5時間枠が96%です。まもなく上限です（18:40 回復）。'])
  await $.session.measure(measured({ five: 98 }))
  expect(w.toasts).toHaveLength(2)

  await $.session.measure(measured({ five: 82, fiveReset: iso(at(23, 40)) }))
  expect(w.toasts.at(-1)).toBe('5時間枠が82%になりました。23:40 に回復します。')
})

test('a jump past both levels is announced once, at the higher', async ($, on) => {
  const w = world(on)
  await $.session.measure(measured({ five: 70, week: 40 }))
  await $.session.measure(measured({ five: 70, week: 96 }))
  expect(w.toasts).toEqual([
    '週の枠が96%です。まもなく上限です（10/22 12:00 回復）。',
    '週の枠の消費ペースが速めです。このままだと回復前に上限に達する見込みです。',
  ])
})

test('a window another session already announced is not announced again', async ($, on) => {
  const limit = { kind: 'five_hour', percentUsed: 85, resetsAt: FIVE_RESET }
  const w = world(on, { limitNotices: { five_hour: { resetKey: windowKey(limit), level: 80, isFastNotified: false } } })
  await $.session.measure(measured({ five: 85 }))
  expect(w.toasts).toEqual([])
})

test('a fast five-hour pace shows while it lasts and is announced once', async ($, on) => {
  const w = world(on)
  await $.session.measure(measured({ five: 50 }))
  await w.clock.advance(10 * MINUTE)
  await $.session.measure(measured({ five: 54 }))
  // 4 points in 10 minutes: the 46 left last 115 minutes, so 17:05, before 18:40.
  expect(w.toasts).toEqual(['5時間枠の消費ペースが速めです。このままだと17:05頃に上限です。'])
  await w.clock.advance(5 * MINUTE)
  await $.session.measure(measured({ five: 58 }))
  // 8 points in 15 minutes: the 42 left last about 79 minutes, so 16:33.
  expect(w.statuses.at(-1)).toBe('待機中 ｜ 5時間 58%（18:40 回復・16:33頃に上限）')
  expect(w.toasts).toHaveLength(1)

  const ui = await $.ui.mount({ plugin: 'progress-panel', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Text', text: /ペース速め：このままだと 16:33 頃に上限/ })).toBeDefined()
  await ui.unmount()

  await w.clock.advance(20 * MINUTE)
  await $.session.measure(measured({ five: 59 }))
  expect(w.statuses.at(-1)).toBe('待機中 ｜ 5時間 59%（18:40 回復）')
  expect(w.toasts).toHaveLength(1)
})

test('the five-hour pace needs ten minutes and two points of readings', () => {
  const limit = { kind: 'five_hour', percentUsed: 60, resetsAt: FIVE_RESET }
  const t = at(15, 0)
  const sample = (dt: number, pct: number) => ({ t: t + dt, pct, resetsAt: FIVE_RESET })
  expect(fiveHourPace([sample(0, 50), sample(5 * MINUTE, 60)], limit, t + 5 * MINUTE, false)).toBeUndefined()
  expect(fiveHourPace([sample(0, 50), sample(20 * MINUTE, 51)], limit, t + 20 * MINUTE, false)).toBeUndefined()
  // Readings of an earlier window say nothing about this one.
  expect(fiveHourPace([{ t, pct: 10, resetsAt: 'x' }, sample(20 * MINUTE, 60)], limit, t + 20 * MINUTE, false)).toBeUndefined()
  expect(fiveHourPace([sample(0, 50), sample(20 * MINUTE, 60)], limit, t + 20 * MINUTE, false)).toBeDefined()
})

test('the five-hour pace enters with ten minutes to spare and leaves only past the reset', () => {
  const t = at(15, 0)
  // 40 points in 200 minutes: 100% lands at 18:20, 20 minutes before an 18:40 reset.
  const samples = [
    { t: t - 20 * MINUTE, pct: 56, resetsAt: FIVE_RESET },
    { t, pct: 60, resetsAt: FIVE_RESET },
  ]
  const limit = { kind: 'five_hour', percentUsed: 60, resetsAt: FIVE_RESET }
  expect(fiveHourPace(samples, limit, t, false)).toBe(at(18, 20))
  const lateReset = iso(at(18, 25))
  const near = samples.map(s => ({ ...s, resetsAt: lateReset }))
  expect(fiveHourPace(near, { ...limit, resetsAt: lateReset }, t, false)).toBeUndefined()
  expect(fiveHourPace(near, { ...limit, resetsAt: lateReset }, t, true)).toBe(at(18, 20))
})

test('the weekly pace reads the average since the window began', () => {
  const now = at(15, 0)
  const halfway = { kind: 'seven_day', resetsAt: iso(now + 3.5 * DAY) }
  expect(weeklyPace({ ...halfway, percentUsed: 60 }, now, false)).toBe(true)
  expect(weeklyPace({ ...halfway, percentUsed: 52 }, now, false)).toBe(false)
  expect(weeklyPace({ ...halfway, percentUsed: 52 }, now, true)).toBe(true)
  expect(weeklyPace({ ...halfway, percentUsed: 48 }, now, true)).toBe(false)
  // Too early in the window to tell.
  expect(weeklyPace({ kind: 'seven_day', percentUsed: 30, resetsAt: iso(now + 6.5 * DAY) }, now, false)).toBe(false)
})

test('the context is announced at 40, 50 and 60%, and again after it falls', async ($, on) => {
  const w = world(on)
  await $.session.measure(measured({ ctx: 41 }))
  await $.session.measure(measured({ ctx: 45 }))
  await $.session.measure(measured({ ctx: 55 }))
  await $.session.measure(measured({ ctx: 72 }))
  expect(w.toasts).toEqual([
    '文脈が40%を超えました。',
    '文脈が50%を超えました。/compact か /clear を検討する頃合いです。',
    '文脈が60%を超えました。区切りのよいところで /compact か /clear をおすすめします。',
  ])

  // A /compact leaves no reading until the next response, then a lower one.
  await $.session.measure(measured({}))
  await $.session.measure(measured({ ctx: 20 }))
  await $.session.measure(measured({ ctx: 43 }))
  expect(w.toasts.at(-1)).toBe('文脈が40%を超えました。')
  expect(w.toasts).toHaveLength(4)
})

test('a context jump past several levels is announced once', () => {
  expect(contextStep(65, 0)).toEqual({ notify: 60, level: 60 })
  expect(contextStep(58, 60)).toEqual({ level: 60 })
  expect(contextStep(52, 60)).toEqual({ level: 50 })
})

test('the pane shows the windows and the context, and no empty task list', async ($, on) => {
  const w = world(on)
  await $.session.measure(measured({ five: 62, week: 35, ctx: 30 }))
  await $.session.measure(measured({ five: 62, week: 35, ctx: 33 }))
  await $.session.measure(measured({ five: 62, week: 35, ctx: 36 }))
  expect(w.toasts).toEqual([])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'progress-panel', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /利用枠（15:00 時点）/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5時間 62% ■■■■■■□□□□ 18:40 回復/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /週 35% ■■■■□□□□□□ 10\/22 回復/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /コンテキスト 36%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /約 72k \/ 200k トークン・次の目安 40%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1ターンあたり約 \+3%・あと 2 ターンほどで 40%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /やることリスト/ })).toBeUndefined()
    await ui.unmount()
  }
})
