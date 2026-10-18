import { expect, mock, test } from 'claude-code/testing'

const PANE = { component: 'Pane', requestId: 'progress-panel', props: { title: 'Claudeの進捗', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} } } as const

test('the pane shows working, the current action and the todo list on every surface', async ($, on) => {
  const clock = mock.clock(on)
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }) as never)
  const statuses: (string | undefined)[] = []
  on('ui.status', async (_$, e) => {
    statuses.push(e.text)

    return { value: undefined } as never
  })
  on('turn.complete', async () => ({ text: '' }))
  on('tool.call', async (_$, e) => ({ result: { oldTodos: [], newTodos: [] }, text: 'ok' }) as never)

  await $.turn.start({ text: 'カフェ日記を作って', turnId: 't1' })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: '画面を作る', status: 'completed', activeForm: '画面を作っている' },
      { content: '保存を作る', status: 'in_progress', activeForm: '保存を作っている' },
      { content: 'テストする', status: 'pending', activeForm: 'テストしている' },
    ],
  })

  await clock.advance(65_000)

  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: 'progress-panel', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /作業中/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /やることリストを更新中/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1\/3/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /経過: 1分5秒/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /▶ 保存を作っている/ })).toBeDefined()
    await ui.unmount()
  }

  await $.turn.complete({ reason: 'answer', answer: 'できました', durationMs: 65_000, isAborted: false, turnId: 't1' })
  expect(statuses.at(-1)).toBe('待機中 1/3')
  const ui = await $.ui.mount({ plugin: 'progress-panel', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /待機中/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /返事を書き終えた/ })).toBeDefined()
  await ui.unmount()
})
