import type { Progress, SessionCard } from '../types'
import { maskCommand } from './worklog'

// The other sessions on this machine, shared through $.store under one key each.
export const CARD_PREFIX = 'session:'
// Changes in a row are written at most this often; the last state is always written.
export const PUBLISH_GAP_MS = 5_000
// Written even when nothing changed, so the others know the session is alive.
export const HEARTBEAT_MS = 60_000
// How often the others are read back.
export const POLL_MS = 10_000
// No heartbeat for three rounds: the session is shown as not answering.
export const STALE_MS = 3 * HEARTBEAT_MS
// Left this long, a card is removed by whoever reads it.
export const PRUNE_MS = 30 * 60_000
export const MAX_ROWS = 6
const REQUEST_CHARS = 40

export function cardKey(id: string): string {
  return `${CARD_PREFIX}${id}`
}

// The folder's last part, whichever separator the path uses.
export function folderOf(cwd: string): string {
  return cwd.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) ?? ''
}

// A secret said in words rather than in a command: "パスワードは hunter2", "token: abc".
const SAID_SECRET = /((?:パスワード|暗証番号|パスコード|トークン|シークレット|APIキー|password|passwd|passphrase|token|secret|api[-_ ]?key)\s*(?:は|が|を|:|：|=)\s*)(\S+)/gi

// A line shared with the other sessions: masked like a logged command, and like a secret in words.
export function maskText(text: string): string {
  return maskCommand(text).replace(SAID_SECRET, '$1***')
}

// The first line of a request, masked and cut short, whole characters only.
export function requestLine(text: string): string {
  const first = text.split('\n').find(line => line.trim() !== '') ?? ''
  const chars = Array.from(maskText(first))

  return chars.length > REQUEST_CHARS ? `${chars.slice(0, REQUEST_CHARS).join('')}…` : chars.join('')
}

// When the session last did something: the start of the turn it works in, or the end of its last one.
// One that has not worked yet counts from when it began sharing.
export function activeAtOf(p: Progress, since: number): number {
  return (p.isWorking ? p.startedAt : p.endedAt) || since
}

type Shared = { id: string; folder: string; branch: string; request: string; context?: number; updatedAt: number; activeAt: number }

export function cardOf(p: Progress, s: Shared): SessionCard {
  const done = p.tasks.filter(t => t.status === 'completed').length
  const current = maskText(p.tasks.find(t => t.status === 'in_progress')?.title ?? '')

  return { ...s, isWorking: p.isWorking, action: p.action, done, total: p.tasks.length, current }
}

// When a card's session last did something; a 0.5.0 card only says when it was written.
export const activeOf = (card: SessionCard) => card.activeAt ?? card.updatedAt

// What a card holds, its time aside: a write is needed when this changes.
export function cardShape(card: SessionCard): string {
  const { updatedAt: _, ...rest } = card

  return JSON.stringify(rest)
}

// A value read back from the store, if it is a card.
export function asCard(value: unknown): SessionCard | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const c = value as Partial<SessionCard>
  if (typeof c.id !== 'string' || typeof c.updatedAt !== 'number' || typeof c.isWorking !== 'boolean') return undefined

  return {
    id: c.id,
    folder: String(c.folder ?? ''),
    branch: String(c.branch ?? ''),
    request: String(c.request ?? ''),
    isWorking: c.isWorking,
    action: String(c.action ?? ''),
    done: Number(c.done ?? 0),
    total: Number(c.total ?? 0),
    current: String(c.current ?? ''),
    context: typeof c.context === 'number' ? c.context : undefined,
    updatedAt: c.updatedAt,
    activeAt: typeof c.activeAt === 'number' ? c.activeAt : undefined,
  }
}

// When a stored value was written, if it says: a card of another version is aged by it, never thrown out unread.
export function writtenAt(value: unknown): number | undefined {
  const at = typeof value === 'object' && value !== null ? (value as { updatedAt?: unknown }).updatedAt : undefined

  return typeof at === 'number' ? at : undefined
}

export function isStale(card: SessionCard, now: number): boolean {
  return now - card.updatedAt >= STALE_MS
}

export function isPrunable(card: SessionCard, now: number): boolean {
  return now - card.updatedAt >= PRUNE_MS
}

const RANK = (card: SessionCard, now: number) => (isStale(card, now) ? 2 : card.isWorking ? 0 : 1)

// Working first, then waiting, then not answering; within each, the one that did something last first.
// The heartbeat's time would reorder idle sessions every minute, so it is not used here.
export function sortCards(cards: SessionCard[], now: number): SessionCard[] {
  return [...cards].sort((a, b) => RANK(a, now) - RANK(b, now) || activeOf(b) - activeOf(a) || a.id.localeCompare(b.id))
}

export function counts(cards: SessionCard[], now: number): { working: number; waiting: number } {
  const live = cards.filter(c => !isStale(c, now))

  return { working: live.filter(c => c.isWorking).length, waiting: live.filter(c => !c.isWorking).length }
}

// The status line's part for the others; '' when none is alive.
export function othersStatus(cards: SessionCard[], now: number): string {
  const { working, waiting } = counts(cards, now)
  const parts = [working > 0 ? `作業中${working}` : '', waiting > 0 ? `待機${waiting}` : ''].filter(Boolean)

  return parts.length > 0 ? `他 ${parts.join(' ')}` : ''
}

export function ago(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000)
  if (m < 1) return 'たった今'
  if (m < 60) return `${m}分前`

  return `${Math.floor(m / 60)}時間前`
}

export type CardRow = { text: string; isBold?: boolean; isDim?: boolean; color?: 'yellow' | 'green' }

// One session as the pane shows it: a heading, its state, and what it works on.
export function cardRows(card: SessionCard, now: number): CardRow[] {
  const name = card.branch ? `${card.folder}（${card.branch}）` : card.folder
  if (isStale(card, now)) return [{ text: `? ${name} 応答なし・${ago(now - card.updatedAt)}`, isDim: true }]

  const tasks = card.total > 0 ? ` ${card.done}/${card.total}` : ''
  const state = card.isWorking
    ? [`作業中${tasks}`, card.action || '考え中']
    : [`待機中${tasks}`]
  if (card.context !== undefined) state.push(`文脈 ${card.context}%`)
  if (!card.isWorking) state.push(ago(now - activeOf(card)))
  const rows: CardRow[] = [
    { text: `${card.isWorking ? '●' : '○'} ${name}`, isBold: true, color: card.isWorking ? 'yellow' : 'green' },
    { text: `  ${state.join('・')}` },
  ]
  if (card.current) rows.push({ text: `  ▶ ${card.current}`, isDim: true })
  else if (card.request) rows.push({ text: `  依頼：${card.request}`, isDim: true })

  return rows
}

// The section's heading, its rows, and how many were left out.
export function othersSection(cards: SessionCard[], now: number): { heading: string; rows: CardRow[]; hidden: number } {
  const sorted = sortCards(cards, now)
  const { working, waiting } = counts(cards, now)
  const parts = [working > 0 ? `作業中 ${working}` : '', waiting > 0 ? `待機 ${waiting}` : ''].filter(Boolean)

  return {
    heading: `ほかのセッション${parts.length > 0 ? `（${parts.join('・')}）` : ''}`,
    rows: sorted.slice(0, MAX_ROWS).flatMap(c => cardRows(c, now)),
    hidden: Math.max(0, sorted.length - MAX_ROWS),
  }
}
