import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

type Fakes = { verdicts: string[]; submitted: string[]; spawned: string[]; toasts: string[]; checkExit: number; clock: ReturnType<typeof mock.clock> }

// Stands in for the engine beneath the plugin: the judge model, the transcript, the verifier spawn.
function fake(on: On): Fakes {
  const f: Fakes = { verdicts: [], submitted: [], spawned: [], toasts: [], checkExit: 0, clock: mock.clock(on) }
  on('model.complete', async () => {
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
