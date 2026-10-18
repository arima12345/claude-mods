import { expect, mock, test } from 'claude-code/testing'

import { carryOver } from '../hooks/register'

const PANE = { component: 'Pane', requestId: 'progress-panel', props: { title: 'Claudeの進捗', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} } } as const

const done = (turnId: string) => ({ reason: 'answer', answer: 'できました', durationMs: 1, isAborted: false, turnId }) as const

test('tasks finished in an earlier request are cleared when the next one starts', async ($, on) => {
  mock.clock(on)
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', async () => ({ text: '' }))
  const statuses: (string | undefined)[] = []
  on('ui.status', async (_$, e) => {
    statuses.push(e.text)

    return { value: undefined } as never
  })
  let nextId = 1
  on('tool.call', async (_$, e) =>
    (e.tool === 'TaskCreate' ? { result: { task: { id: String(nextId++), subject: e.subject } }, text: 'ok' } : { result: { success: true }, text: 'ok' }) as never,
  )

  await $.turn.start({ text: 'カフェ日記を作って', turnId: 't1' })
  await $.tool.call({ tool: 'TaskCreate', subject: '画面を作る', description: '' } as never)
  await $.tool.call({ tool: 'TaskCreate', subject: '保存を作る', description: '' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'completed' } as never)
  await $.turn.complete(done('t1'))
  // The finished list still shows while waiting for the next request.
  expect(statuses.at(-1)).toBe('待機中 2/2')

  await $.turn.start({ text: '今日の天気は?', turnId: 't2' })
  expect(statuses.at(-1)).toBe('作業中・考え中')
  await $.tool.call({ tool: 'TaskCreate', subject: '天気を調べる', description: '' } as never)
  const ui = await $.ui.mount({ plugin: 'progress-panel', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /0\/1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /画面を作る/ })).toBeUndefined()
  await ui.unmount()
})

test('an unfinished list carries on into the next turn', async ($, on) => {
  mock.clock(on)
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', async () => ({ text: '' }))
  const statuses: (string | undefined)[] = []
  on('ui.status', async (_$, e) => {
    statuses.push(e.text)

    return { value: undefined } as never
  })
  on('tool.call', async (_$, e) => (e.tool === 'TaskCreate' ? { result: { task: { id: e.subject, subject: e.subject } }, text: 'ok' } : { result: { success: true }, text: 'ok' }) as never)

  await $.turn.start({ text: 'カフェ日記を作って', turnId: 't1' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'A', description: '' } as never)
  await $.tool.call({ tool: 'TaskCreate', subject: 'B', description: '' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: 'A', status: 'completed' } as never)
  await $.turn.complete(done('t1'))
  await $.turn.start({ text: '続けて', turnId: 't2' })
  expect(statuses.at(-1)).toBe('作業中 1/2・考え中')
})

test('a subagent turn never clears the main list', async ($, on) => {
  mock.clock(on)
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', async () => ({ text: '' }))
  on('ui.status', async () => ({ value: undefined }) as never)
  on('tool.call', async () => ({ result: { oldTodos: [], newTodos: [] }, text: 'ok' }) as never)

  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: '調べる', status: 'completed', activeForm: '調べている' }] })
  await $.turn.start({ text: 'sub', turnId: 's1', agentId: 'a1' })
  const ui = await $.ui.mount({ plugin: 'progress-panel', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Text', text: /✓ 調べる/ })).toBeDefined()
  await ui.unmount()
})

test('carryOver keeps any list with work left', () => {
  expect(carryOver([])).toEqual([])
  expect(carryOver([{ id: '1', title: 'a', status: 'completed' }])).toEqual([])
  expect(carryOver([{ id: '1', title: 'a', status: 'completed' }, { id: '2', title: 'b', status: 'pending' }])).toHaveLength(2)
  expect(carryOver([{ id: '1', title: 'a', status: 'in_progress' }])).toHaveLength(1)
})
