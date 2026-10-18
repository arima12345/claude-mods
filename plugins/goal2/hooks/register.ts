import type { EngineInterface, Register } from 'claude-code'

import type { Goal } from '../types'

const GOAL = { plugin: 'goal2', key: 'goal' } as const
const VERIFIER = 'goal2:verifier'

// Waits before an automatic restart after an error: 1, 5, then 15 minutes.
const RETRY_DELAYS = [60_000, 300_000, 900_000]
const MAX_RETRIES = 6
// The same unmet reason this many times in a row: first change approach, then stop.
const SAME_REASON_NUDGE = 3
const SAME_REASON_PAUSE = 5
const MAX_VERIFIER_FAILS = 3
// Errors no restart can fix.
const FATAL_ERRORS = ['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'billing_error', 'model_not_found', 'cloud_credential_error']

const VERIFIER_PROMPT = `あなたはゴール達成の確認役です。作業した本人とは別の立場で、ゴールの条件が本当に満たされているかを実物で確かめます。

- ファイルを開く、コマンドやテストを実行するなどして、条件の一つひとつに証拠を集めてください。
- 会話の中の「できました」という言葉は証拠になりません。
- ファイルを書き換えたり、作業の続きをしたりしてはいけません。確かめるだけです。
- 最後の行は必ず次のどちらかにしてください。
  VERDICT: MET
  VERDICT: NOT_MET: <足りない点を一文で>`

type Verdict = { verdict: 'met' | 'not_met' | 'needs_user'; reason: string; same: boolean }

// Set from the plugin's options each time the module loads.
let judgeModel = 'haiku'
let verifierModel = 'sonnet'
let maxChecks = 30

// A command cannot start a turn while it runs, so the prompt goes out just after.
function submitSoon($: EngineInterface, text: string): void {
  $.clock.after(100, async () => {
    await $.prompt.submit({ text })
  })
}

async function getGoal($: EngineInterface): Promise<Goal | null> {
  return (await $.state.get(GOAL)).value ?? null
}

async function setGoal($: EngineInterface, goal: Goal | null): Promise<void> {
  await $.state.set(GOAL, goal)
  $.ui.status(goal === null ? undefined : statusLine(goal))
}

async function pause($: EngineInterface, goal: Goal, why: string): Promise<void> {
  await setGoal($, { ...goal, status: 'paused', pauseReason: why })
  $.ui.toast(`ゴールを一時停止: ${why}`)
  await $.ui.notify(`${why}。/goal2 resume で再開できます。`, { title: 'ゴール一時停止' })
}

export const register: Register = (on, options) => {
  judgeModel = String(options.judgeModel ?? 'haiku')
  verifierModel = String(options.verifierModel ?? 'sonnet')
  maxChecks = Number(options.maxChecks ?? 30)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'goal2',
      description: 'ゴールを決めて、本当に達成するまで作業を続ける',
      argumentHint: '[<条件> [--check "<確認コマンド>"] | clear | resume]',
      immediate: true,
    })
    await $.agent.register({
      name: 'verifier',
      description: 'goal2 のゴールが本当に達成されたかを実物で確かめる確認役',
      prompt: VERIFIER_PROMPT,
      disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
      model: verifierModel,
    })
    const goal = await getGoal($)
    if (goal !== null) $.ui.status(statusLine(goal))

    return next(e)
  })

  // The verifier is the plugin's own: the model never sees it as an agent to call.
  on('agent.offer', { agent: VERIFIER }, () => ({ isOffered: false }))

  on('command.run', { command: 'goal2' }, async ($, e) => {
    const args = e.args.trim()
    const goal = await getGoal($)

    if (args === '') {
      if (goal === null) return { text: 'ゴールは設定されていません。/goal2 <条件> で設定します。' }
      const last = goal.lastReason === null ? '' : `\n最後の判定: ${goal.lastReason}`
      const paused = goal.status === 'paused' ? `\n一時停止中: ${goal.pauseReason ?? ''}（/goal2 resume で再開）` : ''

      return { text: `ゴール: ${goal.condition}\n${statusLine(goal)}${last}${paused}` }
    }

    if (args === 'clear') {
      await setGoal($, null)

      return { text: goal === null ? 'ゴールは設定されていません。' : `ゴールを取り消しました: ${goal.condition}` }
    }

    if (args === 'resume') {
      if (goal === null) return { text: 'ゴールは設定されていません。' }
      const resumed: Goal = { ...goal, status: 'active', pauseReason: null, sameReasonCount: 0, retries: 0, verifierFails: 0, checks: Math.min(goal.checks, maxChecks - 5) }
      await setGoal($, resumed)
      submitSoon($, continuePrompt(resumed, 'ゴールを再開します。'))

      return { text: `ゴールを再開しました: ${goal.condition}` }
    }

    const { condition, check } = parseArgs(args)
    if (condition === '') return { text: '条件が空です。/goal2 <条件> の形で書いてください。' }
    const fresh: Goal = {
      condition,
      check,
      setAt: await $.clock.now(),
      status: 'active',
      pauseReason: null,
      checks: 0,
      lastReason: null,
      sameReasonCount: 0,
      retries: 0,
      verifierAgentId: null,
      verifierFails: 0,
    }
    await setGoal($, fresh)
    submitSoon($, kickoffPrompt(fresh))

    return { text: `ゴールを設定しました: ${condition}${check === null ? '' : `\n確認コマンド: ${check}`}` }
  })

  // Every time the main Claude tries to stop: judge, and keep it working while unmet.
  on('classic.Stop', async ($, e, next) => {
    const below = await next(e)
    if (e.agent_id !== undefined || below.block !== undefined) return below
    const goal = await getGoal($)
    if (goal === null || goal.status !== 'active') return below

    const counted: Goal = { ...goal, checks: goal.checks + 1, retries: 0 }
    if (counted.checks > maxChecks) {
      await pause($, counted, `判定が上限の${maxChecks}回に達しました`)

      return below
    }

    if (counted.check !== null) {
      const ran = await runCheck($, counted.check)
      if (!ran.ok) return block($, counted, `確認コマンド「${counted.check}」が通りませんでした。\n${ran.output}`, false)
    }

    const verdict = await judge($, counted, e.last_assistant_message ?? '')
    if (verdict.verdict === 'needs_user') {
      await pause($, { ...counted, lastReason: verdict.reason }, `あなたの判断が必要です: ${verdict.reason}`)

      return below
    }
    if (verdict.verdict === 'not_met') return block($, counted, verdict.reason, verdict.same)

    const spawned = await $.agent.spawn({
      subagentType: VERIFIER,
      description: 'ゴール達成の確認',
      model: verifierModel,
      prompt: verifierTask(counted),
    })
    if (spawned.deny !== undefined) {
      await setGoal($, null)
      $.ui.toast(`確認役を起動できなかったため、軽い判定だけで達成としました: ${spawned.deny}`)

      return below
    }
    await setGoal($, { ...counted, status: 'verifying', lastReason: '確認役が確認中', verifierAgentId: spawned.agentId ?? null })

    return below
  })

  // The verifier's answer arrives as its turn's end.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const goal = await getGoal($)
    if (goal === null || goal.status !== 'verifying' || e.agentId === undefined) return done
    // Where the spawn reported no id, the verifier is known by its verdict line.
    const isVerifier = goal.verifierAgentId === null ? /VERDICT:/i.test(e.answer) : e.agentId === goal.verifierAgentId
    if (!isVerifier) return done

    const found = /VERDICT:\s*(MET|NOT_MET)(?::\s*(.*))?\s*$/i.exec(e.answer.trim())
    if (found?.[1]?.toUpperCase() === 'MET') {
      await setGoal($, null)
      $.ui.toast(`ゴール達成（確認役が確認済み）: ${goal.condition}`)
      await $.ui.notify(`確認役が確認しました: ${goal.condition}`, { title: 'ゴール達成' })

      return done
    }

    const missing = found?.[2]?.trim() || (e.isAborted ? '確認役が途中で止まりました' : '確認役が達成を確認できませんでした')
    const failed: Goal = { ...goal, status: 'active', verifierAgentId: null, verifierFails: goal.verifierFails + 1, lastReason: missing }
    if (failed.verifierFails >= MAX_VERIFIER_FAILS) {
      await pause($, failed, `確認役が${failed.verifierFails}回続けて未達と判断しました（${missing}）`)

      return done
    }
    await setGoal($, failed)
    await $.prompt.submit({ text: continuePrompt(failed, `確認役が実物を確かめたところ、まだ達成されていませんでした。\n足りない点: ${missing}`) })

    return done
  })

  // A turn the API ended: restart on a timer instead of waiting for the person.
  on('classic.StopFailure', async ($, e, next) => {
    const below = await next(e)
    const goal = await getGoal($)
    if (e.agent_id !== undefined || goal === null || goal.status !== 'active') return below

    if (FATAL_ERRORS.includes(String(e.error))) {
      await pause($, goal, `自動では直せないエラーで止まりました（${String(e.error)}）`)

      return below
    }
    if (goal.retries >= MAX_RETRIES) {
      await pause($, goal, `エラーで${goal.retries}回止まり、自動再開をあきらめました（${String(e.error)}）`)

      return below
    }

    const delay = RETRY_DELAYS[Math.min(goal.retries, RETRY_DELAYS.length - 1)] ?? 900_000
    const waiting: Goal = { ...goal, retries: goal.retries + 1, lastReason: `エラーで停止（${String(e.error)}）。${delay / 60_000}分後に自動再開` }
    await setGoal($, waiting)
    $.clock.after(delay, async () => {
      const now = await getGoal($)
      if (now === null || now.setAt !== waiting.setAt || now.status !== 'active') return
      await $.prompt.submit({ text: continuePrompt(now, 'エラーで止まっていた作業を自動で再開します。') })
    })

    return below
  })
}

async function block($: EngineInterface, goal: Goal, reason: string, same: boolean): Promise<{ block?: string }> {
  const sameReasonCount = same ? goal.sameReasonCount + 1 : 0
  const next: Goal = { ...goal, lastReason: firstLine(reason), sameReasonCount }
  if (sameReasonCount >= SAME_REASON_PAUSE) {
    await pause($, next, `同じ理由で${sameReasonCount}回続けて未達です（${firstLine(reason)}）`)

    return {}
  }
  await setGoal($, next)
  const nudge = sameReasonCount >= SAME_REASON_NUDGE
    ? `\n同じ理由で${sameReasonCount}回続けて未達です。今のやり方を続けず、別の方法を試してください。`
    : ''

  return { block: `ゴール「${goal.condition}」はまだ達成されていません（判定${goal.checks}/${maxChecks}回目）。\n足りない点: ${reason}${nudge}\nユーザーに確認せず、そのまま作業を続けてください。` }
}

async function judge($: EngineInterface, goal: Goal, lastAnswer: string): Promise<Verdict> {
  const messages = await $.session.messages()
  const recent = messages
    .slice(-20)
    .map(m => {
      const tools = m.toolUses.map(t => `[${t.tool}${t.isError === true ? ' 失敗' : ''}] ${clip(t.text ?? '', 300)}`).join('\n')

      return `${m.role === 'user' ? 'ユーザー' : 'Claude'}: ${clip(m.text, 1500)}${tools === '' ? '' : `\n${tools}`}`
    })
    .join('\n\n')

  const prompt = `あなたは作業の判定役です。会話の記録を読み、ゴールの条件が満たされたかを判定します。

ゴールの条件:
${goal.condition}

判定の決まり:
- 条件を満たした証拠（テストの結果、作ったファイル、コマンドの出力など）が記録にあるときだけ "met" にする。
- Claude が「できました」と書いただけで証拠がないなら "not_met"。
- ユーザーにしか決められないこと（好みの選択、パスワード、お金のかかる操作）で止まっているときだけ "needs_user"。
- 「難しい」「後でやる」は "not_met" であり、あきらめる理由にはならない。
- 前回の未達理由: ${goal.lastReason ?? 'なし'}。今回の未達理由が実質的に同じなら same を true にする。

最後の Claude の返事:
${clip(lastAnswer, 2000)}

最近の会話:
${clip(recent, 12_000)}

JSONだけで答えてください: {"verdict": "met" | "not_met" | "needs_user", "reason": "<一文>", "same": true | false}`

  const reply = await $.model.complete({ model: judgeModel, prompt, maxTokens: 400, timeoutMs: 60_000 })
  if (!reply.isAnswered) return { verdict: 'not_met', reason: '判定役が応答しませんでした。作業を続け、達成したら証拠を示してください', same: false }

  return parseVerdict(reply.text)
}

function parseArgs(args: string): { condition: string; check: string | null } {
  const found = /\s*--check\s+(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/.exec(args)
  if (found === null) return { condition: args.trim(), check: null }

  return { condition: args.slice(0, found.index).trim(), check: (found[1] ?? found[2] ?? found[3] ?? '').trim() || null }
}

function parseVerdict(text: string): Verdict {
  const json = /\{[\s\S]*\}/.exec(text)?.[0]
  try {
    const parsed = JSON.parse(json ?? '') as Partial<Verdict>
    const verdict = parsed.verdict === 'met' || parsed.verdict === 'needs_user' ? parsed.verdict : 'not_met'

    return { verdict, reason: String(parsed.reason ?? '理由なし'), same: parsed.same === true }
  } catch {
    return { verdict: 'not_met', reason: '判定役の答えを読めませんでした。作業を続け、達成したら証拠を示してください', same: false }
  }
}

async function runCheck($: EngineInterface, command: string): Promise<{ ok: boolean; output: string }> {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const argv = isWindows ? ['cmd', '/c', command] : ['sh', '-c', command]
  try {
    const ran = await $.process.run(argv, { timeoutMs: 600_000 })

    return { ok: ran.exitCode === 0, output: tail(`${ran.stdout}\n${ran.stderr}`, 1500) }
  } catch (error) {
    return { ok: false, output: `実行できませんでした: ${String(error)}` }
  }
}

function kickoffPrompt(goal: Goal): string {
  return `ゴールを設定しました: 「${goal.condition}」
${goal.check === null ? '' : `完了の確認には「${goal.check}」が通る必要があります。\n`}この条件を満たすまで、ユーザーに確認せずに作業を進めてください。終わるときは、条件を満たした証拠（テスト結果、作ったファイル、コマンドの出力など）を示してください。`
}

function continuePrompt(goal: Goal, lead: string): string {
  return `${lead}
ゴール: 「${goal.condition}」
ユーザーに確認せず、条件を満たすまで作業を続けてください。終わるときは証拠を示してください。`
}

function verifierTask(goal: Goal): string {
  return `次のゴールが本当に達成されているかを、実物で確かめてください。

ゴールの条件:
${goal.condition}
${goal.check === null ? '' : `\n確認コマンド「${goal.check}」はすでに通っています。\n`}
最後の行に VERDICT: MET か VERDICT: NOT_MET: <足りない点> を書いてください。`
}

function statusLine(goal: Goal): string {
  const state = goal.status === 'paused' ? '一時停止中' : goal.status === 'verifying' ? '確認役が確認中' : '実行中'
  const last = goal.lastReason === null || goal.status === 'verifying' ? '' : ` · 未達: ${clip(goal.lastReason, 40)}`

  return `ゴール${state} · 判定${goal.checks}/${maxChecks}${last}`
}

function firstLine(text: string): string {
  return clip(text.split('\n')[0] ?? '', 200)
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function tail(text: string, max: number): string {
  const trimmed = text.trim()

  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`
}
