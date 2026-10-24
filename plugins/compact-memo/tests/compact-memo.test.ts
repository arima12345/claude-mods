import type { On, SessionCompactInput, SessionMessage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { buildMemo, isLastCheckFailing, SUMMARY_INSTRUCTION, withInstruction, type Gathered } from '../hooks/memo'

const msg = (role: 'user' | 'assistant', text: string): SessionMessage => ({ role, text, toolUses: [] })

const SUMMARY = msg('user', 'これまでの要約です。')
const PREVIOUS_MEMO = '【圧縮前の退避メモ（compact-memo が自動で追加）】\n前回のメモです。'

// A conversation full of short replies, and the memo of the last compaction in it.
const CONVERSATION = [msg('user', 'progress-panel に作業ログを足して'), msg('assistant', '足しました'), msg('user', PREVIOUS_MEMO), msg('user', '2'), msg('user', 'はい、消してください')]

type World = { toasts: string[]; seen: SessionCompactInput[] }

const GOAL = { condition: '全テストが通ること', status: 'active' }
const TASKS = [
  { id: '0', title: '画面を作る', status: 'completed' },
  { id: '1', title: '保存を作る', status: 'in_progress' },
  { id: '2', title: 'テストする', status: 'pending' },
]

type Others = { goal?: unknown; tasks?: unknown[]; log?: unknown[] }

function world(on: On, others: Others = {}, branch: string | 'none' = 'fix-compact-memo-trim'): World {
  mock.clock(on, { now: new Date(2026, 9, 24, 21, 5).getTime() })
  mock.store(on)
  const w: World = { toasts: [], seen: [] }
  on('ui.toast', async (_$, e) => {
    w.toasts.push(e.text)

    return { value: undefined } as never
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.compact', async (_$, e) => {
    w.seen.push(e)

    return { messages: [SUMMARY] }
  })
  on('session.usage', async () => ({ value: { startedAt: 0, context: { percent: 96, tokens: 960_000, window: 1_000_000 }, rateLimits: [] } }) as never)
  on('process.run', async (_$, e) =>
    (branch === 'none' ? { deny: 'not a git repository' } : { value: { exitCode: 0, stdout: `${branch}\n`, stderr: '' }, argv: e.argv }) as never,
  )
  // Other mods' state, answered beneath this one as the host would hold it.
  on('state.get', async (_$, e, next) => {
    const ref = e as unknown as { plugin: string; key: string }
    if (ref.plugin === 'goal2' && ref.key === 'goal') return { value: { value: others.goal ?? null, version: 1 } } as never
    if (ref.plugin === 'progress-panel' && ref.key === 'progress') return { value: { value: { tasks: others.tasks ?? [] }, version: 1 } } as never
    if (ref.plugin === 'progress-panel' && ref.key === 'log') return { value: { value: others.log ?? [], version: 1 } } as never

    return next(e)
  })

  return w
}

const start = { cwd: 'C:\\ARIMA\\claude-mods', surface: 'desktop', isInteractive: true } as never

test('the memo holds the goal, the tasks left, the branch, commits and a failing last check', async ($, on) => {
  const w = world(on, {
    goal: GOAL,
    tasks: TASKS,
    log: [
      { kind: 'test', t: 1, command: 'npm test', outcome: 'pass' },
      ...Array.from({ length: 7 }, (_, i) => ({ kind: 'commit', t: 10 + i, hash: `${i}abcdef1234`, subject: `コミット ${i}` })),
      { kind: 'check', t: 20, command: 'npx tsc', outcome: 'fail' },
    ],
  })
  await $.session.start(start)
  const out = (await $.session.compact({ trigger: 'auto', messages: CONVERSATION } as never)) as { messages: SessionMessage[] }

  expect(w.seen[0]?.instructions).toBe(SUMMARY_INSTRUCTION)
  expect(out.messages).toHaveLength(2)
  const memo = out.messages[1]?.text ?? ''
  expect(memo).toBe(
    [
      '【圧縮前の退避メモ（compact-memo が自動で追加）】',
      'claude-mods・10/24 21:05 の圧縮の直前の状況です。要約と食い違う場合は、このメモと実際のファイル・git を優先して確かめてください。変更中のファイルは git status で確かめてください。',
      '',
      '## いまのゴール（goal2）',
      '全テストが通ること',
      '',
      '## やることリストの残り',
      '▶ 保存を作る',
      '・ テストする',
      '',
      '## いまのブランチ',
      'fix-compact-memo-trim',
      '',
      '## このセッションのコミット（新しい5件）',
      '- 6abcdef コミット 6',
      '- 5abcdef コミット 5',
      '- 4abcdef コミット 4',
      '- 3abcdef コミット 3',
      '- 2abcdef コミット 2',
      '',
      '## 気をつけること',
      '- 最後に実行したテスト・チェックが失敗のままです',
    ].join('\n'),
  )
  expect(w.toasts).toEqual(['圧縮前のメモを渡し直しました（/compact-memo で見られます）'])

  const report = ((await $.command.run({ command: 'compact-memo', args: '' } as never)) as { text?: string }).text ?? ''
  expect(report).toContain('## 直近の退避メモ（10/24 21:05・自動）')
  expect(report).toContain('## 圧縮の記録（新しい順）\n- 10/24 21:05 自動: 文脈 96%（約 960k / 1000k）')
})

test('requests, earlier memos, git status and failed commands are not copied', async ($, on) => {
  world(on, { tasks: TASKS, log: [{ kind: 'test', t: 1, command: 'cd x && npm test 2>&1 | tail', outcome: 'fail' }, { kind: 'test', t: 2, command: 'npm test', outcome: 'pass' }] })
  const out = (await $.session.compact({ trigger: 'manual', messages: CONVERSATION } as never)) as { messages: SessionMessage[] }
  const memo = out.messages[1]?.text ?? ''
  for (const gone of ['直近の依頼', '前回のメモ', 'はい、消してください', 'git status）', '未解決の問題', 'npm test', '気をつけること']) {
    expect(memo).not.toContain(gone)
  }
  expect(memo).toContain('## やることリストの残り')
})

test('with nothing worth keeping, no memo and no toast', async ($, on) => {
  const w = world(on, { tasks: [{ id: '0', title: '終わった', status: 'completed' }], log: [{ kind: 'edit', t: 1, path: '/r/a.ts' }] })
  const out = (await $.session.compact({ trigger: 'auto', messages: CONVERSATION } as never)) as { messages: SessionMessage[] }
  expect(out.messages).toEqual([SUMMARY])
  expect(w.toasts).toEqual([])
  // The compaction is still on the record.
  const report = ((await $.command.run({ command: 'compact-memo', args: '' } as never)) as { text?: string }).text ?? ''
  expect(report).toContain('まだ退避メモはありません')
  expect(report).toContain('自動: 文脈 96%')
})

test('without git the branch is left out', async ($, on) => {
  world(on, { goal: { condition: 'デプロイする', status: 'paused' } }, 'none')
  const out = (await $.session.compact({ trigger: 'manual', messages: CONVERSATION } as never)) as { messages: SessionMessage[] }
  const memo = out.messages[1]?.text ?? ''
  expect(memo).toContain('## いまのゴール（goal2・一時停止中）\nデプロイする')
  expect(memo).not.toContain('いまのブランチ')
  // No session start seen: the heading goes without the folder.
  expect(memo).toContain('\n10/24 21:05 の圧縮の直前の状況です。')
})

test('the words given to /compact are kept ahead of ours', async ($, on) => {
  const w = world(on)
  await $.session.compact({ trigger: 'manual', instructions: 'API の設計を中心に', messages: CONVERSATION } as never)
  expect(w.seen[0]?.instructions).toBe(`API の設計を中心に\n\n${SUMMARY_INSTRUCTION}`)
  expect(withInstruction('  ')).toBe(SUMMARY_INSTRUCTION)
})

test('a precomputed summary gets the instruction but no memo, and a subagent compaction is left alone', async ($, on) => {
  const w = world(on, { goal: GOAL })
  const pre = (await $.session.compact({ trigger: 'precompute', messages: CONVERSATION } as never)) as { messages: SessionMessage[] }
  expect(w.seen[0]?.instructions).toBe(SUMMARY_INSTRUCTION)
  expect(pre.messages).toHaveLength(1)

  const sub = (await $.session.compact({ trigger: 'auto', agentId: 'a1', messages: CONVERSATION } as never)) as { messages: SessionMessage[] }
  expect(w.seen[1]?.instructions).toBeUndefined()
  expect(sub.messages).toHaveLength(1)
  expect(w.toasts).toEqual([])
})

test('/compact-memo says so before any compaction', async ($, on) => {
  world(on)
  const report = ((await $.command.run({ command: 'compact-memo', args: '' } as never)) as { text?: string }).text ?? ''
  expect(report).toContain('まだ退避メモはありません')
})

test('only the very last test or check counts', () => {
  const run = (t: number, outcome: string) => ({ kind: 'test', t, command: 'x', outcome })
  expect(isLastCheckFailing([run(1, 'fail'), run(2, 'pass')])).toBe(false)
  expect(isLastCheckFailing([run(1, 'pass'), run(2, 'fail'), { kind: 'commit', t: 3, hash: 'a', subject: 's' }])).toBe(true)
  expect(isLastCheckFailing([])).toBe(false)
})

test('a long task list is cut, every section keeps its heading', () => {
  const g: Gathered = {
    label: 'p',
    at: '1/1 0:00',
    goal: null,
    tasks: Array.from({ length: 400 }, (_, i) => ({ title: `項目 ${i} ${'x'.repeat(300)}`, status: 'pending' })),
    branch: 'main',
    log: [{ kind: 'commit', t: 1, hash: 'abcdef1', subject: 's' }],
  }
  const memo = buildMemo(g) ?? ''
  expect(memo.length).toBeLessThanOrEqual(6000)
  expect(memo).toContain('## いまのブランチ\nmain')
  expect(memo).toContain('## このセッションのコミット（新しい5件）\n- abcdef1 s')
  expect(memo).not.toContain('x'.repeat(250))
})
