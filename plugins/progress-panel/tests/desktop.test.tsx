import { expect, mock, test } from 'claude-code/testing'

import { applyPlan, describe as describeTool } from '../hooks/register'

const PANE = { component: 'Pane', requestId: 'progress-panel', props: { title: 'Claudeの進捗', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} } } as const

test('the desktop app task list shows in the pane and moves with each update', async ($, on) => {
  mock.clock(on)
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', async () => ({ text: '' }))
  const statuses: (string | undefined)[] = []
  on('ui.status', async (_$, e) => {
    statuses.push(e.text)

    return { value: undefined } as never
  })
  on('tool.call', async () => ({ result: { content: [{ type: 'text', text: 'ok' }] }, text: 'ok' }) as never)

  await $.turn.start({ text: 'カフェ日記を作って', turnId: 't1' })
  await $.tool.call({
    tool: 'mcp__ccd_turn__update_plan',
    items: [
      { content: '画面を作る', status: 'in_progress' },
      { content: '保存を作る', status: 'pending' },
      { content: 'テストする', status: 'pending' },
    ],
    scope: 'first_task',
  } as never)

  let ui = await $.ui.mount({ plugin: 'progress-panel', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Text', text: /やることリストを更新中/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /0\/3/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▶ 画面を作る/ })).toBeDefined()
  await ui.unmount()

  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true } as never)
  ui = await $.ui.mount({ plugin: 'progress-panel', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Text', text: /1\/3/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /✓ 画面を作る/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▶ 保存を作る/ })).toBeDefined()
  await ui.unmount()

  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', done: [2], start: 3 } as never)
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'できました' } as never)
  await $.turn.complete({ reason: 'answer', answer: 'できました', durationMs: 1, isAborted: false, turnId: 't1' })
  expect(statuses.at(-1)).toBe('待機中 3/3')
})

test('a refused plan update leaves the list as it was', async ($, on) => {
  mock.clock(on)
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }) as never)
  on('ui.status', async () => ({ value: undefined }) as never)
  on('tool.call', async (_$, e) => ((e as { advance?: unknown }).advance === true ? { deny: 'no' } : { result: {}, text: 'ok' }) as never)

  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }] } as never)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true } as never)
  const ui = await $.ui.mount({ plugin: 'progress-panel', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /▶ A/ })).toBeDefined()
  await ui.unmount()
})

test('plan steps move by their 1-based place', () => {
  const tasks = applyPlan([], { items: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'pending' }, { content: 'C', status: 'pending' }] })
  // Nothing in progress: advance starts the first pending step.
  expect(applyPlan(tasks, { advance: true }).map(t => t.status)).toEqual(['completed', 'in_progress', 'pending'])
  expect(applyPlan(tasks, { done: [2], start: 3 }).map(t => t.status)).toEqual(['completed', 'completed', 'in_progress'])
  expect(applyPlan(tasks, { items: [{ content: 'X', status: 'weird' }] })).toEqual([{ id: '0', title: 'X', status: 'pending' }])
})

test('MCP tools are named the way a person would say them', () => {
  expect(describeTool('mcp__Claude_Browser__navigate')).toBe('ブラウザを操作中')
  expect(describeTool('mcp__ccd_turn__wrap_up')).toBe('まとめを書いている')
  expect(describeTool('mcp__1a59c906-04da-521d-bda7-7f71b9f9e01c__batch')).toBe('外部ツールを使用中（batch）')
  expect(describeTool('mcp__context7__query-docs')).toBe('外部ツールを使用中（context7）')
})
