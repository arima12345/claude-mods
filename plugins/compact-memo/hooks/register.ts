import type { EngineInterface, Register } from 'claude-code'

import type { CompactionRecord, GoalSlice, LogSlice, MemoRecord, TaskSlice } from '../types'
import { buildMemo, withInstruction, type Gathered } from './memo'

const LABEL = { plugin: 'compact-memo', key: 'label' } as const
const MEMOS = 'memos'
const COMPACTIONS = 'compactions'
const KEEP_MEMOS = 10
const KEEP_COMPACTIONS = 20

const pad = (n: number) => String(n).padStart(2, '0')
function when(ms: number): string {
  const d = new Date(ms)

  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${pad(d.getMinutes())}`
}

const TRIGGER_WORD: Record<string, string> = { manual: '手動', auto: '自動', plugin: 'mod', precompute: '事前' }
const NO_MEMO_WHY: Record<NonNullable<CompactionRecord['reason']>, string> = { empty: '残すことがなかった', unread: '状況を読み取れなかった' }
const NO_MEMO_TOAST: Record<NonNullable<CompactionRecord['reason']>, string> = {
  empty: '残すことがなかったので、退避メモは作りませんでした（ゴール・やることの残り・コミット・失敗中のテストがありません）',
  unread: '状況を読み取れなかったので、退避メモは作りませんでした',
}

// Other mods' state: read when installed, empty when not.
async function readOthers($: EngineInterface): Promise<{ goal: GoalSlice; tasks: TaskSlice[]; log: LogSlice[] }> {
  const goal = await $.state.get({ plugin: 'goal2', key: 'goal' } as const).then(r => r.value ?? null, () => null)
  const progress = await $.state.get({ plugin: 'progress-panel', key: 'progress' } as const).then(r => r.value, () => undefined)
  const log = await $.state.get({ plugin: 'progress-panel', key: 'log' } as const).then(r => r.value ?? [], () => [])

  return { goal, tasks: progress?.tasks ?? [], log }
}

// `undefined` where git cannot say (no repository, no git, a detached head).
async function branch($: EngineInterface): Promise<string | undefined> {
  const run = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 5000 }).catch(() => undefined)
  const name = run && run.exitCode === 0 ? run.stdout.trim() : ''

  return name && name !== 'HEAD' ? name : undefined
}

async function gather($: EngineInterface, at: number): Promise<Gathered> {
  const others = await readOthers($)
  const label = await $.state.get(LABEL).then(r => r.value ?? '', () => '')

  return { ...others, label, at: when(at), branch: await branch($) }
}

const sessionId = ($: EngineInterface) => $.session.id().catch(() => undefined)

async function keep<T>($: EngineInterface, key: string, item: T, max: number): Promise<void> {
  const list = ((await $.store.get(key)) ?? []) as T[]
  await $.store.set(key, [...list, item].slice(-max))
}

// One compaction: when, how, where, how full, and whether a memo came of it (older records lack the last two).
export function recordLine(c: CompactionRecord): string {
  const fill = c.percent !== undefined ? `文脈 ${c.percent}%` : '文脈 —'
  const size = c.tokens !== undefined ? `（約 ${Math.round(c.tokens / 1000)}k / ${Math.round(c.window / 1000)}k）` : ''
  const where = c.label ? `・${c.label}` : ''
  const memo = c.hasMemo === undefined ? '' : c.hasMemo ? '・メモあり' : `・メモなし（${NO_MEMO_WHY[c.reason ?? 'empty']}）`

  return `${when(c.at)} ${TRIGGER_WORD[c.trigger] ?? c.trigger}${where}: ${fill}${size}${memo}`
}

// The session `/compact-memo` is typed in: its id, and its folder for the heading.
export type Here = { session: string | undefined; label: string }

// This session first: its last compaction and the memo handed back then, or that there was none.
// Other sessions' memos are theirs to show; their compactions stay in the record, marked apart.
export function report(memos: MemoRecord[], compactions: CompactionRecord[], here: Here): string {
  const isHere = (r: { session?: string }) => here.session !== undefined && r.session === here.session
  const lines = [`## このセッション${here.label ? `（${here.label}）` : ''}`]
  const last = compactions.filter(isHere).at(-1)
  const memo = last?.hasMemo ? memos.filter(isHere).find(m => m.at === last.at) : undefined
  if (!last) lines.push('このセッションではまだ圧縮が起きていません。')
  else {
    lines.push(`最後の圧縮: ${recordLine(last)}`)
    if (memo) lines.push('', '### そのとき渡し直した退避メモ', '', memo.text)
    else lines.push('この圧縮では退避メモを作っていません。圧縮後の Claude には、要約だけが渡りました。')
  }
  if (memos.some(m => !isHere(m))) lines.push('', 'ほかのセッションの退避メモは、そのセッションで /compact-memo を打つと見られます。')
  if (compactions.length > 0) {
    lines.push('', '## 圧縮の記録（新しい順・すべてのセッション）')
    for (const c of [...compactions].reverse()) lines.push(`- ${recordLine(c)}${isHere(c) ? '（このセッション）' : ''}`)
  }

  return lines.join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const folder = started.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
    await $.state.set(LABEL, folder).catch(() => {})
    await $.command.register({ name: 'compact-memo', description: 'このセッションの最後の圧縮と退避メモ、圧縮の記録を見る' })

    return started
  })

  on('command.run', { command: 'compact-memo' }, async $ => {
    const memos = ((await $.store.get(MEMOS)) ?? []) as MemoRecord[]
    const compactions = ((await $.store.get(COMPACTIONS)) ?? []) as CompactionRecord[]
    const here = { session: await sessionId($), label: await $.state.get(LABEL).then(r => r.value ?? '', () => '') }

    return { text: report(memos, compactions, here) }
  })

  // A failure here never stands in the way of the compaction: the hook is skipped and it goes ahead.
  on('session.compact', async ($, e, next) => {
    // A subagent's own transcript is its business.
    if (e.agentId) return next(e)
    const isFinal = e.trigger !== 'precompute'
    const at = await $.clock.now()
    // Gathered before the summary runs, so the memo holds the moment it replaces.
    const gathered = isFinal ? await gather($, at).catch(() => undefined) : undefined
    const context = isFinal ? (await $.session.usage().catch(() => undefined))?.context : undefined

    const done = await next({ ...e, instructions: withInstruction(e.instructions) })
    // A compaction that did not happen (a skip) leaves no record.
    if (!isFinal || !done.messages) return done

    const text = gathered ? buildMemo(gathered) : undefined
    const label = gathered?.label ?? (await $.state.get(LABEL).then(r => r.value ?? '', () => ''))
    const reason: CompactionRecord['reason'] = !gathered ? 'unread' : text === undefined ? 'empty' : undefined
    const session = await sessionId($)
    const record: CompactionRecord = {
      at,
      trigger: e.trigger,
      percent: context?.percent,
      tokens: context?.tokens,
      window: context?.window ?? 0,
      label,
      hasMemo: text !== undefined,
      ...(reason ? { reason } : {}),
      ...(session ? { session } : {}),
    }
    await keep($, COMPACTIONS, record, KEEP_COMPACTIONS).catch(() => {})
    // Said either way: no memo is the summary standing alone, not a failure to look for.
    if (text === undefined) {
      $.ui.toast(NO_MEMO_TOAST[reason ?? 'empty'], { timeoutMs: 8000 })

      return done
    }
    await keep<MemoRecord>($, MEMOS, { at, trigger: e.trigger, text, ...(session ? { session } : {}) }, KEEP_MEMOS).catch(() => {})
    $.ui.toast('圧縮前のメモを渡し直しました（/compact-memo で見られます）', { timeoutMs: 8000 })

    return { ...done, messages: [...done.messages, { role: 'user' as const, text, toolUses: [] }] }
  })
}
