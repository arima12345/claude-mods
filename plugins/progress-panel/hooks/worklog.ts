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

// Each pattern reads a command from its start: `rg pytest src` searches, and `cat jest.config.js` reads.
const TESTS = [
  /^(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/,
  /^(vitest|jest|mocha|ava)\b/,
  /^playwright\s+test\b/,
  /^pytest\b/,
  /^python3?\s+-m\s+(pytest|unittest)\b/,
  /^(cargo|go|dotnet|deno|swift|mix|flutter)\s+test\b/,
  /^(mvn|gradlew?|\.[\\/]gradlew)\s+\S*test\b/i,
  /^claude\s+plugin\s+test\b/,
  /^(rspec|phpunit)\b/,
]

const CHECKS = [
  /^tsc\b/,
  /^(eslint|biome|oxlint|ruff|mypy|pyright|flake8|golangci-lint)\b/,
  /^python3?\s+-m\s+(mypy|ruff|pyright|flake8)\b/,
  /^prettier\b.*\s--check\b/,
  /^cargo\s+clippy\b/,
  /^(npm|pnpm|yarn|bun)\s+(run\s+)?(lint|typecheck|type-check|check|build)\b/,
  /^claude\s+plugin\s+validate\b/,
]

// What may stand before the command itself: variables, and the runners that only start it.
const LEADS = /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)|env|sudo|time|npx|bunx|cross-env|pnpm\s+(?:exec|dlx)|yarn\s+dlx|uv\s+run|poetry\s+run|bundle\s+exec)\s+)*/

// The commands a line runs, one per `&&`, `||`, `;`, `|` or line, each without what leads it.
function commandsIn(line: string): string[] {
  return line.split(/&&|\|\||[;|\n]/).map(part => part.trim().replace(LEADS, ''))
}

export function classify(command: string): 'test' | 'check' | undefined {
  // A commit's message may well say "test": the commit is logged as one, never as a run.
  const parts = commandsIn(command).filter(part => !isCommit(part))
  if (parts.some(part => TESTS.some(re => re.test(part)))) return 'test'
  if (parts.some(part => CHECKS.some(re => re.test(part)))) return 'check'

  return undefined
}

// Only the first line, cut short, with anything that looks like a secret replaced.
export function maskCommand(command: string): string {
  const first = (command.trim().split('\n')[0] ?? '').trim()
  const masked = first
    // user:password in a URL: postgres://alice:hunter2@host, https://alice:pw@github.com
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1***@')
    // A header's credential, whatever its scheme: Authorization: Basic dXNl…
    .replace(/(\bAuthorization\s*:\s*)((?:Basic|Bearer|Token|Digest|Negotiate)\s+)?[^\s"']+/gi, '$1$2***')
    .replace(/\bBearer\s+(?!\*\*\*)[^\s"']+/gi, 'Bearer ***')
    // curl -u alice:pw, --user alice:pw
    .replace(/((?:^|\s)(?:-u|--user)\s+)[^\s:]+:\S+/g, '$1***')
    .replace(/((?:token|secret|password|passwd|api[-_]?key|auth)[\w-]*\s*[=:]\s*)(?!(?:Basic|Bearer|Token|Digest|Negotiate)\b|\*\*\*)("[^"]*"|'[^']*'|\S+)/gi, '$1***')
    // The same flags with the value after a space: --password hunter2, --token abc
    .replace(/(--?[\w-]*(?:token|secret|password|passwd|api[-_]?key)\s+)(?!-)("[^"]*"|'[^']*'|\S+)/gi, '$1***')
    .replace(/\b(?:sk|ghp|gho|ghs|ghu|github_pat|glpat|xox[abps])[-_][A-Za-z0-9_-]{8,}/g, '***')
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '***')
    .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, '***')
    // A long run of letters and digits, as keys and hashes are. A path has slashes, and a
    // name like test_payment_gateway_flow has no digits: both are kept, so two tests stay two.
    .replace(/[A-Za-z0-9+=_-]{32,}/g, run => (/^[A-Za-z0-9]+$/.test(run) || (/\d/.test(run) && /[A-Za-z]/.test(run)) ? '***' : run))

  return masked.length > 80 ? `${masked.slice(0, 79)}…` : masked
}

// `git commit` prints "[branch abc1234] subject": a root commit adds "(root-commit)" after the
// branch, and a commit off any branch (a rebase, a detached checkout) says "[detached HEAD abc1234]".
export function parseCommit(stdout: string): { hash: string; subject: string } | undefined {
  const m = /^\[[^\]\n]+? ([0-9a-f]{7,40})\] (.+)$/m.exec(stdout)

  return m?.[1] && m[2] ? { hash: m[1], subject: m[2].trim() } : undefined
}

export const isCommit = (command: string) => /\bgit\b[^|;&]*\bcommit\b/.test(command)

const unquote = (word: string) => word.replace(/^(["'])(.*)\1$/, '$2')
// Git Bash spells C:\x as /c/x, which git for Windows does not read back.
const native = (dir: string) => dir.replace(/^\/([a-zA-Z])(?=\/|$)/, (_, drive: string) => `${drive.toUpperCase()}:`)

// Where a commit ran, read from its command: `git -C <dir>`, or else the last `cd` before it
// (`Set-Location`, `pushd` too). Undefined for the shell's own directory.
export function commitDir(command: string): string | undefined {
  const at = /\bgit\b[^|;&]*\bcommit\b/.exec(command)
  if (!at) return undefined
  const dashC = /\bgit\s+(?:\S+\s+)*?-C\s+("[^"]*"|'[^']*'|\S+)/.exec(at[0])
  if (dashC?.[1]) return native(unquote(dashC[1]))
  const moves = [...command.slice(0, at.index).matchAll(/(?:^|[;&|]\s*)(?:cd|Set-Location|pushd|Push-Location)\s+(?:\/d\s+)?("[^"]*"|'[^']*'|[^\s;&|]+)/gi)]
  const last = moves.at(-1)?.[1]

  return last ? native(unquote(last)) : undefined
}

// `git log -1 --format=%h%x09%ct%x09%s`: the hash, the commit time (ms) and the subject.
export function parseHead(stdout: string): { hash: string; at: number; subject: string } | undefined {
  const m = /^([0-9a-f]{7,40})\t(\d+)\t(.*)$/m.exec(stdout)

  return m?.[1] && m[2] && m[3] !== undefined ? { hash: m[1], at: Number(m[2]) * 1000, subject: m[3].trim() } : undefined
}

type Ran = { isError?: boolean; result?: unknown; text?: string }

// An interrupted call comes back as an error whose result is only its text, never the tool's record:
// the engine's own notice, read from its start so a failing test that mentions "interrupted" stays a failure.
const INTERRUPTED = /^\s*\[Request interrupted by user\b/

export function outcomeOf(ran: Ran): Outcome {
  const result = (typeof ran.result === 'object' && ran.result !== null ? ran.result : {}) as { interrupted?: unknown; backgroundTaskId?: unknown }
  if (typeof result.backgroundTaskId === 'string') return 'background'
  if (result.interrupted === true) return 'interrupted'
  if (ran.isError && [ran.text, ran.result].some(s => typeof s === 'string' && INTERRUPTED.test(s))) return 'interrupted'

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
