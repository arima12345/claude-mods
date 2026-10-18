import type { ContextFill, ContextReading, Limit, Sample, Usage } from '../types'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export const emptyUsage: Usage = {
  measuredAt: 0,
  limits: [],
  context: null,
  samples: {},
  fast: {},
  contextHistory: [],
  contextLevel: 0,
}

export const LIMIT_LEVELS = [80, 95] as const
export const CONTEXT_LEVELS = [40, 50, 60] as const

const pad = (n: number) => String(n).padStart(2, '0')

// Local wall-clock time, as the person reads it: HH:MM.
export function clockTime(ms: number): string {
  const d = new Date(ms)

  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function monthDay(ms: number): string {
  const d = new Date(ms)

  return `${d.getMonth() + 1}/${d.getDate()}`
}

export function shortName(kind: string): string {
  return kind === 'five_hour' ? '5時間' : kind === 'seven_day' ? '週' : kind
}

function windowName(kind: string): string {
  return kind === 'five_hour' ? '5時間枠' : kind === 'seven_day' ? '週の枠' : `${kind} の枠`
}

function resetTime(limit: Limit): number | undefined {
  const t = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN

  return Number.isNaN(t) ? undefined : t
}

// Responses report a window's reset with a few seconds' drift: resets this close are one window.
const RESET_SLACK = 10 * MINUTE

export function sameReset(a: string | undefined, b: string | undefined): boolean {
  const ta = a ? Date.parse(a) : NaN
  const tb = b ? Date.parse(b) : NaN
  // A window that names no reset, or one that cannot be read, is only itself.
  if (Number.isNaN(ta) || Number.isNaN(tb)) return (a ?? '') === (b ?? '')

  return Math.abs(ta - tb) < RESET_SLACK
}

// How 0.4.0 keyed a window in $.store: its reset to the nearest ten minutes. Read to carry old records over.
export function windowKey(limit: Limit): number {
  const t = resetTime(limit)

  return t === undefined ? 0 : Math.round(t / (10 * MINUTE))
}

// Shown as the thresholds read: 79.9% has not crossed 80%.
export const percent = (pct: number) => Math.floor(pct)

const ORDER: Record<string, number> = { five_hour: 0, seven_day: 1 }

export function ordered(limits: Limit[]): Limit[] {
  return [...limits].sort((a, b) => (ORDER[a.kind] ?? 2) - (ORDER[b.kind] ?? 2))
}

const SAMPLE_SPAN = 30 * MINUTE
const MAX_SAMPLES = 60

export function addSample(samples: Sample[], limit: Limit, t: number): Sample[] {
  const resetsAt = limit.resetsAt ?? ''
  const kept = samples.filter(s => sameReset(s.resetsAt, resetsAt) && s.t > t - SAMPLE_SPAN)

  return [...kept, { t, pct: limit.percentUsed, resetsAt }].slice(-MAX_SAMPLES)
}

// The five-hour window by its last half hour: when it would reach 100%, if before its reset.
// Entering needs ten minutes to spare and leaving needs the reset to come first, so the mark does not flicker.
export function fiveHourPace(samples: Sample[], limit: Limit, now: number, wasFast: boolean): number | undefined {
  const reset = resetTime(limit)
  if (reset === undefined) return undefined
  const recent = samples.filter(s => sameReset(s.resetsAt, limit.resetsAt) && s.t > now - SAMPLE_SPAN)
  const first = recent[0]
  const last = recent.at(-1)
  if (!first || !last || recent.length < 2) return undefined
  const dt = last.t - first.t
  const dp = last.pct - first.pct
  if (dt < 10 * MINUTE || dp < 2) return undefined
  const eta = last.t + ((100 - last.pct) / dp) * dt
  const isFast = wasFast ? eta < reset : eta <= reset - 10 * MINUTE

  return isFast ? eta : undefined
}

// The weekly window by its average since it began: a busy hour should not read as a fast week.
export function weeklyPace(limit: Limit, now: number, wasFast: boolean): boolean {
  const reset = resetTime(limit)
  if (reset === undefined) return false
  const elapsed = 1 - (reset - now) / (7 * DAY)
  if (elapsed < 0.1 || elapsed > 1 || limit.percentUsed < 20) return false
  const projected = limit.percentUsed / elapsed

  return wasFast ? projected >= 100 : projected >= 110
}

export function isPast(limit: Limit, now: number): boolean {
  const reset = resetTime(limit)

  return reset !== undefined && reset <= now
}

export function limitStatus(limit: Limit, fastEta: number | undefined, now: number): string {
  const name = shortName(limit.kind)
  if (isPast(limit, now)) return `${name} 回復済み`
  const pct = percent(limit.percentUsed)
  const mark = pct >= 80 ? '⚠' : ''
  const reset = resetTime(limit)
  const notes: string[] = []
  if (limit.kind === 'five_hour') {
    if (reset !== undefined) notes.push(`${clockTime(reset)} 回復`)
    if (fastEta) notes.push(`${clockTime(fastEta)}頃に上限`)
  } else if (limit.kind === 'seven_day') {
    if (reset !== undefined && pct >= 80) notes.push(`${monthDay(reset)} 回復`)
    if (fastEta !== undefined) notes.push('ペース速め')
  }

  return `${mark}${name} ${pct}%${notes.length > 0 ? `（${notes.join('・')}）` : ''}`
}

export type PaneLine = { text: string; color?: 'red' | 'yellow'; isDim?: boolean }

// One window as the panel draws it: the reading and its reset, then the pace when it runs fast.
export function limitLines(limit: Limit, fastEta: number | undefined, now: number): PaneLine[] {
  const name = shortName(limit.kind)
  if (isPast(limit, now)) return [{ text: `${name} 回復済み（次の応答で更新）`, isDim: true }]
  const pct = percent(limit.percentUsed)
  const reset = resetTime(limit)
  const when = reset === undefined ? '' : limit.kind === 'five_hour' ? ` ${clockTime(reset)} 回復` : ` ${monthDay(reset)} 回復`
  const lines: PaneLine[] = [
    { text: `${pct >= 80 ? '⚠' : ''}${name} ${pct}% ${meter(pct)}${when}`, color: pct >= 95 ? 'red' : pct >= 80 ? 'yellow' : undefined },
  ]
  if (fastEta !== undefined) {
    const eta = fastEta > 0 ? `このままだと ${clockTime(fastEta)} 頃に上限` : 'このままだと回復前に上限の見込み'
    lines.push({ text: `  ⚠ ペース速め：${eta}`, color: 'yellow' })
  }

  return lines
}

export function meter(pct: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))

  return '■'.repeat(filled) + '□'.repeat(width - filled)
}

export function contextMark(pct: number): string {
  return pct >= 60 ? '‼' : pct >= 50 ? '⚠' : pct >= 40 ? '▲' : ''
}

export function usageStatus(usage: Usage, now: number): string {
  const parts = ordered(usage.limits).map(l => limitStatus(l, usage.fast[l.kind], now))
  const pct = usage.context?.percent
  if (pct !== undefined) parts.push(`文脈 ${pct}%${contextMark(pct)}`)
  // A fill read before and none now (after a /compact, until the next response): a dash, not the old figure.
  else if (usage.contextHistory.length > 0 && parts.length > 0) parts.push('文脈 —')

  return parts.join('・')
}

// The highest level a reading has crossed, 0 below the first.
export function levelOf(pct: number, levels: readonly number[]): number {
  return levels.filter(l => pct >= l).at(-1) ?? 0
}

// Which context threshold to announce now, and the level announced after it.
// A fill that falls five points under the last announced level (a /compact) arms the levels above it again.
export function contextStep(pct: number, announced: number): { notify?: number; level: number } {
  const base = announced > 0 && pct <= announced - 5 ? levelOf(pct, CONTEXT_LEVELS) : announced
  const top = levelOf(pct, CONTEXT_LEVELS)

  return top > base ? { notify: top, level: top } : { level: base }
}

export function contextToast(level: number): string {
  if (level >= 60) return '文脈が60%を超えました。区切りのよいところで /compact か /clear をおすすめします。'
  if (level >= 50) return '文脈が50%を超えました。/compact か /clear を検討する頃合いです。'

  return `文脈が${level}%を超えました。`
}

export function contextToastMs(level: number): number {
  return level >= 60 ? 15_000 : level >= 50 ? 10_000 : 6_000
}

function resetLabel(limit: Limit): string {
  const reset = resetTime(limit)
  if (reset === undefined) return ''

  return limit.kind === 'five_hour' ? clockTime(reset) : `${monthDay(reset)} ${clockTime(reset)}`
}

export function limitToast(limit: Limit, level: number): string {
  const name = windowName(limit.kind)
  const pct = percent(limit.percentUsed)
  const reset = resetLabel(limit)
  if (level >= 95) return `${name}が${pct}%です。まもなく上限です${reset ? `（${reset} 回復）` : ''}。`

  return `${name}が${pct}%になりました。${reset ? `${reset} に回復します。` : ''}`
}

export function paceToast(limit: Limit, eta: number): string {
  const name = windowName(limit.kind)

  return eta > 0
    ? `${name}の消費ペースが速めです。このままだと${clockTime(eta)}頃に上限です。`
    : `${name}の消費ペースが速めです。このままだと回復前に上限に達する見込みです。`
}

const GROWTH_TURNS = 5

// Readings kept from 0.4.0 were bare numbers with no turn: they start the history over.
function readings(history: readonly unknown[]): ContextReading[] {
  return history.filter((r): r is ContextReading => typeof r === 'object' && r !== null && 'turn' in r && 'pct' in r)
}

// The context's growth per main turn over the last five, when it grows.
// Turns are counted, not measurements: a turn whose fill did not move adds no reading but still counts.
export function contextGrowth(history: readonly unknown[]): number | undefined {
  const kept = readings(history)
  const last = kept.at(-1)
  const first = kept.find(r => last !== undefined && r.turn >= last.turn - GROWTH_TURNS)
  if (first === undefined || last === undefined || last.turn === first.turn) return undefined
  const growth = (last.pct - first.pct) / (last.turn - first.turn)

  return growth > 0 ? growth : undefined
}

// The latest fill of each turn: a measurement mid-turn (a rate limit that moved) stands in for that turn's.
export function nextHistory(history: readonly unknown[], pct: number, turn: number): ContextReading[] {
  const kept = readings(history)
  const last = kept.at(-1)
  // A fall is a /compact or /clear: the growth before it no longer says anything.
  if (last !== undefined && pct < last.pct) return [{ turn, pct }]
  const rest = last !== undefined && last.turn === turn ? kept.slice(0, -1) : kept

  return [...rest, { turn, pct }].slice(-(GROWTH_TURNS + 1))
}

export function tokens(n: number): string {
  return n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : `${Math.round(n / 1000)}k`
}

export function contextLines(context: ContextFill, history: readonly unknown[], valve = 0): string[] {
  const pct = context.percent
  if (pct === undefined) return []
  const lines: string[] = []
  const next = CONTEXT_LEVELS.find(l => l > pct)
  const size = context.tokens !== undefined ? `約 ${tokens(context.tokens)} / ${tokens(context.window)} トークン` : ''
  lines.push([size, next ? `次の目安 ${next}%` : '目安の 60% を超えています'].filter(Boolean).join('・'))
  const growth = contextGrowth(history)
  if (growth !== undefined) {
    const per = `1ターンあたり約 +${Math.max(1, Math.round(growth))}%`
    lines.push(next ? `${per}・あと ${Math.ceil((next - pct) / growth)} ターンほどで ${next}%` : per)
  }
  if (valve > 0 && context.tokens !== undefined) {
    const left = valve - context.tokens
    lines.push(left > 0 ? `自動圧縮の基準 約 ${tokens(valve)} まで あと ${tokens(left)}` : `自動圧縮の基準 約 ${tokens(valve)} を超えています`)
  }

  return lines
}

// Read where automatic compaction runs once the fill makes it worth knowing.
export const VALVE_FROM = 50

type Breakdown = { autoCompactThreshold?: number; isAutoCompactEnabled?: boolean; rawMaxTokens?: number }

// Where automatic compaction runs, in tokens, from the context breakdown: its threshold, which sits
// under the window it measures against; that window where a build reports no threshold; -1 when it is off.
// 0 when nothing could be read, so a later measurement tries again.
export function valveOf(breakdown: Breakdown | undefined): number {
  if (breakdown === undefined) return 0
  if (breakdown.isAutoCompactEnabled === false) return -1

  return breakdown.autoCompactThreshold ?? breakdown.rawMaxTokens ?? 0
}
export const VALVE_WARN = 0.9
const VALVE_REARM = 0.8

// Whether to give the last warning now, and whether it stands given afterwards.
// A fill that falls well under the window (a compaction) arms it again.
export function valveStep(tokensUsed: number | undefined, valve: number, wasWarned: boolean): { warn?: number; isWarned: boolean } {
  if (tokensUsed === undefined || valve <= 0) return { isWarned: wasWarned }
  const share = tokensUsed / valve
  if (share >= VALVE_WARN && !wasWarned) return { warn: Math.floor(share * 100), isWarned: true }

  return { isWarned: share < VALVE_REARM ? false : wasWarned }
}

export function valveToast(share: number): string {
  return `まもなく自動で圧縮されます（基準の ${share}%）。区切りのよいところで /compact をおすすめします。`
}

export const BREAK_FROM = 50
const BREAK_STEP = 10

// Whether a break in the work is worth a notice at this fill: once past 50%, then again only ten points on.
export function breakStep(pct: number | undefined, isBreak: boolean, notified: number): { notify: boolean; notified: number } {
  if (pct === undefined) return { notify: false, notified }
  if (pct < BREAK_FROM) return { notify: false, notified: 0 }
  if (isBreak && (notified === 0 || pct >= notified + BREAK_STEP)) return { notify: true, notified: pct }

  return { notify: false, notified }
}

export function breakToast(pct: number): string {
  return `区切りどきです（文脈 ${pct}%）。続ける前に /compact か /clear を検討してください。`
}

// What was announced for a window, kept across sessions so each is said once.
// `resetAt` is the window's reset in ms, 0 for a window that names none; 0.4.0 kept `resetKey` instead.
export type LimitNotice = { resetAt?: number; resetKey?: number; level: number; isFastNotified: boolean }

// The record a reading continues, or a fresh one for a window that reset since.
export function noticeFor(was: LimitNotice | undefined, limit: Limit): LimitNotice {
  const reset = resetTime(limit)
  const fresh: LimitNotice = { resetAt: reset ?? 0, level: 0, isFastNotified: false }
  if (!was) return fresh
  const isSame =
    was.resetAt === undefined
      ? was.resetKey === windowKey(limit)
      : reset === undefined
        ? was.resetAt === 0
        : was.resetAt !== 0 && Math.abs(was.resetAt - reset) < RESET_SLACK
  if (!isSame) return fresh
  const kept: LimitNotice = { resetAt: reset ?? 0, level: was.level, isFastNotified: was.isFastNotified }
  // A window that names no reset (a gateway's spend limit) never resets by time: it is armed again once it falls well under.
  if (reset === undefined && limit.percentUsed <= was.level - 5) return { ...kept, level: levelOf(limit.percentUsed, LIMIT_LEVELS) }

  return kept
}

// The next reset among the windows that is still ahead, for redrawing once it passes while idle.
export function nextReset(limits: Limit[], now: number): number | undefined {
  const ahead = limits.map(resetTime).filter((t): t is number => t !== undefined && t > now)

  return ahead.length > 0 ? Math.min(...ahead) : undefined
}

// Whether a measurement should read where automatic compaction runs: past 50%, and not yet read for this window.
export function needsValve(cur: Usage, context: ContextFill): boolean {
  const pct = context.percent
  if (pct === undefined || pct < VALVE_FROM) return false

  return !cur.valve || cur.valveWindow !== context.window
}

type Measurement = { context: ContextFill; limits: Limit[] }
export type MeasureStep = { next: Usage; contextNotify?: number; valveWarn?: number; breakNotify?: number }

// One measurement folded into the usage as it stands now. Pure: `update` may run it again on a write it lost.
export function measureStep(cur: Usage, m: Measurement, t: number, valveRead: number | undefined): MeasureStep {
  const hasLimits = m.limits.length > 0
  const samples: Usage['samples'] = {}
  const fast: Usage['fast'] = {}
  for (const limit of m.limits) {
    const kept = addSample(cur.samples[limit.kind] ?? [], limit, t)
    samples[limit.kind] = kept
    const wasFast = cur.fast[limit.kind] !== undefined
    if (limit.kind === 'five_hour') {
      const eta = fiveHourPace(kept, limit, t, wasFast)
      if (eta !== undefined) fast[limit.kind] = eta
    } else if (limit.kind === 'seven_day' && weeklyPace(limit, t, wasFast)) {
      fast[limit.kind] = 0
    }
  }

  const pct = m.context.percent
  const step = pct === undefined ? { level: cur.contextLevel } : contextStep(pct, cur.contextLevel)

  // Another model's window (a /model switch) has its own compaction point: forget the old one.
  const isOtherWindow = cur.valveWindow !== undefined && cur.valveWindow !== m.context.window
  let valve = isOtherWindow ? 0 : (cur.valve ?? 0)
  let valveWindow = isOtherWindow ? undefined : cur.valveWindow
  let wasWarned = isOtherWindow ? false : (cur.isValveWarned ?? false)
  if (valveRead !== undefined && valveRead !== 0) {
    valve = valveRead
    valveWindow = m.context.window
    if (valveRead !== cur.valve) wasWarned = false
  }
  const last = valveStep(m.context.tokens, valve, wasWarned)

  // A break the last turn ended at is judged on the fill that turn reached, which may arrive only now.
  // Falling under 50% (a /compact) arms the break notice again.
  const breaks = breakStep(pct, cur.isBreakPending ?? false, cur.breakNotified ?? 0)

  const next: Usage = {
    ...cur,
    // No windows is off a subscription: there is nothing to show, as the measurement says.
    measuredAt: hasLimits ? t : cur.measuredAt,
    limits: m.limits,
    samples,
    fast,
    context: { percent: pct, tokens: m.context.tokens, window: m.context.window },
    contextHistory: pct === undefined ? cur.contextHistory : nextHistory(cur.contextHistory, pct, cur.turns ?? 0),
    contextLevel: step.level,
    valve,
    valveWindow,
    isValveWarned: last.isWarned,
    breakNotified: breaks.notified,
    isBreakPending: pct === undefined ? cur.isBreakPending : false,
  }

  return { next, contextNotify: step.notify, valveWarn: last.warn, breakNotify: breaks.notify ? breaks.notified : undefined }
}

// The end of a main turn: one more turn counted, and a break in the work judged on the fill known now.
// A break that cannot be told yet waits for the turn's own measurement (isBreakPending).
export function turnEndStep(cur: Usage, isBreakNow: boolean): { next: Usage; breakNotify?: number } {
  const step = breakStep(cur.context?.percent, isBreakNow, cur.breakNotified ?? 0)
  const next: Usage = { ...cur, turns: (cur.turns ?? 0) + 1, breakNotified: step.notified, isBreakPending: isBreakNow && !step.notify }

  return { next, breakNotify: step.notify ? step.notified : undefined }
}
