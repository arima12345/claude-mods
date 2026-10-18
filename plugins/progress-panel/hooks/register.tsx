import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer, ToolCallInput, ToolCallResult } from 'claude-code'

import type { Progress, Task } from '../types'

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

function summary(p: Progress): string {
  const done = p.tasks.filter(t => t.status === 'completed').length
  const tasks = p.tasks.length > 0 ? ` ${done}/${p.tasks.length}` : ''

  return p.isWorking ? `作業中${tasks}・${p.action || '考え中'}` : `待機中${tasks}`
}

async function refreshStatus($: EngineInterface): Promise<void> {
  $.ui.status(summary(await read($, progress)))
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
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'progress' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: '進捗パネルを開きました。' }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId) return next(e)
    const t = await $.clock.now()
    await update($, now, () => t)
    await update($, progress, p => ({
      ...p,
      isWorking: true,
      startedAt: t,
      endedAt: 0,
      action: '考え中',
      tools: 0,
    }))
    tick?.cancel()
    tick = $.clock.every(1000, () => {
      void $.clock.now().then(n => update($, now, () => n))
    })
    await refreshStatus($)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) return next(e)
    tick?.cancel()
    tick = undefined
    const t = await $.clock.now()
    const label =
      e.reason === 'answer' ? '返事を書き終えた' : e.reason === 'aborted' ? '中断された' : 'エラーで止まった'
    await update($, now, () => t)
    await update($, progress, p => ({ ...p, isWorking: false, endedAt: t, action: label }))
    await refreshStatus($)

    return next(e)
  })

  // The panel only watches: a failure here never stands in the way of a tool call.
  on('tool.call', async ($, e, next) => {
    await noteStart($, e).catch(() => {})
    const ran = await next(e)
    await noteEnd($, e, ran).catch(() => {})

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const p = await read($, progress)
    const n = await read($, now)
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
        <Text> </Text>
        {p.tasks.length === 0 ? (
          <Text dimColor>やることリストはまだありません</Text>
        ) : (
          <Box flexDirection="column">
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
