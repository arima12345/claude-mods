import type { ContextFill, Limit, Sample, Usage } from '../types'

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

// Local wall-clock time, as the person reads it.
export function clockTime(ms: number): string {
  const d = new Date(ms)

  return `${d.getHours()}:${pad(d.getMinutes())}`
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

// The reset time to the nearest ten minutes: a few seconds' drift between responses is the same window.
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
  const kept = samples.filter(s => s.resetsAt === resetsAt && s.t > t - SAMPLE_SPAN)

  return [...kept, { t, pct: limit.percentUsed, resetsAt }].slice(-MAX_SAMPLES)
}

// The five-hour window by its last half hour: when it would reach 100%, if before its reset.
// Entering needs ten minutes to spare and leaving needs the reset to come first, so the mark does not flicker.
export function fiveHourPace(samples: Sample[], limit: Limit, now: number, wasFast: boolean): number | undefined {
  const reset = resetTime(limit)
  if (reset === undefined) return undefined
  const recent = samples.filter(s => s.resetsAt === limit.resetsAt && s.t > now - SAMPLE_SPAN)
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
    lines.push({ text: `  ペース速め：${eta}`, color: 'yellow' })
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

// The context's growth per measurement over the last few, when it grows.
export function contextGrowth(history: number[]): number | undefined {
  const first = history[0]
  const last = history.at(-1)
  if (first === undefined || last === undefined || history.length < 2) return undefined
  const growth = (last - first) / (history.length - 1)

  return growth > 0 ? growth : undefined
}

export function nextHistory(history: number[], pct: number): number[] {
  const last = history.at(-1)

  // A fall is a /compact or /clear: the growth before it no longer says anything.
  return last !== undefined && pct < last ? [pct] : last === pct ? history : [...history, pct].slice(-5)
}

export function tokens(n: number): string {
  return n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : `${Math.round(n / 1000)}k`
}

export function contextLines(context: ContextFill, history: number[]): string[] {
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

  return lines
}

// What was announced for a window, kept across sessions so each is said once.
export type LimitNotice = { resetKey: number; level: number; isFastNotified: boolean }
