import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

type Fakes = { verdicts: string[]; judged: string[]; submitted: string[]; spawned: string[]; toasts: string[]; checkExit: number; clock: ReturnType<typeof mock.clock> }

// Stands in for the engine beneath the plugin: the judge model, the transcript, the verifier spawn.
function fake(on: On): Fakes {
  const f: Fakes = { verdicts: [], judged: [], submitted: [], spawned: [], toasts: [], checkExit: 0, clock: mock.clock(on) }
  on('model.complete', async (_$, e) => {
    f.judged.push(e.prompt)
    const text = f.verdicts.shift() ?? '{"verdict":"not_met","reason":"まだ","same":false}'

    return { value: { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } } as never
  })
  on('session.messages', async () => ({ value: [{ role: 'assistant', text: 'できました', toolUses: [] }] }) as never)
  mock.env(on, {})
  on('prompt.submit', async (_$, e) => {
    f.submitted.push(e.text)

    return { text: e.text } as never
  })
  on('classic.Stop', async () => ({}))
  on('classic.StopFailure', async () => ({}))
  on('turn.complete', async () => ({ text: '' }))
  on('agent.spawn', async (_$, e) => {
    f.spawned.push(e.prompt)

    return { model: 'sonnet', agentId: 'verifier-1' }
  })
  on('process.run', async () => ({ value: { exitCode: f.checkExit, stdout: f.checkExit === 0 ? 'ok' : '1 failed', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never)
  on('ui.toast', async (_$, e) => {
    f.toasts.push(String(e.text))

    return { value: undefined } as never
  })
  on('ui.notify', async () => ({ value: { isSent: false, reason: 'no-surface' } }) as never)
  on('ui.status', async () => ({ value: undefined }) as never)

  return f
}

// Runs the command, then lets the prompt it queues go out.
async function goal2(f: Fakes, run: () => Promise<{ text?: string }>) {
  const ran = await run()
  await f.clock.advance(200)

  return ran
}

const stop = { stop_hook_active: false, last_assistant_message: 'できました' }

test('keeps working while unmet, and ends only once the verifier confirms', async ($, on) => {
  const f = fake(on)
  const set = await goal2(f, () => $.command.run({ command: 'goal2', args: '日記を追加できる --check "npm test"' } as never))
  expect(set.text).toContain('ゴールを設定しました: 日記を追加できる')
  expect(f.submitted.at(-1)).toContain('npm test')

  // The check command fails: blocked without asking the judge.
  f.checkExit = 1
  const failed = await $.classic.Stop(stop)
  expect(failed.block).toContain('確認コマンド「npm test」が通りませんでした')

  // The check passes but the judge says unmet: blocked with the reason.
  f.checkExit = 0
  f.verdicts.push('{"verdict":"not_met","reason":"一覧に表示されていない","same":false}')
  const unmet = await $.classic.Stop(stop)
  expect(unmet.block).toContain('一覧に表示されていない')

  // The judge says met: the stop goes through and the verifier starts.
  f.verdicts.push('{"verdict":"met","reason":"テストが通った","same":false}')
  const met = await $.classic.Stop(stop)
  expect(met.block).toBeUndefined()
  expect(f.spawned).toHaveLength(1)
  expect((await $.command.run({ command: 'goal2', args: '' } as never)).text).toContain('確認役が確認中')

  // The verifier finds something missing: work resumes on its own.
  await $.turn.complete({ reason: 'answer', answer: '調べました\nVERDICT: NOT_MET: 保存されていない', durationMs: 1, isAborted: false, turnId: 'v1', agentId: 'verifier-1' })
  expect(f.submitted.at(-1)).toContain('保存されていない')

  // Next round: met, and the verifier confirms. The goal ends.
  f.verdicts.push('{"verdict":"met","reason":"保存もできた","same":false}')
  await $.classic.Stop(stop)
  await $.turn.complete({ reason: 'answer', answer: 'VERDICT: MET', durationMs: 1, isAborted: false, turnId: 'v2', agentId: 'verifier-1' })
  expect(f.toasts.at(-1)).toContain('ゴール達成')
  const status = await goal2(f, () => $.command.run({ command: 'goal2', args: '' } as never))
  expect(status.text).toContain('ゴールは設定されていません')
})

test('the same reason three times asks for another approach, five times pauses', async ($, on) => {
  const f = fake(on)
  await goal2(f, () => $.command.run({ command: 'goal2', args: 'アプリが起動する' } as never))
  f.verdicts.push('{"verdict":"not_met","reason":"起動しない","same":false}')
  await $.classic.Stop(stop)
  for (let n = 1; n <= 3; n++) f.verdicts.push('{"verdict":"not_met","reason":"起動しない","same":true}')
  await $.classic.Stop(stop)
  await $.classic.Stop(stop)
  const third = await $.classic.Stop(stop)
  expect(third.block).toContain('別の方法を試してください')

  f.verdicts.push('{"verdict":"not_met","reason":"起動しない","same":true}', '{"verdict":"not_met","reason":"起動しない","same":true}')
  await $.classic.Stop(stop)
  const fifth = await $.classic.Stop(stop)
  expect(fifth.block).toBeUndefined()
  expect(f.toasts.at(-1)).toContain('一時停止')

  // Paused: further stops pass, until resumed.
  expect((await $.classic.Stop(stop)).block).toBeUndefined()
  await goal2(f, () => $.command.run({ command: 'goal2', args: 'resume' } as never))
  expect(f.submitted.at(-1)).toContain('再開')
})

test('needs_user pauses instead of ending', async ($, on) => {
  const f = fake(on)
  await goal2(f, () => $.command.run({ command: 'goal2', args: '公開する' } as never))
  f.verdicts.push('{"verdict":"needs_user","reason":"ストアのパスワードが必要","same":false}')
  expect((await $.classic.Stop(stop)).block).toBeUndefined()
  const status = await goal2(f, () => $.command.run({ command: 'goal2', args: '' } as never))
  expect(status.text).toContain('一時停止中')
})

test('an API error restarts the work on a timer', async ($, on) => {
  const f = fake(on)
  const clock = f.clock
  await goal2(f, () => $.command.run({ command: 'goal2', args: 'テストが通る' } as never))
  const before = f.submitted.length
  await $.classic.StopFailure({ error: 'rate_limit' })
  await clock.advance(59_000)
  expect(f.submitted.length).toBe(before)
  await clock.advance(2_000)
  expect(f.submitted.length).toBe(before + 1)
  expect(f.submitted.at(-1)).toContain('自動で再開')

  await $.classic.StopFailure({ error: 'billing_error' })
  expect(f.toasts.at(-1)).toContain('一時停止')
})

test('a check command that keeps failing asks for another approach, then pauses', async ($, on) => {
  const f = fake(on)
  await goal2(f, () => $.command.run({ command: 'goal2', args: 'テストが通る --check "npm test"' } as never))
  f.checkExit = 1
  // Left untouched unless the judge is asked.
  f.verdicts.push('{"verdict":"met","reason":"判定役","same":false}')
  const blocks: (string | undefined)[] = []
  for (let n = 1; n <= 6; n++) blocks.push((await $.classic.Stop(stop)).block)

  expect(blocks[0]).toContain('確認コマンド「npm test」が通りませんでした')
  expect(blocks[2]).not.toContain('別の方法を試してください')
  expect(blocks[3]).toContain('別の方法を試してください')
  expect(blocks[5]).toBeUndefined()
  expect(f.toasts.at(-1)).toContain('一時停止')
  // The judge was never asked: a failing check decides on its own.
  expect(f.verdicts).toHaveLength(1)
  expect((await goal2(f, () => $.command.run({ command: 'goal2', args: '' } as never))).text).toContain('一時停止中')
})

test('a check that passes in between starts the count over', async ($, on) => {
  const f = fake(on)
  await goal2(f, () => $.command.run({ command: 'goal2', args: 'テストが通る --check "npm test"' } as never))
  f.checkExit = 1
  for (let n = 1; n <= 3; n++) await $.classic.Stop(stop)
  // Passing once (the judge still says unmet) resets the run of check failures.
  f.checkExit = 0
  await $.classic.Stop(stop)
  f.checkExit = 1
  for (let n = 1; n <= 3; n++) expect((await $.classic.Stop(stop)).block).not.toContain('別の方法を試してください')
})

// The person typing at the prompt, as the engine stamps it.
const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as const

test('a question unrelated to the goal is answered and ends the turn, and the goal stays for later', async ($, on) => {
  const f = fake(on)
  await goal2(f, () => $.command.run({ command: 'goal2', args: '日記を追加できる --check "npm test"' } as never))
  // The check still fails: an off-topic answer may end the turn all the same.
  f.checkExit = 1

  await $.prompt.submit(typed('今日の天気は?'))
  f.verdicts.push('{"verdict":"off_topic","reason":"天気の質問への返事","same":false}')
  const answered = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: '晴れです' })
  expect(answered.block).toBeUndefined()
  expect(f.judged.at(-1)).toContain('今日の天気は?')
  expect(f.judged.at(-1)).toContain('off_topic')
  expect(f.toasts.at(-1)).toContain('ゴールはそのまま残っています')
  // Not counted as a check, and the goal is still running.
  const status = await goal2(f, () => $.command.run({ command: 'goal2', args: '' } as never))
  expect(status.text).toContain('ゴール実行中 · 判定0/30')

  // Back to the goal: judged as before, and the failing check keeps it working.
  await $.prompt.submit(typed('日記の続きをお願い'))
  f.verdicts.push('{"verdict":"not_met","reason":"保存がまだ","same":false}')
  const back = await $.classic.Stop(stop)
  expect(back.block).toContain('確認コマンド「npm test」が通りませんでした')
  expect(f.judged.at(-1)).toContain('日記の続きをお願い')
})

test('off_topic counts for nothing when the turn was started by goal2 itself', async ($, on) => {
  const f = fake(on)
  await goal2(f, () => $.command.run({ command: 'goal2', args: 'アプリが起動する' } as never))
  f.verdicts.push('{"verdict":"off_topic","reason":"関係ない","same":false}')
  const kept = await $.classic.Stop(stop)
  expect(kept.block).toContain('ユーザーに確認せず、そのまま作業を続けてください')
  expect(f.judged.at(-1)).not.toContain('off_topic')

  // A person's question, then goal2's own resume prompt: the question no longer stands.
  await $.prompt.submit(typed('今日の天気は?'))
  await goal2(f, () => $.command.run({ command: 'goal2', args: 'resume' } as never))
  f.verdicts.push('{"verdict":"off_topic","reason":"関係ない","same":false}')
  expect((await $.classic.Stop(stop)).block).toBeDefined()
})

test('needs_user and met keep their meaning when the person typed something', async ($, on) => {
  const f = fake(on)
  await goal2(f, () => $.command.run({ command: 'goal2', args: '公開する' } as never))
  await $.prompt.submit(typed('公開まで進めて'))
  f.verdicts.push('{"verdict":"met","reason":"公開できた","same":false}')
  expect((await $.classic.Stop(stop)).block).toBeUndefined()
  expect(f.spawned).toHaveLength(1)
  // The judge was asked once: the early answer stands as the verdict.
  expect(f.judged).toHaveLength(1)

  await $.turn.complete({ reason: 'answer', answer: 'VERDICT: NOT_MET: ストアに出ていない', durationMs: 1, isAborted: false, turnId: 'v1', agentId: 'verifier-1' })
  await $.prompt.submit(typed('パスワードは後で入れます'))
  f.verdicts.push('{"verdict":"needs_user","reason":"ストアのパスワードが必要","same":false}')
  expect((await $.classic.Stop(stop)).block).toBeUndefined()
  expect((await goal2(f, () => $.command.run({ command: 'goal2', args: '' } as never))).text).toContain('一時停止中')
})
