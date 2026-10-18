import type { LogEntry, Outcome, SubAgent } from '../types'
import { clockTime } from './usage'

const MAX_LOG = 200
const MAX_AGENTS = 20

// --- Subagents ---

export function agentStarted(agents: SubAgent[], agent: Omit<SubAgent, 'endedAt'>): SubAgent[] {
  return [...agents.filter(a => a.id !== agent.id), { ...agent, endedAt: 0 }].slice(-MAX_AGENTS)
}

export function agentResumed(agents: SubAgent[], id: string, t: number): SubAgent[] {
  return agents.map(a => (a.id === id && a.endedAt > 0 ? { ...a, startedAt: t, endedAt: 0 } : a))
}

export function agentEnded(agents: SubAgent[], id: string, t: number): SubAgent[] {
  return agents.map(a => (a.id === id && a.endedAt === 0 ? { ...a, endedAt: t } : a))
}

// A new request clears the subagents that finished; those still running stay.
export function agentsForNewTurn(agents: SubAgent[]): SubAgent[] {
  return agents.filter(a => a.endedAt === 0)
}

export const running = (agents: SubAgent[]) => agents.filter(a => a.endedAt === 0).length

// --- Commands ---

const TESTS = [
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/,
  /\b(vitest|jest|mocha|ava|playwright\s+test)\b/,
  /\bpytest\b|\bpython3?\s+-m\s+(pytest|unittest)\b/,
  /\b(cargo|go|dotnet|deno|swift|mix|flutter)\s+test\b/,
  /\b(mvn|gradlew?|\.\/gradlew)\s+\S*test\b/i,
  /\bclaude\s+plugin\s+test\b/,
  /\brspec\b|\bphpunit\b/,
]

const CHECKS = [
  /\btsc\b/,
  /\b(eslint|biome|oxlint|prettier\s+--check|ruff|mypy|pyright|flake8|clippy|golangci-lint)\b/,
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(lint|typecheck|type-check|check|build)\b/,
  /\bclaude\s+plugin\s+validate\b/,
]

export function classify(command: string): 'test' | 'check' | undefined {
  if (TESTS.some(re => re.test(command))) return 'test'
  if (CHECKS.some(re => re.test(command))) return 'check'

  return undefined
}

// Only the first line, cut short, with anything that looks like a secret replaced.
export function maskCommand(command: string): string {
  const first = (command.trim().split('\n')[0] ?? '').trim()
  const masked = first
    .replace(/\bBearer\s+\S+/gi, 'Bearer ***')
    .replace(/((?:token|secret|password|passwd|api[-_]?key|auth)[\w-]*\s*[=:]\s*)(?!Bearer\b)("[^"]*"|'[^']*'|\S+)/gi, '$1***')
    .replace(/\b(?:sk|ghp|gho|ghs|github_pat|xox[abps])[-_][A-Za-z0-9_-]{8,}/g, '***')
    .replace(/[A-Za-z0-9+/_-]{32,}/g, '***')

  return masked.length > 80 ? `${masked.slice(0, 79)}…` : masked
}

// `git commit` prints "[branch abc1234] subject"; a root commit adds "(root-commit)".
export function parseCommit(stdout: string): { hash: string; subject: string } | undefined {
  const m = /^\[[^\]\s]+(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.+)$/m.exec(stdout)

  return m?.[1] && m[2] ? { hash: m[1], subject: m[2].trim() } : undefined
}

export const isCommit = (command: string) => /\bgit\b[^|;&]*\bcommit\b/.test(command)

type Ran = { isError?: boolean; result?: unknown }

export function outcomeOf(ran: Ran): Outcome {
  const result = (ran.result ?? {}) as { interrupted?: unknown; backgroundTaskId?: unknown }
  if (typeof result.backgroundTaskId === 'string') return 'background'
  if (result.interrupted === true) return 'interrupted'

  return ran.isError ? 'fail' : 'pass'
}

// --- Log ---

export function addEntry(log: LogEntry[], entry: LogEntry): LogEntry[] {
  const last = log.at(-1)
  if (entry.kind === 'edit' && last?.kind === 'edit' && last.path === entry.path && last.agent === entry.agent) {
    return [...log.slice(0, -1), { ...last, t: entry.t, count: last.count + entry.count }]
  }

  return [...log, entry].slice(-MAX_LOG)
}

export const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path

// Whether the turn that began at `since` reached a break in the work:
// the task list all done, a commit, or a test or check passing that had failed.
export function isBreak(log: LogEntry[], since: number, tasks: { status: string }[]): boolean {
  if (tasks.length > 0 && tasks.every(t => t.status === 'completed')) return true
  const failed = new Set<string>()
  for (const e of log) {
    if (e.t >= since && e.kind === 'commit') return true
    if (e.kind !== 'test' && e.kind !== 'check') continue
    if (e.outcome === 'fail') failed.add(e.command)
    if (e.outcome !== 'pass') continue
    if (e.t >= since && failed.has(e.command)) return true
    failed.delete(e.command)
  }

  return false
}

const OUTCOME_MARK: Record<Outcome, string> = { pass: '✓', fail: '✗', interrupted: '中断', background: '…' }
const OUTCOME_WORD: Record<Outcome, string> = { pass: '成功', fail: '失敗', interrupted: '中断', background: 'バックグラウンド' }
const KIND_WORD = { test: 'テスト', check: 'チェック' } as const

// One entry as a line; `full` keeps the whole path, for /worklog.
export function entryLine(entry: LogEntry, full = false): string {
  const who = entry.agent ? `［${entry.agent}］` : ''
  const at = clockTime(entry.t)
  switch (entry.kind) {
    case 'edit':
      return `${at} ${who}編集 ${full ? entry.path : basename(entry.path)}${entry.count > 1 ? ` ×${entry.count}` : ''}`
    case 'commit':
      return `${at} ${who}コミット ${entry.hash.slice(0, 7)} ${entry.subject}`
    default:
      return full
        ? `${at} ${who}${KIND_WORD[entry.kind]} ${OUTCOME_WORD[entry.outcome]}: \`${entry.command}\``
        : `${at} ${who}${OUTCOME_MARK[entry.outcome]} ${KIND_WORD[entry.kind]} ${entry.command}`
  }
}

// The handoff draft: the timeline, then what it adds up to.
export function worklogMarkdown(log: LogEntry[]): string {
  if (log.length === 0) return '作業ログはまだありません（このセッションでファイルの編集・テスト・コミットをしていません）。'

  const files = [...new Set(log.flatMap(e => (e.kind === 'edit' ? [e.path] : [])))]
  const lastRun = new Map<string, LogEntry & { kind: 'test' | 'check' }>()
  for (const e of log) if (e.kind === 'test' || e.kind === 'check') lastRun.set(e.command, e)
  const commits = log.flatMap(e => (e.kind === 'commit' ? [e] : []))

  const lines = ['## 作業ログ（このセッション）', '', '### 時系列', ...log.map(e => `- ${entryLine(e, true)}`)]
  if (files.length > 0) lines.push('', '### 変更したファイル', ...files.map(f => `- ${f}`))
  if (lastRun.size > 0) {
    lines.push('', '### テスト・チェックの最後の結果')
    for (const e of lastRun.values()) lines.push(`- ${OUTCOME_WORD[e.outcome]}: \`${e.command}\`（${clockTime(e.t)}）`)
  }
  if (commits.length > 0) lines.push('', '### コミット', ...commits.map(c => `- ${c.hash.slice(0, 7)} ${c.subject}`))
  lines.push(
    '',
    '※ Edit・Write による編集と、テスト・チェック・コミットのコマンドだけを記録しています。シェルコマンドで書き換えたファイル、ユーザー自身の編集、バックグラウンドで実行したテストの結果は含みません。正確な変更内容は git で確かめてください。',
  )

  return lines.join('\n')
}
