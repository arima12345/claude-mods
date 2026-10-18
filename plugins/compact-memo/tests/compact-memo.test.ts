import type { On, SessionCompactInput, SessionMessage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { buildMemo, failingChecks, recentRequests, SUMMARY_INSTRUCTION, withInstruction } from '../hooks/memo'

const msg = (role: 'user' | 'assistant', text: string, extra: Partial<SessionMessage> = {}): SessionMessage => ({ role, text, toolUses: [], ...extra })

const SUMMARY = msg('user', 'これまでの要約です。')

type World = { toasts: string[]; seen: SessionCompactInput[] }

function world(on: On, git: { exitCode: number; stdout: string } | 'missing' = { exitCode: 0, stdout: ' M hooks/register.ts\n?? SPEC.md\n' }): World {
  mock.clock(on, { now: new Date(2026, 9, 18, 21, 5).getTime() })
  mock.store(on)
  const w: World = { toasts: [], seen: [] }
  on('ui.toast', async (_$, e) => {
    w.toasts.push(e.text)

    return { value: undefined } as never
  })
  on('session.compact', async (_$, e) => {
    w.seen.push(e)

    return { messages: [SUMMARY] }
  })
  on('session.usage', async () => ({ value: { startedAt: 0, context: { percent: 83, tokens: 166_000, window: 200_000 }, rateLimits: [] } }) as never)
  on('process.run', async () =>
    (git === 'missing' ? { deny: 'git: not found' } : { value: { exitCode: git.exitCode, stdout: git.stdout, stderr: '' } }) as never,
  )

  return w
}

const CONVERSATION = [
  msg('user', 'progress-panel に作業ログを足して'),
  msg('assistant', '足しました'),
  msg('user', '', { toolResults: [{ tool_use_id: 'x', text: 'ok', isError: false }] as never }),
  msg('user', '<system-reminder>ignore</system-reminder>'),
  msg('user', 'テストも書いて'),
]

test('a compaction tells the summary to keep decisions and hands the memo back after it', async ($, on) => {
  const w = world(on)
  const out = await $.session.compact({ trigger: 'auto', messages: CONVERSATION } as never)

  expect(w.seen[0]?.instructions).toBe(SUMMARY_INSTRUCTION)
  const messages = (out as { messages: SessionMessage[] }).messages
  expect(messages).toHaveLength(2)
  expect(messages[0]?.text).toBe('これまでの要約です。')
  const memo = messages[1]?.text ?? ''
  expect(messages[1]?.role).toBe('user')
  expect(memo).toContain('【圧縮前の退避メモ（compact-memo が自動で追加）】')
  expect(memo).toContain('## 直近の依頼\n- progress-panel に作業ログを足して\n- テストも書いて')
  expect(memo).toContain('## 変更中のファイル（git status）\n M hooks/register.ts\n?? SPEC.md')
  expect(memo).not.toContain('system-reminder')
  expect(w.toasts).toEqual(['圧縮前のメモを渡し直しました（/compact-memo で見られます）'])

  const report = ((await $.command.run({ command: 'compact-memo', args: '' } as never)) as { text?: string }).text ?? ''
  expect(report).toContain('## 直近の退避メモ（10/18 21:05・自動）')
  expect(report).toContain('テストも書いて')
  expect(report).toContain('## 圧縮の記録（新しい順）\n- 10/18 21:05 自動: 文脈 83%（約 166k / 200k）')
})

test('the words given to /compact are kept ahead of ours', async ($, on) => {
  const w = world(on)
  await $.session.compact({ trigger: 'manual', instructions: 'API の設計を中心に', messages: CONVERSATION } as never)
  expect(w.seen[0]?.instructions).toBe(`API の設計を中心に\n\n${SUMMARY_INSTRUCTION}`)
})

test('a precomputed summary gets the instruction but no memo, and a subagent compaction is left alone', async ($, on) => {
  const w = world(on)
  const pre = (await $.session.compact({ trigger: 'precompute', messages: CONVERSATION } as never)) as { messages: SessionMessage[] }
  expect(w.seen[0]?.instructions).toBe(SUMMARY_INSTRUCTION)
  expect(pre.messages).toHaveLength(1)

  const sub = (await $.session.compact({ trigger: 'auto', agentId: 'a1', messages: CONVERSATION } as never)) as { messages: SessionMessage[] }
  expect(w.seen[1]?.instructions).toBeUndefined()
  expect(sub.messages).toHaveLength(1)
  expect(w.toasts).toEqual([])
})

test('without git the work log names the edited files', async ($, on) => {
  world(on, 'missing')
  const out = (await $.session.compact({ trigger: 'manual', messages: CONVERSATION } as never)) as { messages: SessionMessage[] }
  const memo = out.messages[1]?.text ?? ''
  expect(memo).not.toContain('git status')
  // Nothing else to go on here: the request list is still there.
  expect(memo).toContain('## 直近の依頼')
})

test('/compact-memo says so before any compaction', async ($, on) => {
  world(on)
  const report = ((await $.command.run({ command: 'compact-memo', args: '' } as never)) as { text?: string }).text ?? ''
  expect(report).toContain('まだ退避メモはありません')
})

test('the memo draws on goal2 and progress-panel when they are there', () => {
  const memo = buildMemo({
    goal: { condition: '全テストが通ること', status: 'active' },
    requests: ['無視される依頼'],
    tasks: [
      { title: '画面を作る', status: 'completed' },
      { title: '保存を作る', status: 'in_progress' },
      { title: 'テストする', status: 'pending' },
    ],
    gitStatus: [],
    log: [
      { kind: 'edit', t: 1, path: '/r/a.ts' },
      { kind: 'test', t: 2, command: 'npm test', outcome: 'fail' },
      { kind: 'check', t: 3, command: 'npx tsc', outcome: 'fail' },
      { kind: 'check', t: 4, command: 'npx tsc', outcome: 'pass' },
      { kind: 'commit', t: 5, hash: '1a2b3c4d5e', subject: 'Add log' },
    ],
  })
  expect(memo).toContain('## いまのゴール（goal2）\n全テストが通ること')
  expect(memo).not.toContain('無視される依頼')
  expect(memo).toContain('## やることリストの残り\n▶ 保存を作る\n・ テストする')
  expect(memo).not.toContain('画面を作る')
  // A clean tree says nothing, and git standing means the work log is not asked.
  expect(memo).not.toContain('変更中のファイル')
  expect(memo).not.toContain('/r/a.ts')
  expect(memo).toContain('## このセッションのコミット\n- 1a2b3c4 Add log')
  expect(memo).toContain('## 未解決の問題\n- 失敗したままのテスト・チェック: `npm test`')
  expect(memo).not.toContain('npx tsc')
})

test('a paused goal is still the goal, and the work log stands in for git', () => {
  const memo = buildMemo({
    goal: { condition: 'デプロイする', status: 'paused' },
    requests: [],
    tasks: [],
    gitStatus: undefined,
    log: [
      { kind: 'edit', t: 1, path: '/r/a.ts' },
      { kind: 'edit', t: 2, path: '/r/a.ts' },
    ],
  })
  expect(memo).toContain('## いまのゴール（goal2・一時停止中）\nデプロイする')
  expect(memo).toContain('## このセッションで編集したファイル\n- /r/a.ts')
})

test('a long memo is cut to its limit from the end', () => {
  const memo = buildMemo({
    goal: null,
    requests: ['依頼'],
    tasks: Array.from({ length: 400 }, (_, i) => ({ title: `項目 ${i} ${'x'.repeat(300)}`, status: 'pending' })),
    gitStatus: Array.from({ length: 100 }, (_, i) => ` M file${i}.ts`),
    log: [],
  })
  expect(memo.length).toBeLessThanOrEqual(6000)
  // The long task list gives way; the files changed keep their place.
  expect(memo).toContain('## 変更中のファイル（git status）\n M file0.ts')
  expect(memo).toContain('（ほか 60 件）')
  expect(memo).toContain('（長すぎるため一部を省きました）')
  expect(memo).not.toContain('x'.repeat(250))
})

test('requests skip tool results, reminders and commands, and keep the last three', () => {
  const many = ['一', '二', '三', '四'].map(t => msg('user', t))
  expect(recentRequests([...many, msg('user', '<command-name>/clear</command-name>')])).toEqual(['二', '三', '四'])
  expect(recentRequests([msg('user', 'a'.repeat(300))])[0]).toHaveLength(200)
})

test('a check that failed and then passed is not unresolved', () => {
  expect(failingChecks([
    { kind: 'test', t: 1, command: 'a', outcome: 'fail' },
    { kind: 'test', t: 2, command: 'a', outcome: 'pass' },
    { kind: 'test', t: 3, command: 'b', outcome: 'fail' },
  ])).toEqual(['b'])
  expect(withInstruction('  ')).toBe(SUMMARY_INSTRUCTION)
})
