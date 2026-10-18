import type { GoalSlice, LogSlice, TaskSlice } from '../types'

export const SUMMARY_INSTRUCTION =
  'ユーザーと合意した決定事項、却下した案とその理由、未解決の問題は、省略せず箇条書きで残すこと。'

// The person's own words for the summary come first; ours follow.
export function withInstruction(instructions: string | undefined): string {
  const own = instructions?.trim()

  return own ? `${own}\n\n${SUMMARY_INSTRUCTION}` : SUMMARY_INSTRUCTION
}

type Message = { role: 'user' | 'assistant'; text: string; toolResults?: readonly unknown[] }

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

// The last few things the person asked for; tool results, reminders and commands are not requests.
export function recentRequests(messages: readonly Message[], count = 3): string[] {
  return messages
    .filter(m => m.role === 'user' && !(m.toolResults && m.toolResults.length > 0))
    .map(m => m.text.trim())
    .filter(text => text !== '' && !text.startsWith('<'))
    .slice(-count)
    .map(text => cut(text.replace(/\s+/g, ' '), 200))
}

// Commands whose last run failed, in the order they last ran.
export function failingChecks(log: readonly LogSlice[]): string[] {
  const last = new Map<string, string>()
  for (const e of log) {
    if ((e.kind === 'test' || e.kind === 'check') && e.command) {
      last.delete(e.command)
      last.set(e.command, e.outcome ?? '')
    }
  }

  return [...last].filter(([, outcome]) => outcome === 'fail').map(([command]) => command)
}

export type Gathered = {
  goal: GoalSlice
  requests: string[]
  tasks: TaskSlice[]
  gitStatus: string[] | undefined
  log: LogSlice[]
}

const MAX_MEMO = 6000
const MAX_LINE = 200
const MARK: Record<string, string> = { in_progress: '▶', pending: '・' }

// A heading and its lines, at most `max` of them, the rest counted.
function section(title: string, lines: string[], max: number): string[] {
  const shown = lines.slice(0, max).map(l => cut(l, MAX_LINE))
  const more = lines.length - shown.length

  return [title, ...shown, ...(more > 0 ? [`（ほか ${more} 件）`] : [])]
}

export function buildMemo(g: Gathered): string {
  const sections: string[][] = []

  const goal = g.goal?.condition.trim()
  if (g.goal && goal) sections.push([`## いまのゴール（goal2${g.goal.status === 'paused' ? '・一時停止中' : ''}）`, cut(goal, 1000)])
  else if (g.requests.length > 0) sections.push(section('## 直近の依頼', g.requests.map(r => `- ${r}`), 3))

  const open = g.tasks.filter(t => t.status !== 'completed')
  if (open.length > 0) sections.push(section('## やることリストの残り', open.map(t => `${MARK[t.status] ?? '・'} ${t.title}`), 30))

  if (g.gitStatus && g.gitStatus.length > 0) {
    sections.push(section('## 変更中のファイル（git status）', g.gitStatus, 40))
  } else if (g.gitStatus === undefined) {
    const edited = [...new Set(g.log.flatMap(e => (e.kind === 'edit' && e.path ? [e.path] : [])))]
    if (edited.length > 0) sections.push(section('## このセッションで編集したファイル', edited.map(p => `- ${p}`), 40))
  }

  const commits = g.log.filter(e => e.kind === 'commit' && e.hash)
  if (commits.length > 0) sections.push(section('## このセッションのコミット', commits.map(c => `- ${(c.hash ?? '').slice(0, 7)} ${c.subject ?? ''}`), 20))

  const failing = failingChecks(g.log)
  if (failing.length > 0) sections.push(section('## 未解決の問題', failing.map(c => `- 失敗したままのテスト・チェック: \`${c}\``), 10))

  const head = [
    '【圧縮前の退避メモ（compact-memo が自動で追加）】',
    '会話が圧縮されたため、圧縮直前の状況を残します。要約と食い違う場合は、このメモと実際のファイル・git を優先して確かめてください。',
  ]
  if (sections.length === 0) head.push('', '（残すべき状況は見つかりませんでした）')

  // Still past the limit: the section with the most text gives up lines, so every heading keeps some.
  const render = (isCut: boolean) => [...head, ...sections.flatMap(s => ['', ...s]), ...(isCut ? ['', '（長すぎるため一部を省きました）'] : [])].join('\n')
  const size = (s: string[]) => s.join('\n').length
  let text = render(false)
  while (text.length > MAX_MEMO) {
    const longest = sections.reduce((a, b) => (size(b) > size(a) ? b : a), sections[0] ?? [])
    if (longest.length <= 2) break
    longest.splice(-1, 1)
    text = render(true)
  }

  return cut(text, MAX_MEMO)
}

export function parseGitStatus(stdout: string): string[] {
  return stdout.split('\n').map(l => l.trimEnd()).filter(l => l !== '')
}
