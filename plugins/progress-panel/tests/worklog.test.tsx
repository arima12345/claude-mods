import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { addEntry, classify, commitDir, maskCommand, parseCommit, parseHead, worklogMarkdown } from '../hooks/worklog'

const PANE = { component: 'Pane', requestId: 'progress-panel', props: { title: 'Claudeの進捗', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} } } as const

const at = (h: number, m: number) => new Date(2026, 9, 18, h, m).getTime()
const done = (turnId: string, agentId?: string) => ({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId, ...(agentId ? { agentId } : {}) }) as const

function world(on: On) {
  const clock = mock.clock(on, { now: at(15, 0) })
  const statuses: (string | undefined)[] = []
  on('ui.status', async (_$, e) => {
    statuses.push(e.text)

    return { value: undefined } as never
  })
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', async () => ({ text: '' }))

  return { clock, statuses }
}

const SPAWN = {
  prompt: '認証まわりを調べて',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  permissionMode: 'default',
} as const

test('subagents show while they run, are marked done, and clear on the next request', async ($, on) => {
  const w = world(on)
  let n = 0
  on('agent.spawn', async () => ({ model: 'claude-opus-5-5', agentId: `a${++n}` }) as never)

  await $.turn.start({ text: '調べて', turnId: 't1' })
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'u1', description: '認証を調査', subagentType: 'Explore' } as never)
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'u2', description: 'テストを修正', subagentType: 'worker' } as never)
  expect(w.statuses.at(-1)).toBe('作業中・考え中・サブ 2')

  await w.clock.advance(80_000)
  await $.turn.start({ text: '認証まわりを調べて', turnId: 's1', agentId: 'a1' })
  await $.turn.complete(done('s1', 'a1'))
  expect(w.statuses.at(-1)).toBe('作業中・考え中・サブ 1')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'progress-panel', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /サブエージェント（実行中 1）/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /✓ Explore：認証を調査 1分20秒/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /▶ worker：テストを修正/ })).toBeDefined()
    await ui.unmount()
  }

  await $.turn.complete(done('t1'))
  await $.turn.start({ text: '次', turnId: 't2' })
  const ui = await $.ui.mount({ plugin: 'progress-panel', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Text', text: /Explore/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /▶ worker：テストを修正/ })).toBeDefined()
  await ui.unmount()

  // A message to a finished subagent starts it again.
  await $.turn.complete(done('s2', 'a2'))
  expect(w.statuses.at(-1)).toBe('作業中・考え中')
  await $.turn.start({ text: '続けて', turnId: 's3', agentId: 'a2' })
  expect(w.statuses.at(-1)).toBe('作業中・考え中・サブ 1')
})

test('a refused spawn is not listed', async ($, on) => {
  const w = world(on)
  on('agent.spawn', async () => ({ deny: 'no' }) as never)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'u1', description: 'やる', subagentType: 'worker' } as never)
  expect(w.statuses.at(-1)).toBe('作業中・考え中')
})

test('edits, tests, checks and commits are logged, and /worklog drafts the handoff', async ($, on) => {
  const w = world(on)
  on('tool.call', async (_$, e) => {
    const call = e as unknown as { tool: string; command?: string }
    if (call.tool === 'Bash' && call.command?.includes('fail')) return { result: { stdout: '1 failed', stderr: '', interrupted: false }, isError: true, text: 'Exit code 1' } as never
    if (call.tool === 'Bash' && call.command?.includes('git commit')) {
      return { result: { stdout: '[add-worklog 1a2b3c4] Add work log to progress-panel\n 3 files changed', stderr: '', interrupted: false }, text: 'ok' } as never
    }
    if (call.tool === 'Bash' && call.command?.includes('--watch')) return { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' }, text: 'ok' } as never

    return { result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' } as never
  })

  await $.turn.start({ text: '直して', turnId: 't1' })
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Edit', file_path: 'C:/repo/hooks/register.tsx', old_string: 'a', new_string: 'b' } as never)
  await $.tool.call({ tool: 'Write', file_path: 'C:/repo/hooks/worklog.ts', content: 'x' } as never)
  await w.clock.advance(60_000)
  await $.tool.call({ tool: 'Bash', command: 'claude plugin test . --fail-fast fail' } as never)
  await $.tool.call({ tool: 'Bash', command: 'claude plugin test .' } as never)
  await $.tool.call({ tool: 'Bash', command: 'npx tsc -p .' } as never)
  await $.tool.call({ tool: 'Bash', command: 'npx vitest --watch', run_in_background: true } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls -la' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "Add work log"' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'progress-panel', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /作業ログ（全 7 件・\/worklog で全件）/ })).toBeDefined()
    // The latest five: the edits scrolled off.
    expect(await ui.find({ type: 'Text', text: /register\.tsx/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /15:01 ✗ テスト claude plugin test \. --fail-fast fail/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /15:01 ✓ テスト claude plugin test \.$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /15:01 ✓ チェック npx tsc -p \./ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /15:01 … テスト npx vitest --watch/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /15:01 コミット 1a2b3c4 Add work log to progress-panel/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /ls -la/ })).toBeUndefined()
    await ui.unmount()
  }

  const out = await $.command.run({ command: 'worklog', args: '' } as never)
  const text = (out as { text?: string }).text ?? ''
  expect(text).toContain('- 15:00 編集 C:/repo/hooks/register.tsx ×3')
  expect(text).toContain('- 15:00 編集 C:/repo/hooks/worklog.ts')
  expect(text).toContain('### 変更したファイル\n- C:/repo/hooks/register.tsx\n- C:/repo/hooks/worklog.ts')
  expect(text).toContain('- 成功: `claude plugin test .`（15:01）')
  expect(text).toContain('- 失敗: `claude plugin test . --fail-fast fail`（15:01）')
  expect(text).toContain('- バックグラウンド: `npx vitest --watch`（15:01）')
  expect(text).toContain('### コミット\n- 1a2b3c4 Add work log to progress-panel')
})

test('a subagent call is logged under its type, and a failed edit is not logged', async ($, on) => {
  world(on)
  on('agent.spawn', async () => ({ model: 'm', agentId: 'a1' }) as never)
  on('tool.call', async (_$, e) =>
    ((e as unknown as { old_string?: string }).old_string === 'missing'
      ? { result: 'String not found', isError: true, text: 'String not found' }
      : { result: { stdout: '', stderr: '', interrupted: false }, text: 'ok' }) as never,
  )
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'u1', description: 'やる', subagentType: 'worker' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/r/a.ts', old_string: 'missing', new_string: 'b' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/r/b.ts', old_string: 'a', new_string: 'b', agentId: 'a1' } as never)
  const text = ((await $.command.run({ command: 'worklog', args: '' } as never)) as { text?: string }).text ?? ''
  expect(text).toContain('［worker］編集 /r/b.ts')
  expect(text).not.toContain('a.ts')
})

test('/worklog says so when nothing was logged', async ($, on) => {
  world(on)
  const out = (await $.command.run({ command: 'worklog', args: '' } as never)) as { text?: string }
  expect(out.text).toContain('作業ログはまだありません')
})

test('commands are told apart as tests and checks', () => {
  expect(classify('npm test')).toBe('test')
  expect(classify('cd app && pnpm run test -- --run')).toBe('test')
  expect(classify('python -m pytest -q')).toBe('test')
  expect(classify('go test ./...')).toBe('test')
  expect(classify('claude plugin test plugins/progress-panel')).toBe('test')
  expect(classify('npx tsc --noEmit')).toBe('check')
  expect(classify('npm run lint')).toBe('check')
  expect(classify('claude plugin validate .')).toBe('check')
  expect(classify('git status')).toBeUndefined()
  expect(classify('cat latest.txt')).toBeUndefined()
})

test('secrets in a command are masked and long commands cut', () => {
  expect(maskCommand('API_KEY=abc123 npm test')).toBe('API_KEY=*** npm test')
  // The closing quote stays: only the credential is replaced.
  expect(maskCommand('curl -H "Authorization: Bearer xyz" x')).toBe('curl -H "Authorization: Bearer ***" x')
  expect(maskCommand('gh auth login --with-token ghp_abcdefghijklmnop')).toBe('gh auth login --with-token ***')
  expect(maskCommand(`run ${'a'.repeat(40)}`)).toBe('run ***')
  expect(maskCommand('npm test\nsecond line')).toBe('npm test')
  expect(maskCommand(`npm test ${'-x '.repeat(40)}`)).toHaveLength(80)
})

test('commit output is read for the hash and subject', () => {
  expect(parseCommit('[main abc1234] Fix it\n 1 file changed')).toEqual({ hash: 'abc1234', subject: 'Fix it' })
  expect(parseCommit('[main (root-commit) abc1234] First')).toEqual({ hash: 'abc1234', subject: 'First' })
  expect(parseCommit('nothing to commit, working tree clean')).toBeUndefined()
})

test('only consecutive edits of one file are folded', () => {
  const edit = (path: string, agent?: string) => ({ kind: 'edit', t: 0, path, count: 1, agent }) as const
  const log = [edit('a'), edit('a'), edit('b'), edit('a'), edit('a', 'worker')].reduce(addEntry, [] as Parameters<typeof addEntry>[0])
  expect(log.map(e => (e.kind === 'edit' ? `${e.path}${e.count}${e.agent ?? ''}` : ''))).toEqual(['a2', 'b1', 'a1', 'a1worker'])
  expect(worklogMarkdown(log)).toContain('### 変更したファイル\n- a\n- b')
})

test('a quiet commit is read from HEAD where it ran, once, and only when just made', async ($, on) => {
  world(on)
  const now = at(15, 0)
  const heads: Record<string, string> = {
    'C:/ARIMA/wt/x': `9f8e7d6\t${now / 1000 - 30}\tQuiet commit`,
    here: `5a5a5a5\t${now / 1000 - 3600}\tAn old commit`,
  }
  const asked: (readonly string[])[] = []
  on('process.run', async (_$, e) => {
    asked.push(e.argv)
    const dir = e.argv[1] === '-C' ? (e.argv[2] ?? '') : 'here'

    return { value: { exitCode: 0, stdout: `${heads[dir] ?? ''}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('tool.call', async () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: 'ok' }) as never)

  await $.turn.start({ text: '直して', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: "cd /c/ARIMA/wt/x && git add -A && git commit -q -F - <<'EOF2'" } as never)
  // The same HEAD again (a commit that did nothing but exited 0) is not a second commit.
  await $.tool.call({ tool: 'Bash', command: 'git -C C:/ARIMA/wt/x commit -q -m again' } as never)
  // An hour-old HEAD was not made by this command.
  await $.tool.call({ tool: 'Bash', command: 'git commit -q -m "nothing"; echo done' } as never)

  expect(asked.filter(a => a.includes('log'))).toEqual([
    ['git', '-C', 'C:/ARIMA/wt/x', 'log', '-1', '--format=%h%x09%ct%x09%s'],
    ['git', '-C', 'C:/ARIMA/wt/x', 'log', '-1', '--format=%h%x09%ct%x09%s'],
    ['git', 'log', '-1', '--format=%h%x09%ct%x09%s'],
  ])
  const text = ((await $.command.run({ command: 'worklog', args: '' } as never)) as { text?: string }).text ?? ''
  expect(text).toContain('### コミット\n- 9f8e7d6 Quiet commit')
  expect(text).not.toContain('5a5a5a5')
})

test('where a commit ran is read from git -C or the last cd before it', () => {
  expect(commitDir('git commit -q -m x')).toBeUndefined()
  expect(commitDir('cd /c/ARIMA/wt/a && git commit -q -m x')).toBe('C:/ARIMA/wt/a')
  expect(commitDir('cd a; cd "C:/b c" && git add -A && git commit -q')).toBe('C:/b c')
  expect(commitDir('git -c user.name=x -C ../repo commit -q')).toBe('../repo')
  expect(commitDir("Set-Location 'C:\ARIMA\wt\a'; git commit -q -m x")).toBe('C:\ARIMA\wt\a')
  expect(commitDir('git status')).toBeUndefined()
  expect(parseHead('abc1234\t1729000000\tFix it\n')).toEqual({ hash: 'abc1234', at: 1729000000000, subject: 'Fix it' })
  expect(parseHead('fatal: not a git repository')).toBeUndefined()
})
