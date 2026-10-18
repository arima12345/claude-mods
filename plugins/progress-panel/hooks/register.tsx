import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMeasureInput, Timer, ToolCallInput, ToolCallResult } from 'claude-code'

import type { Limit, LogEntry, Progress, SubAgent, Task, Usage } from '../types'
import {
  LIMIT_LEVELS,
  addSample,
  clockTime,
  contextLines,
  contextStep,
  contextToast,
  contextToastMs,
  VALVE_FROM,
  breakStep,
  breakToast,
  valveStep,
  valveToast,
  emptyUsage,
  fiveHourPace,
  levelOf,
  limitLines,
  limitToast,
  meter,
  nextHistory,
  ordered,
  paceToast,
  usageStatus,
  weeklyPace,
  windowKey,
  type LimitNotice,
} from './usage'
import {
  addEntry,
  agentEnded,
  agentResumed,
  agentStarted,
  agentsForNewTurn,
  classify,
  entryLine,
  isBreak,
  isCommit,
  maskCommand,
  outcomeOf,
  parseCommit,
  running,
  worklogMarkdown,
} from './worklog'

const PANE = 'progress-panel'
const TITLE = 'Claudeの進捗'

const empty: Progress = {
  isWorking: false,
  startedAt: 0,
  endedAt: 0,
  action: '',
  tools: 0,
  tasks: [],
}
const progress = atom({ plugin: 'progress-panel', key: 'progress' } as const, empty)
const now = atom({ plugin: 'progress-panel', key: 'now' } as const, 0)
const usage = atom({ plugin: 'progress-panel', key: 'usage' } as const, emptyUsage)
const agents = atom({ plugin: 'progress-panel', key: 'agents' } as const, [] as SubAgent[])
const log = atom({ plugin: 'progress-panel', key: 'log' } as const, [] as LogEntry[])

// The work log's latest lines the pane shows; /worklog has them all.
const LOG_ROWS = 5

// Kept in $.store so a window is announced once, whichever session sees it first.
const NOTICES = 'limitNotices'

// Tool names the model uses, said the way a person would.
const ACTIONS: Record<string, string> = {
  Bash: 'コマンドを実行中',
  Read: 'ファイルを読んでいる',
  Write: 'ファイルを書いている',
  Edit: 'ファイルを書き換えている',
  NotebookEdit: 'ノートを書き換えている',
  Grep: 'ファイルの中を検索中',
  Glob: 'ファイルを探している',
  WebSearch: 'Webで調べている',
  WebFetch: 'Webページを読んでいる',
  Agent: '手分けして作業中',
  Skill: 'スキルを読み込み中',
  TodoWrite: 'やることリストを更新中',
  TaskCreate: 'やることを追加中',
  TaskUpdate: 'やることを更新中',
}

// MCP tools the desktop app and browsers bring, by `<server>__<tool>` or by server.
const MCP_ACTIONS: Record<string, string> = {
  ccd_turn__update_plan: 'やることリストを更新中',
  ccd_turn__wrap_up: 'まとめを書いている',
  Claude_Browser: 'ブラウザを操作中',
  'claude-in-chrome': 'ブラウザを操作中',
  playwright: 'ブラウザを操作中',
  'computer-use': '画面を操作中',
}

// Claude.ai connectors are served under an id, which says nothing to a person.
const SERVER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function describe(tool: string): string {
  if (ACTIONS[tool]) return ACTIONS[tool]
  if (tool.startsWith('mcp__')) {
    const [, server = '', ...rest] = tool.split('__')
    const name = rest.join('__')
    const known = MCP_ACTIONS[`${server}__${name}`] ?? MCP_ACTIONS[server]
    if (known) return known

    return `外部ツールを使用中（${SERVER_ID.test(server) ? name : server}）`
  }

  return `${tool} を使用中`
}

// The desktop app keeps its task list through these instead of TodoWrite.
const PLAN_TOOL = 'mcp__ccd_turn__update_plan'
const WRAP_UP_TOOL = 'mcp__ccd_turn__wrap_up'

type PlanCall = { items?: unknown; advance?: unknown; done?: unknown; start?: unknown }

// A whole new list, or steps moved by their 1-based place.
export function applyPlan(tasks: Task[], call: PlanCall): Task[] {
  let next = tasks
  if (Array.isArray(call.items)) {
    next = call.items.map((item, i): Task => {
      const { content, status } = (item ?? {}) as { content?: unknown; status?: unknown }

      return { id: String(i), title: String(content ?? ''), status: status === 'completed' || status === 'in_progress' ? status : 'pending' }
    })
  }
  if (call.advance === true) {
    const at = next.findIndex(t => t.status === 'in_progress')
    const after = next.findIndex((t, i) => i > at && t.status === 'pending')
    next = next.map((t, i): Task => (i === at ? { ...t, status: 'completed' } : i === after ? { ...t, status: 'in_progress' } : t))
  }
  if (Array.isArray(call.done)) {
    const done = new Set(call.done.map(Number))
    next = next.map((t, i): Task => (done.has(i + 1) ? { ...t, status: 'completed' } : t))
  }
  if (typeof call.start === 'number') {
    const start = call.start
    next = next.map((t, i): Task => (i + 1 === start ? { ...t, status: 'in_progress' } : t))
  }

  return next
}

// The wrap-up checks off the step still being worked on.
export function wrapUp(tasks: Task[]): Task[] {
  return tasks.map((t): Task => (t.status === 'in_progress' ? { ...t, status: 'completed' } : t))
}

// A list finished in an earlier turn belongs to that request: the next one starts empty.
export function carryOver(tasks: Task[]): Task[] {
  return tasks.length > 0 && tasks.every(t => t.status === 'completed') ? [] : tasks
}

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)

  return m > 0 ? `${m}分${s % 60}秒` : `${s}秒`
}

export function bar(done: number, total: number, width = 10): string {
  const filled = total === 0 ? 0 : Math.round((done / total) * width)

  return '■'.repeat(filled) + '□'.repeat(width - filled)
}

const MARKS = { completed: '✓', in_progress: '▶', pending: '・' } as const

function summary(p: Progress, subagents = 0): string {
  const done = p.tasks.filter(t => t.status === 'completed').length
  const tasks = p.tasks.length > 0 ? ` ${done}/${p.tasks.length}` : ''
  const subs = subagents > 0 ? `・サブ ${subagents}` : ''

  return p.isWorking ? `作業中${tasks}・${p.action || '考え中'}${subs}` : `待機中${tasks}${subs}`
}

async function refreshStatus($: EngineInterface): Promise<void> {
  const meter = usageStatus(await read($, usage), await $.clock.now())
  const line = summary(await read($, progress), running(await read($, agents)))
  $.ui.status(meter ? `${line} ｜ ${meter}` : line)
}

const SHELLS = new Set(['Bash', 'PowerShell'])
const EDITS = new Set(['Edit', 'Write', 'NotebookEdit'])

// Edits, tests, checks and commits, as the handoff needs them; a failed edit changed nothing.
async function noteLog($: EngineInterface, e: Call, ran: Ran): Promise<void> {
  if (ran.result === undefined) return
  const input = e as unknown as { command?: unknown; file_path?: unknown; notebook_path?: unknown; agentId?: unknown }
  const t = await $.clock.now()
  const agentId = typeof input.agentId === 'string' ? input.agentId : undefined
  const agent = agentId ? ((await read($, agents)).find(a => a.id === agentId)?.type ?? 'サブ') : undefined
  const entries: LogEntry[] = []

  if (EDITS.has(e.tool) && !ran.isError) {
    const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : ''
    if (path) entries.push({ kind: 'edit', t, path, count: 1, agent })
  }
  if (SHELLS.has(e.tool) && typeof input.command === 'string') {
    const kind = classify(input.command)
    if (kind) entries.push({ kind, t, command: maskCommand(input.command), outcome: outcomeOf(ran), agent })
    const stdout = (ran.result as { stdout?: unknown }).stdout
    const commit = !ran.isError && isCommit(input.command) && typeof stdout === 'string' ? parseCommit(stdout) : undefined
    if (commit) entries.push({ kind: 'commit', t, ...commit, agent })
  }
  if (entries.length > 0) await update($, log, l => entries.reduce(addEntry, l))
}

type Measured = Pick<SessionMeasureInput, 'context' | 'rateLimits'>

async function noteMeasure($: EngineInterface, e: Measured): Promise<void> {
  const t = await $.clock.now()
  const before = await read($, usage)
  const limits = e.rateLimits.map((l): Limit => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt }))
  const samples: Usage['samples'] = {}
  const fast: Usage['fast'] = {}
  for (const limit of limits) {
    const kept = addSample(before.samples[limit.kind] ?? [], limit, t)
    samples[limit.kind] = kept
    const wasFast = before.fast[limit.kind] !== undefined
    if (limit.kind === 'five_hour') {
      const eta = fiveHourPace(kept, limit, t, wasFast)
      if (eta !== undefined) fast[limit.kind] = eta
    } else if (limit.kind === 'seven_day' && weeklyPace(limit, t, wasFast)) {
      fast[limit.kind] = 0
    }
  }

  const pct = e.context.percent
  const step = pct === undefined ? { level: before.contextLevel } : contextStep(pct, before.contextLevel)
  const valve = before.valve || (pct !== undefined && pct >= VALVE_FROM ? await readValve($) : 0)
  const last = valveStep(e.context.tokens, valve, before.isValveWarned ?? false)
  // Falling under 50% (a /compact) arms the break notice again; a break itself is judged at the turn's end.
  const breaks = breakStep(pct, false, before.breakNotified ?? 0)
  await update($, usage, () => ({
    measuredAt: limits.length > 0 ? t : before.measuredAt,
    limits,
    context: { percent: pct, tokens: e.context.tokens, window: e.context.window },
    samples,
    fast,
    contextHistory: pct === undefined ? before.contextHistory : nextHistory(before.contextHistory, pct),
    contextLevel: step.level,
    valve,
    isValveWarned: last.isWarned,
    breakNotified: breaks.notified,
  }))

  if (step.notify !== undefined) $.ui.toast(contextToast(step.notify), { timeoutMs: contextToastMs(step.notify) })
  if (last.warn !== undefined) $.ui.toast(valveToast(last.warn), { timeoutMs: 20_000 })
  await announceLimits($, limits, fast)
}

// Where automatic compaction starts: the window the context breakdown measures against,
// estimated locally (no API call). 0 when it cannot be read; the next measurement tries again.
async function readValve($: EngineInterface): Promise<number> {
  const u = await $.session.usage({ breakdown: 'summary' }).catch(() => undefined)

  return u?.context.breakdown?.rawMaxTokens ?? 0
}

// At the end of a main turn: a break in the work past 50% is a good moment to compact.
async function noteBreak($: EngineInterface): Promise<void> {
  const p = await read($, progress)
  const u = await read($, usage)
  const step = breakStep(u.context?.percent, isBreak(await read($, log), p.startedAt, p.tasks), u.breakNotified ?? 0)
  if (!step.notify) return
  await update($, usage, x => ({ ...x, breakNotified: step.notified }))
  $.ui.toast(breakToast(step.notified), { timeoutMs: 15_000 })
}

async function announceLimits($: EngineInterface, limits: Limit[], fast: Usage['fast']): Promise<void> {
  if (limits.length === 0) return
  const notices = { ...(((await $.store.get(NOTICES)) ?? {}) as Record<string, LimitNotice>) }
  let isChanged = false
  for (const limit of limits) {
    const key = windowKey(limit)
    const was = notices[limit.kind]
    const notice: LimitNotice = was && was.resetKey === key ? { ...was } : { resetKey: key, level: 0, isFastNotified: false }
    const level = levelOf(limit.percentUsed, LIMIT_LEVELS)
    if (level > notice.level) {
      const text = limitToast(limit, level)
      $.ui.toast(text, { timeoutMs: level >= 95 ? 20_000 : 8_000 })
      // The desktop app has no native channel: the toast and the status line's mark stand in there.
      if (level >= 95) void $.ui.notify(text, { title: '利用枠' }).catch(() => {})
      notice.level = level
    }
    const eta = fast[limit.kind]
    if (eta !== undefined && !notice.isFastNotified) {
      $.ui.toast(paceToast(limit, eta), { timeoutMs: 10_000 })
      notice.isFastNotified = true
    }
    if (JSON.stringify(was) !== JSON.stringify(notice)) {
      notices[limit.kind] = notice
      isChanged = true
    }
  }
  if (isChanged) await $.store.set(NOTICES, notices)
}

type Call = ToolCallInput
type Ran = ToolCallResult

async function noteStart($: EngineInterface, e: Call): Promise<void> {
  await update($, progress, p => ({ ...p, action: describe(e.tool), tools: p.tools + 1 }))

  if (e.tool === 'TodoWrite') {
    const tasks = e.todos.map((todo, i): Task => ({
      id: String(i),
      title: todo.status === 'in_progress' ? todo.activeForm || todo.content : todo.content,
      status: todo.status,
    }))
    await update($, progress, p => ({ ...p, tasks }))
  }

  await refreshStatus($)
}

async function noteEnd($: EngineInterface, e: Call, ran: Ran): Promise<void> {
  if (!ran.result || ran.isError) return

  if (e.tool === PLAN_TOOL) await update($, progress, p => ({ ...p, tasks: applyPlan(p.tasks, e as PlanCall) }))
  if (e.tool === WRAP_UP_TOOL) await update($, progress, p => ({ ...p, tasks: wrapUp(p.tasks) }))

  if (e.tool === 'TaskCreate') {
    const task = (ran.result as { task?: { id: string; subject: string } }).task
    if (task) {
      await update($, progress, p => ({
        ...p,
        tasks: [...p.tasks, { id: task.id, title: task.subject, status: 'pending' as const }],
      }))
    }
  }

  if (e.tool === 'TaskUpdate') {
    const { taskId, status, subject, activeForm } = e
    await update($, progress, p => ({
      ...p,
      tasks:
        status === 'deleted'
          ? p.tasks.filter(t => t.id !== taskId)
          : p.tasks.map((t): Task =>
              t.id !== taskId
                ? t
                : {
                    ...t,
                    status: status ?? t.status,
                    title: (status === 'in_progress' && activeForm) || subject || t.title,
                  },
            ),
    }))
  }

  await refreshStatus($)
}

export const register: Register = on => {
  let tick: Timer | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'progress',
      description: 'Claudeの進捗パネルを開く',
    })
    await $.command.register({
      name: 'worklog',
      description: 'このセッションの作業ログ（編集・テスト・コミット）を引き継ぎメモの下書きとして出す',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    // A resumed session already has figures: show them before the next response.
    void $.session
      .usage()
      .then(u => noteMeasure($, u))
      .then(() => refreshStatus($))
      .catch(() => {})

    return next(e)
  })

  // The panel only watches: a failure here never stands in the way of the measurement.
  on('session.measure', async ($, e, next) => {
    await noteMeasure($, e).catch(() => {})
    await refreshStatus($).catch(() => {})

    return next(e)
  })

  on('command.run', { command: 'progress' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: '進捗パネルを開きました。' }
  })

  on('command.run', { command: 'worklog' }, async $ => ({ text: worklogMarkdown(await read($, log)) }))

  // The panel only watches: a spawn goes ahead whatever happens here.
  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (!spawned.deny && spawned.agentId) {
      const id = spawned.agentId
      await $.clock
        .now()
        .then(t => update($, agents, list => agentStarted(list, { id, description: e.description, type: e.subagentType, startedAt: t })))
        .then(() => refreshStatus($))
        .catch(() => {})
    }

    return spawned
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId) {
      const id = e.agentId
      await $.clock
        .now()
        .then(t => update($, agents, list => agentResumed(list, id, t)))
        .then(() => refreshStatus($))
        .catch(() => {})

      return next(e)
    }
    const t = await $.clock.now()
    await update($, agents, agentsForNewTurn)
    await update($, now, () => t)
    await update($, progress, p => ({
      ...p,
      isWorking: true,
      startedAt: t,
      endedAt: 0,
      action: '考え中',
      tools: 0,
      tasks: carryOver(p.tasks),
    }))
    tick?.cancel()
    tick = $.clock.every(1000, () => {
      void $.clock.now().then(n => update($, now, () => n))
    })
    await refreshStatus($)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      const id = e.agentId
      await $.clock
        .now()
        .then(t => update($, agents, list => agentEnded(list, id, t)))
        .then(() => refreshStatus($))
        .catch(() => {})

      return next(e)
    }
    tick?.cancel()
    tick = undefined
    const t = await $.clock.now()
    const label =
      e.reason === 'answer' ? '返事を書き終えた' : e.reason === 'aborted' ? '中断された' : 'エラーで止まった'
    await update($, now, () => t)
    await update($, progress, p => ({ ...p, isWorking: false, endedAt: t, action: label }))
    await noteBreak($).catch(() => {})
    await refreshStatus($)

    return next(e)
  })

  // The panel only watches: a failure here never stands in the way of a tool call.
  on('tool.call', async ($, e, next) => {
    await noteStart($, e).catch(() => {})
    const ran = await next(e)
    await noteEnd($, e, ran).catch(() => {})
    await noteLog($, e, ran).catch(() => {})

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const p = await read($, progress)
    const n = await read($, now)
    const u = await read($, usage)
    const subs = await read($, agents)
    const entries = await read($, log)
    const ctx = u.context?.percent
    const done = p.tasks.filter(t => t.status === 'completed').length
    const time = p.isWorking ? elapsed(n - p.startedAt) : p.endedAt ? elapsed(p.endedAt - p.startedAt) : ''

    return (
      <Box flexDirection="column">
        <Text bold color={p.isWorking ? 'yellow' : 'green'}>
          {p.isWorking ? '● 作業中' : '○ 待機中（入力待ち）'}
        </Text>
        <Text>いま: {p.action || 'まだ何もしていません'}</Text>
        {time !== '' && (
          <Text dimColor>
            {p.isWorking ? '経過' : '前回かかった時間'}: {time}・ツール {p.tools} 回
          </Text>
        )}
        {u.limits.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>利用枠{u.measuredAt ? `（${clockTime(u.measuredAt)} 時点）` : ''}</Text>
            {ordered(u.limits).flatMap(l => limitLines(l, u.fast[l.kind], Math.max(n, u.measuredAt))).map(line => (
              <Text color={line.color} dimColor={line.isDim}>
                {line.text}
              </Text>
            ))}
          </Box>
        )}
        {u.context && ctx !== undefined && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color={ctx >= 60 ? 'red' : ctx >= 40 ? 'yellow' : undefined}>
              コンテキスト {ctx}% {meter(ctx)}
            </Text>
            {contextLines(u.context, u.contextHistory, u.valve).map(line => (
              <Text dimColor>{line}</Text>
            ))}
          </Box>
        )}
        {subs.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>サブエージェント（実行中 {running(subs)}）</Text>
            {subs.map(a => (
              <Text dimColor={a.endedAt > 0}>
                {a.endedAt > 0 ? '✓' : '▶'} {a.type}：{a.description} {elapsed((a.endedAt || Math.max(n, a.startedAt)) - a.startedAt)}
              </Text>
            ))}
          </Box>
        )}
        {entries.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>作業ログ{entries.length > LOG_ROWS ? `（全 ${entries.length} 件・/worklog で全件）` : ''}</Text>
            {entries.slice(-LOG_ROWS).map(entry => (
              <Text color={'outcome' in entry && entry.outcome === 'fail' ? 'red' : undefined} dimColor={entry.kind === 'edit'}>
                {entryLine(entry)}
              </Text>
            ))}
          </Box>
        )}
        {p.tasks.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>
              やること {bar(done, p.tasks.length)} {done}/{p.tasks.length}
            </Text>
            {p.tasks.map(t => (
              <Text dimColor={t.status === 'completed'} bold={t.status === 'in_progress'}>
                {MARKS[t.status]} {t.title}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
