import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMeasureInput, Timer, ToolCallInput, ToolCallResult } from 'claude-code'

import type { Limit, LogEntry, Others, Progress, SessionCard, SubAgent, Task, Usage } from '../types'
import {
  LIMIT_LEVELS,
  breakToast,
  clockTime,
  contextLines,
  contextToast,
  contextToastMs,
  emptyUsage,
  levelOf,
  limitLines,
  limitToast,
  measureStep,
  meter,
  needsValve,
  nextReset,
  noticeFor,
  ordered,
  paceToast,
  turnEndStep,
  usageStatus,
  valveOf,
  valveToast,
  type LimitNotice,
  type MeasureStep,
} from './usage'
import {
  CARD_PREFIX,
  HEARTBEAT_MS,
  POLL_MS,
  PRUNE_MS,
  PUBLISH_GAP_MS,
  activeAtOf,
  asCard,
  cardKey,
  cardOf,
  cardShape,
  folderOf,
  othersSection,
  othersStatus,
  requestLine,
  writtenAt,
} from './sessions'
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
const request = atom({ plugin: 'progress-panel', key: 'request' } as const, '')
const others = atom({ plugin: 'progress-panel', key: 'others' } as const, { at: 0, cards: [] } as Others)

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
  const t = await $.clock.now()
  const meter = usageStatus(await read($, usage), t)
  const line = summary(await read($, progress), running(await read($, agents)))
  const o = await read($, others)
  $.ui.status([line, othersStatus(o.cards, Math.max(t, o.at)), meter].filter(Boolean).join(' ｜ '))
}

// Sharing this session's state with the other sessions on the machine, and reading theirs.
// The module's own values, started over on reload.
let isInteractive = false
let isEnded = false
// Moved on at every end: a write begun before it must not put the old card back.
let epoch = 0
let branch = ''
let isBranchRead = false
let branchRead: Promise<void> | undefined
let lastShape = ''
let lastPublishedAt = 0
// When sharing began, for a session that has not worked yet.
let since = 0
let pending: Timer | undefined
let heartbeat: Timer | undefined
let poll: Timer | undefined

// A session someone watches shares: the REPL, or one a surface attached to (the desktop app,
// which drives its sessions through the SDK). A plain -p run draws nowhere and stays out.
async function isSharing($: EngineInterface): Promise<boolean> {
  if (isEnded) return false

  return isInteractive || (await $.session.surfaces()).length > 0
}

// Writes this session's card; a heartbeat writes it even when nothing changed.
// The folder and branch are the project's (`root`): a hook's `cwd` is a subagent's own, and a shell `cd` moves it.
async function publishNow($: EngineInterface, isHeartbeat = false, awaitBranch = false): Promise<void> {
  if (!(await isSharing($))) return
  const at = epoch
  if (!isBranchRead) {
    // Only the start waits for git; anywhere else the card goes now and again once the branch is known.
    if (awaitBranch) await refreshBranch($)
    else void refreshBranch($).then(() => schedulePublish($)).catch(() => {})
  }
  const t = await $.clock.now()
  if (since === 0) since = t
  const p = await read($, progress)
  const id = await $.session.id()
  const card = cardOf(p, {
    id,
    folder: folderOf(await projectRoot($)),
    branch,
    request: await read($, request),
    context: (await read($, usage)).context?.percent,
    updatedAt: t,
    activeAt: activeAtOf(p, since),
  })
  const shape = cardShape(card)
  if (!isHeartbeat && shape === lastShape) return
  // The session ended, or went on under a new id, while this card was being made.
  if (isEnded || at !== epoch) return
  lastShape = shape
  lastPublishedAt = t
  await $.store.set(cardKey(id), card)
  // An end that came while the write was on its way would find nothing to remove: take the card back.
  if (isEnded || at !== epoch) await $.store.delete(cardKey(id)).catch(() => {})
}

// Changes in a row are written once the gap has passed, the state as it stands then.
async function schedulePublish($: EngineInterface): Promise<void> {
  if (pending !== undefined) return
  const isOn = await isSharing($)
  const t = await $.clock.now()
  // Checked again after the waits: two calls at once must not both start a timer.
  if (!isOn || pending !== undefined) return
  const wait = lastPublishedAt + PUBLISH_GAP_MS - t
  if (wait <= 0) return publishNow($)
  pending = $.clock.after(wait, () => {
    pending = undefined
    void publishNow($).catch(() => {})
  })
}

// The project's folder; the session's own where a build cannot tell it.
async function projectRoot($: EngineInterface): Promise<string> {
  return $.session.root().catch(() => $.session.cwd())
}

// One read at a time; a read already on its way is joined.
function refreshBranch($: EngineInterface): Promise<void> {
  branchRead ??= readBranch($).finally(() => {
    branchRead = undefined
  })

  return branchRead
}

// The branch the project is on. A read that fails or times out keeps the last one known;
// a commit off any branch (a rebase, a detached checkout) shows as "ブランチ外" and its short hash.
async function readBranch($: EngineInterface): Promise<void> {
  const cwd = await projectRoot($)
  const git = (...args: string[]) => $.process.run(['git', ...args], { cwd, timeoutMs: 3000 }).catch(() => undefined)
  const ran = await git('rev-parse', '--abbrev-ref', 'HEAD')
  isBranchRead = true
  if (ran === undefined) return
  if (ran.exitCode !== 0) {
    if (/not a git repository/i.test(ran.stderr)) branch = ''

    return
  }
  const name = ran.stdout.trim()
  if (name !== 'HEAD') {
    branch = name

    return
  }
  const short = await git('rev-parse', '--short', 'HEAD')
  branch = short?.exitCode === 0 ? `ブランチ外 ${short.stdout.trim()}` : 'ブランチ外'
}

// The other sessions' cards; one left too long is removed by whoever reads it.
// An object this version cannot read as a card (another version's) is aged by its time, never removed
// unread; a value that is no object is no card of any version, and goes.
// The pane redraws when a card changed, or once a minute for the "4分前" it shows.
async function readOthers($: EngineInterface): Promise<void> {
  if (!(await isSharing($))) return
  const t = await $.clock.now()
  const own = await $.session.id()
  const cards: SessionCard[] = []
  for (const key of (await $.store.keys()).filter(k => k.startsWith(CARD_PREFIX))) {
    const value = await $.store.get(key)
    const card = asCard(value)
    const written = card?.updatedAt ?? writtenAt(value)
    const isJunk = typeof value !== 'object' || value === null
    if (isJunk || (written !== undefined && t - written >= PRUNE_MS)) {
      await $.store.delete(key).catch(() => {})
      continue
    }
    if (card !== undefined && card.id !== own) cards.push(card)
  }
  const was = await read($, others)
  if (JSON.stringify(was.cards) === JSON.stringify(cards) && Math.floor(was.at / 60_000) === Math.floor(t / 60_000)) return
  await update($, others, () => ({ at: t, cards }))
  await refreshStatus($)
}

// The timers come first: a first write or read that fails must not leave the session silent.
async function startSharing($: EngineInterface): Promise<void> {
  heartbeat?.cancel()
  heartbeat = $.clock.every(HEARTBEAT_MS, () => {
    void publishNow($, true).catch(() => {})
  })
  poll?.cancel()
  poll = $.clock.every(POLL_MS, () => {
    void readOthers($).catch(() => {})
  })
  await publishNow($, true, true).catch(() => {})
  await readOthers($).catch(() => {})
}

// Where the person's own prompts come from; a mod's or a reminder's are not theirs.
const USER_ORIGINS = ['composer', 'bridge', 'sdk']

const SHELLS = new Set(['Bash', 'PowerShell'])
const EDITS = new Set(['Edit', 'Write', 'NotebookEdit'])

// Edits, tests, checks and commits, as the handoff needs them; a failed edit changed nothing.
// A failed call may carry no result at all, and a failed test is still worth its line.
async function noteLog($: EngineInterface, e: Call, ran: Ran): Promise<void> {
  if (ran.deny !== undefined) return
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
    const stdout = typeof ran.result === 'object' && ran.result !== null ? (ran.result as { stdout?: unknown }).stdout : undefined
    const commit = !ran.isError && isCommit(input.command) && typeof stdout === 'string' ? parseCommit(stdout) : undefined
    if (commit) entries.push({ kind: 'commit', t, ...commit, agent })
  }
  if (entries.length > 0) await update($, log, l => entries.reduce(addEntry, l))
}

type Measured = Pick<SessionMeasureInput, 'context' | 'rateLimits'>

// Folds a measurement into the usage. The write starts from the value as it stands when it lands,
// so a break notice written meanwhile at a turn's end is not lost.
async function noteMeasure($: EngineInterface, e: Measured): Promise<void> {
  const t = await $.clock.now()
  const limits = e.rateLimits.map((l): Limit => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt }))
  const valveRead = needsValve(await read($, usage), e.context) ? await readValve($) : undefined
  let out: MeasureStep | undefined
  await update($, usage, cur => (out = measureStep(cur, { context: e.context, limits }, t, valveRead)).next)
  if (out === undefined) return

  if (out.contextNotify !== undefined) $.ui.toast(contextToast(out.contextNotify), { timeoutMs: contextToastMs(out.contextNotify) })
  if (out.valveWarn !== undefined) $.ui.toast(valveToast(out.valveWarn), { timeoutMs: 20_000 })
  if (out.breakNotify !== undefined) $.ui.toast(breakToast(out.breakNotify), { timeoutMs: 15_000 })
  await announceLimits($, limits, out.next.fast)
  scheduleResetRedraw($, out.next.limits, t)
}

// Where automatic compaction runs, from the context breakdown (estimated locally, no API call).
// 0 when it cannot be read; the next measurement tries again.
async function readValve($: EngineInterface): Promise<number> {
  const u = await $.session.usage({ breakdown: 'summary' }).catch(() => undefined)

  return valveOf(u?.context.breakdown)
}

// At the end of a main turn: a break in the work past 50% is a good moment to compact.
async function noteBreak($: EngineInterface): Promise<void> {
  const p = await read($, progress)
  const isBreakNow = isBreak(await read($, log), p.startedAt, p.tasks)
  let notify: number | undefined
  await update($, usage, cur => {
    const step = turnEndStep(cur, isBreakNow)
    notify = step.breakNotify

    return step.next
  })
  if (notify !== undefined) $.ui.toast(breakToast(notify), { timeoutMs: 15_000 })
}

// A reset that passes while nothing happens would leave "18:40 回復" on show: redraw once it has.
// Only the nearest reset within a day is waited for; the module's own timer, started over on reload.
let resetTimer: Timer | undefined
const RESET_WAIT_MAX = 24 * 60 * 60_000

function scheduleResetRedraw($: EngineInterface, limits: Limit[], t: number): void {
  const reset = nextReset(limits, t)
  resetTimer?.cancel()
  resetTimer = undefined
  if (reset === undefined || reset - t > RESET_WAIT_MAX) return
  resetTimer = $.clock.after(reset - t + 1000, () => {
    resetTimer = undefined
    void $.clock
      .now()
      .then(n => update($, now, () => n))
      .then(() => refreshStatus($))
      .catch(() => {})
  })
}

async function announceLimits($: EngineInterface, limits: Limit[], fast: Usage['fast']): Promise<void> {
  if (limits.length === 0) return
  const notices = { ...(((await $.store.get(NOTICES)) ?? {}) as Record<string, LimitNotice>) }
  let isChanged = false
  for (const limit of limits) {
    const was = notices[limit.kind]
    const notice = noticeFor(was, limit)
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
    isInteractive = e.isInteractive
    isEnded = false
    await startSharing($).catch(() => {})
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
    await schedulePublish($).catch(() => {})

    return next(e)
  })

  // The session's card goes. After a /clear or a /resume the process goes on under another id, with no
  // session.start for it: sharing goes on and writes that one. Anything else ends it for the process.
  on('session.end', async ($, e, next) => {
    // Set before any wait, so a write already on its way sees the end.
    epoch += 1
    lastShape = ''
    const goesOn = e.reason === 'clear' || e.reason === 'resume'
    if (!goesOn) {
      isEnded = true
      for (const timer of [pending, heartbeat, poll]) timer?.cancel()
      pending = heartbeat = poll = undefined
    }
    await $.store.delete(cardKey(e.sessionId)).catch(() => {})
    if (goesOn) {
      since = 0
      await update($, request, () => '').catch(() => {})
    }

    return next(e)
  })

  // The person's latest request names the session for the others: one that entered, and that has words.
  on('prompt.submit', async ($, e, next) => {
    const passed = await next(e)
    if (passed.drop === undefined && USER_ORIGINS.includes(e.origin.kind) && e.command === undefined && e.isMeta !== true) {
      const line = requestLine(passed.text ?? e.text)
      if (line !== '') {
        await update($, request, () => line).catch(() => {})
        await schedulePublish($).catch(() => {})
      }
    }

    return passed
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
    // New work began: a break the last turn ended at no longer waits for its fill.
    await update($, usage, cur => (cur.isBreakPending ? { ...cur, isBreakPending: false } : cur))
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
    await schedulePublish($).catch(() => {})

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
    // A checkout during the turn shows in the branch from its end; the turn does not wait for git.
    if (await isSharing($).catch(() => false)) void refreshBranch($).then(() => schedulePublish($)).catch(() => {})
    await schedulePublish($).catch(() => {})

    return next(e)
  })

  // The panel only watches: a failure here never stands in the way of a tool call.
  on('tool.call', async ($, e, next) => {
    await noteStart($, e).catch(() => {})
    const ran = await next(e)
    await noteEnd($, e, ran).catch(() => {})
    await noteLog($, e, ran).catch(() => {})
    await schedulePublish($).catch(() => {})

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const p = await read($, progress)
    const n = await read($, now)
    const u = await read($, usage)
    const subs = await read($, agents)
    const entries = await read($, log)
    const o = await read($, others)
    const section = othersSection(o.cards, Math.max(n, o.at))
    const isRemote = e.surface === 'mobile'
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
        {u.context && ctx === undefined && u.contextHistory.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>コンテキスト —</Text>
            <Text dimColor>次の応答で更新します</Text>
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
        {o.cards.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>{section.heading}</Text>
            {isRemote ? (
              // A phone draws through Remote Control: the other sessions' requests and tasks stay on this machine.
              <Text dimColor>中身はこの画面には出しません（このパソコンの画面で見られます）</Text>
            ) : (
              section.rows.map(row => (
                <Text bold={row.isBold} dimColor={row.isDim} color={row.color}>
                  {row.text}
                </Text>
              ))
            )}
            {!isRemote && section.hidden > 0 && <Text dimColor>ほか {section.hidden} 件</Text>}
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
