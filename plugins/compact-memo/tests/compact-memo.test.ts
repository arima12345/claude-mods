import type { On, SessionCompactInput, SessionMessage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { buildMemo, isLastCheckFailing, SUMMARY_INSTRUCTION, withInstruction, type Gathered } from '../hooks/memo'
import { recordLine, report } from '../hooks/register'

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

type Others = { goal?: unknown; tasks?: unknown[]; log?: unknown[]; isSkipped?: boolean }

function world(on: On, others: Others = {}, branch: string | 'none' = 'fix-compact-memo-trim'): World {
  mock.clock(on, { now: new Date(2026, 9, 24, 21, 5).getTime() })
  mock.store(on)
  const w: World = { toasts: [], seen: [] }
  on('ui.toast', async (_$, e) => {
    w.toasts.push(e.text)

    return { value: undefined } as never
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'S1' }) as never)
  on('session.compact', async (_$, e) => {
    w.seen.push(e)

    return others.isSkipped ? { skip: '別の mod が止めた' } : { messages: [SUMMARY] }
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
  expect(report).toContain('## このセッション（claude-mods）\n最後の圧縮: 10/24 21:05 自動・claude-mods: 文脈 96%（約 960k / 1000k）・メモあり')
  expect(report).toContain('### そのとき渡し直した退避メモ\n\n【圧縮前の退避メモ')
  expect(report).toContain('## 圧縮の記録（新しい順・すべてのセッション）\n- 10/24 21:05 自動・claude-mods: 文脈 96%（約 960k / 1000k）・メモあり（このセッション）')
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

test('with nothing worth keeping, no memo, but a toast and a record that say so', async ($, on) => {
  const w = world(on, { tasks: [{ id: '0', title: '終わった', status: 'completed' }], log: [{ kind: 'edit', t: 1, path: '/r/a.ts' }] })
  await $.session.start(start)
  const out = (await $.session.compact({ trigger: 'auto', messages: CONVERSATION } as never)) as { messages: SessionMessage[] }
  expect(out.messages).toEqual([SUMMARY])
  expect(w.toasts).toEqual(['残すことがなかったので、退避メモは作りませんでした（ゴール・やることの残り・コミット・失敗中のテストがありません）'])
  const report = ((await $.command.run({ command: 'compact-memo', args: '' } as never)) as { text?: string }).text ?? ''
  expect(report).toContain('この圧縮では退避メモを作っていません。圧縮後の Claude には、要約だけが渡りました。')
  expect(report).toContain('- 10/24 21:05 自動・claude-mods: 文脈 96%（約 960k / 1000k）・メモなし（残すことがなかった）（このセッション）')
})

test('a skipped compaction leaves no record', async ($, on) => {
  const w = world(on, { goal: GOAL, isSkipped: true })
  await $.session.compact({ trigger: 'manual', messages: CONVERSATION } as never)
  const report = ((await $.command.run({ command: 'compact-memo', args: '' } as never)) as { text?: string }).text ?? ''
  expect(report).not.toContain('圧縮の記録')
  expect(w.toasts).toEqual([])
})

test('records from before 0.3 read without folder or memo, and an unread state is said', () => {
  const at = new Date(2026, 9, 24, 23, 46).getTime()
  expect(recordLine({ at, trigger: 'manual', percent: 85, tokens: 849_000, window: 1_000_000 })).toBe('10/24 23:46 手動: 文脈 85%（約 849k / 1000k）')
  expect(recordLine({ at, trigger: 'auto', window: 0, label: 'Note記事執筆', hasMemo: false, reason: 'unread' })).toBe('10/24 23:46 自動・Note記事執筆: 文脈 —・メモなし（状況を読み取れなかった）')
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
  expect(report).toContain('## このセッション\nこのセッションではまだ圧縮が起きていません。')
})

test("another session's memo is not shown as this one's, and its compactions are marked apart", () => {
  const at = (h: number, m: number) => new Date(2026, 9, 24, h, m).getTime()
  const memos = [{ at: at(23, 40), trigger: 'manual', text: '【Note記事執筆のメモ】', session: 'NOTE' }, { at: at(23, 0), trigger: 'auto', text: '【0.4 より前のメモ】' }]
  const compactions = [
    { at: at(23, 0), trigger: 'auto', percent: 92, tokens: 924_000, window: 1_000_000 },
    { at: at(23, 40), trigger: 'manual', percent: 39, tokens: 395_000, window: 1_000_000, label: 'Note記事執筆', hasMemo: true, session: 'NOTE' },
    { at: at(23, 52), trigger: 'manual', percent: 66, tokens: 663_000, window: 1_000_000, label: 'Codex環境について', hasMemo: false, reason: 'empty' as const, session: 'HERE' },
  ]
  const text = report(memos, compactions, { session: 'HERE', label: 'Codex環境について' })
  expect(text).toContain('## このセッション（Codex環境について）\n最後の圧縮: 10/24 23:52 手動・Codex環境について: 文脈 66%（約 663k / 1000k）・メモなし（残すことがなかった）\nこの圧縮では退避メモを作っていません。')
  expect(text).not.toContain('Note記事執筆のメモ')
  expect(text).not.toContain('0.4 より前のメモ')
  expect(text).toContain('ほかのセッションの退避メモは、そのセッションで /compact-memo を打つと見られます。')
  expect(text).toContain('- 10/24 23:52 手動・Codex環境について: 文脈 66%（約 663k / 1000k）・メモなし（残すことがなかった）（このセッション）\n- 10/24 23:40 手動・Note記事執筆: 文脈 39%（約 395k / 1000k）・メモあり\n- 10/24 23:00 自動: 文脈 92%')

  // In the session that made it, the memo is shown.
  expect(report(memos, compactions, { session: 'NOTE', label: 'Note記事執筆' })).toContain('### そのとき渡し直した退避メモ\n\n【Note記事執筆のメモ】')
  // A session id that cannot be read claims nothing as its own.
  expect(report(memos, compactions, { session: undefined, label: '' })).not.toContain('（このセッション）')
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
