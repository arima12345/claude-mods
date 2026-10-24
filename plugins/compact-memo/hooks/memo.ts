import type { GoalSlice, LogSlice, TaskSlice } from '../types'

export const SUMMARY_INSTRUCTION =
  'ユーザーと合意した決定事項、却下した案とその理由、未解決の問題は、省略せず箇条書きで残すこと。'

// The person's own words for the summary come first; ours follow.
export function withInstruction(instructions: string | undefined): string {
  const own = instructions?.trim()

  return own ? `${own}\n\n${SUMMARY_INSTRUCTION}` : SUMMARY_INSTRUCTION
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

// Whether the last test or check of the session failed. Earlier failures fixed since say nothing.
export function isLastCheckFailing(log: readonly LogSlice[]): boolean {
  const last = [...log].reverse().find(e => e.kind === 'test' || e.kind === 'check')

  return last?.outcome === 'fail'
}

// What only this moment knows and Claude cannot look up again; files and commands it can.
export type Gathered = {
  label: string
  at: string
  goal: GoalSlice
  tasks: TaskSlice[]
  branch: string | undefined
  log: LogSlice[]
}

const MAX_MEMO = 6000
const MAX_LINE = 200
const MAX_TASKS = 30
const MAX_COMMITS = 5
const MARK: Record<string, string> = { in_progress: '▶', pending: '・' }

// A heading and its lines, at most `max` of them, the rest counted.
function section(title: string, lines: string[], max: number): string[] {
  const shown = lines.slice(0, max).map(l => cut(l, MAX_LINE))
  const more = lines.length - shown.length

  return [title, ...shown, ...(more > 0 ? [`（ほか ${more} 件）`] : [])]
}

// The memo, or `undefined` when there is nothing worth handing back: a branch name alone is no help.
export function buildMemo(g: Gathered): string | undefined {
  const goal = g.goal?.condition.trim()
  const open = g.tasks.filter(t => t.status !== 'completed')
  const commits = g.log.filter(e => e.kind === 'commit' && e.hash).slice(-MAX_COMMITS).reverse()
  const isFailing = isLastCheckFailing(g.log)
  if (!goal && open.length === 0 && commits.length === 0 && !isFailing) return undefined

  const sections: string[][] = []
  if (g.goal && goal) sections.push([`## いまのゴール（goal2${g.goal.status === 'paused' ? '・一時停止中' : ''}）`, cut(goal, 1000)])
  if (open.length > 0) sections.push(section('## やることリストの残り', open.map(t => `${MARK[t.status] ?? '・'} ${t.title}`), MAX_TASKS))
  if (g.branch) sections.push(['## いまのブランチ', g.branch])
  if (commits.length > 0) sections.push(['## このセッションのコミット（新しい5件）', ...commits.map(c => cut(`- ${(c.hash ?? '').slice(0, 7)} ${c.subject ?? ''}`, MAX_LINE))])
  if (isFailing) sections.push(['## 気をつけること', '- 最後に実行したテスト・チェックが失敗のままです'])

  const where = [g.label, g.at].filter(Boolean).join('・')
  const head = [
    '【圧縮前の退避メモ（compact-memo が自動で追加）】',
    `${where ? `${where} の` : ''}圧縮の直前の状況です。要約と食い違う場合は、このメモと実際のファイル・git を優先して確かめてください。変更中のファイルは git status で確かめてください。`,
  ]

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
