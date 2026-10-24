import type { EngineInterface, Register } from 'claude-code'

import type { CompactionRecord, GoalSlice, LogSlice, MemoRecord, TaskSlice } from '../types'
import { buildMemo, withInstruction, type Gathered } from './memo'

const LABEL = { plugin: 'compact-memo', key: 'label' } as const
const MEMOS = 'memos'
const COMPACTIONS = 'compactions'
const KEEP_MEMOS = 5
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

export function report(memos: MemoRecord[], compactions: CompactionRecord[]): string {
  const lines: string[] = []
  const last = memos.at(-1)
  lines.push(last ? `## 最後に作られた退避メモ（${when(last.at)}・${TRIGGER_WORD[last.trigger] ?? last.trigger}）\n\n${last.text}` : 'まだ退避メモはありません。')
  if (compactions.length > 0) {
    lines.push('', '## 圧縮の記録（新しい順）')
    for (const c of [...compactions].reverse()) lines.push(`- ${recordLine(c)}`)
  }

  return lines.join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const folder = started.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
    await $.state.set(LABEL, folder).catch(() => {})
    await $.command.register({ name: 'compact-memo', description: '直近の圧縮前の退避メモと、圧縮の記録を見る' })

    return started
  })

  on('command.run', { command: 'compact-memo' }, async $ => {
    const memos = ((await $.store.get(MEMOS)) ?? []) as MemoRecord[]
    const compactions = ((await $.store.get(COMPACTIONS)) ?? []) as CompactionRecord[]

    return { text: report(memos, compactions) }
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
    const record: CompactionRecord = {
      at,
      trigger: e.trigger,
      percent: context?.percent,
      tokens: context?.tokens,
      window: context?.window ?? 0,
      label,
      hasMemo: text !== undefined,
      ...(reason ? { reason } : {}),
    }
    await keep($, COMPACTIONS, record, KEEP_COMPACTIONS).catch(() => {})
    // Said either way: no memo is the summary standing alone, not a failure to look for.
    if (text === undefined) {
      $.ui.toast(NO_MEMO_TOAST[reason ?? 'empty'], { timeoutMs: 8000 })

      return done
    }
    await keep<MemoRecord>($, MEMOS, { at, trigger: e.trigger, text }, KEEP_MEMOS).catch(() => {})
    $.ui.toast('圧縮前のメモを渡し直しました（/compact-memo で見られます）', { timeoutMs: 8000 })

    return { ...done, messages: [...done.messages, { role: 'user' as const, text, toolUses: [] }] }
  })
}
