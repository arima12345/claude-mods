import type { EngineInterface, Register, SessionCompactInput } from 'claude-code'

import type { CompactionRecord, GoalSlice, LogSlice, MemoRecord, TaskSlice } from '../types'
import { buildMemo, parseGitStatus, recentRequests, withInstruction, type Gathered } from './memo'

const MEMOS = 'memos'
const COMPACTIONS = 'compactions'
const KEEP_MEMOS = 5
const KEEP_COMPACTIONS = 20

const TRIGGER_WORD: Record<string, string> = { manual: '手動', auto: '自動', plugin: 'mod', precompute: '事前' }

// Other mods' state: read when installed, empty when not.
async function readOthers($: EngineInterface): Promise<{ goal: GoalSlice; tasks: TaskSlice[]; log: LogSlice[] }> {
  const goal = await $.state.get({ plugin: 'goal2', key: 'goal' } as const).then(r => r.value ?? null, () => null)
  const progress = await $.state.get({ plugin: 'progress-panel', key: 'progress' } as const).then(r => r.value, () => undefined)
  const log = await $.state.get({ plugin: 'progress-panel', key: 'log' } as const).then(r => r.value ?? [], () => [])

  return { goal, tasks: progress?.tasks ?? [], log }
}

// `undefined` when git cannot say (no repository, no git): the work log stands in.
async function gitStatus($: EngineInterface): Promise<string[] | undefined> {
  const run = await $.process.run(['git', 'status', '--short'], { timeoutMs: 5000 }).catch(() => undefined)

  return run && run.exitCode === 0 ? parseGitStatus(run.stdout) : undefined
}

async function gather($: EngineInterface, e: SessionCompactInput): Promise<Gathered> {
  const others = await readOthers($)

  return { ...others, requests: recentRequests(e.messages), gitStatus: await gitStatus($) }
}

async function keep<T>($: EngineInterface, key: string, item: T, max: number): Promise<void> {
  const list = ((await $.store.get(key)) ?? []) as T[]
  await $.store.set(key, [...list, item].slice(-max))
}

const pad = (n: number) => String(n).padStart(2, '0')
function when(ms: number): string {
  const d = new Date(ms)

  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${pad(d.getMinutes())}`
}

export function report(memos: MemoRecord[], compactions: CompactionRecord[]): string {
  const lines: string[] = []
  const last = memos.at(-1)
  lines.push(last ? `## 直近の退避メモ（${when(last.at)}・${TRIGGER_WORD[last.trigger] ?? last.trigger}）\n\n${last.text}` : 'まだ退避メモはありません（このセッションより前も含めて、圧縮が起きていません）。')
  if (compactions.length > 0) {
    lines.push('', '## 圧縮の記録（新しい順）')
    for (const c of [...compactions].reverse()) {
      const fill = c.percent !== undefined ? `文脈 ${c.percent}%` : '文脈 —'
      const size = c.tokens !== undefined ? `（約 ${Math.round(c.tokens / 1000)}k / ${Math.round(c.window / 1000)}k）` : ''
      lines.push(`- ${when(c.at)} ${TRIGGER_WORD[c.trigger] ?? c.trigger}: ${fill}${size}`)
    }
  }

  return lines.join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'compact-memo', description: '直近の圧縮前の退避メモと、圧縮の記録を見る' })

    return next(e)
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
    // Gathered before the summary runs, so the memo holds the moment it replaces.
    const gathered = isFinal ? await gather($, e).catch(() => undefined) : undefined
    const at = await $.clock.now()
    if (isFinal) {
      const { context } = await $.session.usage().catch(() => ({ context: undefined }))
      const record: CompactionRecord = { at, trigger: e.trigger, percent: context?.percent, tokens: context?.tokens, window: context?.window ?? 0 }
      await keep($, COMPACTIONS, record, KEEP_COMPACTIONS).catch(() => {})
    }

    const done = await next({ ...e, instructions: withInstruction(e.instructions) })
    if (!isFinal || !gathered || !done.messages) return done

    const text = buildMemo(gathered)
    await keep<MemoRecord>($, MEMOS, { at, trigger: e.trigger, text }, KEEP_MEMOS).catch(() => {})
    $.ui.toast('圧縮前のメモを渡し直しました（/compact-memo で見られます）', { timeoutMs: 8000 })

    return { ...done, messages: [...done.messages, { role: 'user' as const, text, toolUses: [] }] }
  })
}
