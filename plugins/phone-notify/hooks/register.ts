import type { EngineInterface, Register } from 'claude-code'

import { done, failed, folderName, fromMod, isRepeat, keyOf, ntfyRequest, question, SETUP, waiting, type Note } from './message'

const LABEL = { plugin: 'phone-notify', key: 'label' } as const
const LAST_SENT = { plugin: 'phone-notify', key: 'lastSent' } as const
const HAS_FAILED = { plugin: 'phone-notify', key: 'hasFailed' } as const

type Settings = {
  topic: string
  server: string
  doneAfterMs: number
  isWaitingOn: boolean
  isDoneOn: boolean
  isErrorOn: boolean
  isModsOn: boolean
}

function settingsOf(options: Record<string, unknown>): Settings {
  const on = (key: string) => options[key] !== false

  return {
    topic: String(options.topic ?? '').trim(),
    server: String(options.server ?? 'https://ntfy.sh').trim() || 'https://ntfy.sh',
    doneAfterMs: Math.max(0, Number(options.doneAfterMinutes ?? 3)) * 60_000,
    isWaitingOn: on('notifyWaiting'),
    isDoneOn: on('notifyDone'),
    isErrorOn: on('notifyError'),
    isModsOn: on('notifyMods'),
  }
}

async function label($: EngineInterface): Promise<string> {
  return (await $.state.get(LABEL)).value ?? ''
}

// Sends one note; `ok` when ntfy took it. A failure is shown once a session and never stops the work.
async function send($: EngineInterface, s: Settings, note: Note, isTest = false): Promise<{ ok: boolean; reason?: string }> {
  if (!s.topic) return { ok: false, reason: 'トピック名が未設定' }
  const now = await $.clock.now()
  if (!isTest && isRepeat((await $.state.get(LAST_SENT)).value ?? null, note, now)) return { ok: true }
  const { url, body } = ntfyRequest(s.server, s.topic, note)
  const res = await $.http
    .fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    .then(
      (r): { ok: boolean; reason?: string } => (r.ok ? { ok: true } : { ok: false, reason: `HTTP ${r.status}` }),
      (err: unknown) => ({ ok: false, reason: err instanceof Error ? err.message : String(err) }),
    )
  if (res.ok) {
    await $.state.set(LAST_SENT, { key: keyOf(note), at: now })
  } else if (!isTest && !(await $.state.get(HAS_FAILED)).value) {
    await $.state.set(HAS_FAILED, true)
    $.ui.toast(`スマホ通知を送れませんでした（${res.reason ?? '不明'}）`)
  }

  return res
}

export const register: Register = (on, options) => {
  const s = settingsOf(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.state.set(LABEL, folderName(started.cwd)).catch(() => {})
    await $.command.register({ name: 'phone-notify', description: 'スマホにテスト通知を送る（ntfy の設定の確認）' })
    if (!s.topic) $.ui.toast(SETUP, { timeoutMs: 10_000 })

    return started
  })

  on('command.run', { command: 'phone-notify' }, async $ => {
    if (!s.topic) return { text: SETUP }
    const where = (await label($)) || 'Claude Code'
    const res = await send($, s, { title: `【${where}】テスト通知`, message: 'スマホ通知の設定ができています', priority: 3, tags: ['tada'] }, true)

    return {
      text: res.ok
        ? `テスト通知を送りました（${s.server}）。スマホに届いたか確かめてください。`
        : `テスト通知を送れませんでした（${res.reason ?? '不明'}）。サーバーとトピック名を確かめてください。`,
    }
  })

  // The engine's own waits (an approval) and the notices other mods raise with $.ui.notify.
  on('classic.Notification', async ($, e, next) => {
    const below = await next(e)
    const where = await label($).catch(() => '')
    if (e.notification_type === 'plugin_notification') {
      if (s.isModsOn) await send($, s, fromMod(where, e.title, e.message)).catch(() => {})
    } else if (e.notification_type !== 'idle_prompt' && s.isWaitingOn) {
      await send($, s, waiting(where, e.message)).catch(() => {})
    }

    return below
  })

  // A question waits for the person: the note goes out before the wait.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (s.isWaitingOn && e.agentId === undefined) {
      const first = (e as unknown as { questions?: { question?: unknown }[] }).questions?.[0]?.question
      await send($, s, question(await label($), typeof first === 'string' ? first : '')).catch(() => {})
    }

    return next(e)
  })

  // The end of a long piece of work; the person's own interruption and short turns are not news.
  on('turn.complete', async ($, e, next) => {
    const below = await next(e)
    if (s.isDoneOn && e.agentId === undefined && e.reason === 'answer' && e.durationMs >= s.doneAfterMs) {
      await send($, s, done(await label($), e.durationMs)).catch(() => {})
    }

    return below
  })

  on('classic.StopFailure', async ($, e, next) => {
    const below = await next(e)
    if (s.isErrorOn && e.agent_id === undefined) await send($, s, failed(await label($), e.error)).catch(() => {})

    return below
  })
}
