import type { EngineInterface, Register } from 'claude-code'

import { done, failed, folderName, fromMod, isRepeat, keyOf, notice, ntfyRequest, QUIET_KINDS, question, SETUP, waiting, WAITING_KINDS, type Note } from './message'

const LABEL = { plugin: 'phone-notify', key: 'label' } as const
const LAST_SENT = { plugin: 'phone-notify', key: 'lastSent' } as const
const HAS_FAILED = { plugin: 'phone-notify', key: 'hasFailed' } as const
const ASKED = { plugin: 'phone-notify', key: 'asked' } as const

// A send that ntfy has not answered by then is given up: the phone is late, the work never waits.
export const SEND_TIMEOUT_MS = 10_000

// The desktop app's next-step box: a turn that ends asking the person something.
const WRAP_UP = 'mcp__ccd_turn__wrap_up'

type Settings = {
  topic: string
  server: string
  doneAfterMs: number
  isWaitingOn: boolean
  isDoneOn: boolean
  isErrorOn: boolean
  isModsOn: boolean
  isModDetailed: boolean
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
    isModDetailed: options.modDetail === true,
  }
}

async function label($: EngineInterface): Promise<string> {
  return (await $.state.get(LABEL)).value ?? ''
}

type Sent = { ok: boolean; reason?: string }

// ntfy's answer, or a failure once SEND_TIMEOUT_MS has passed without one.
function post($: EngineInterface, url: string, body: string): Promise<Sent> {
  return new Promise<Sent>(resolve => {
    const timer = $.clock.after(SEND_TIMEOUT_MS, () => resolve({ ok: false, reason: `${SEND_TIMEOUT_MS / 1000}秒で応答なし` }))
    void $.http
      .fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      .then(
        (r): Sent => (r.ok ? { ok: true } : { ok: false, reason: `HTTP ${r.status}` }),
        (err: unknown): Sent => ({ ok: false, reason: err instanceof Error ? err.message : String(err) }),
      )
      .then(res => {
        timer.cancel()
        resolve(res)
      })
  })
}

// The last note this module marked, set with no wait after its check: two sends of one note at once,
// both past their reads, still see each other. $.state keeps the mark across a reload.
let lastMark: { key: string; at: number } | null = null

// Sends one note; `ok` when ntfy took it. A failure is shown once a session and never stops the work.
// The note is marked sent before it goes, so the same note raised twice at once goes once.
async function send($: EngineInterface, s: Settings, note: Note, isTest = false): Promise<Sent> {
  if (!s.topic) return { ok: false, reason: 'トピック名が未設定' }
  const now = await $.clock.now()
  const mark = { key: keyOf(note), at: now }
  if (!isTest) {
    const stored = (await $.state.get(LAST_SENT)).value ?? null
    if (isRepeat(lastMark, note, now) || isRepeat(stored, note, now)) return { ok: true }
    lastMark = mark
    await $.state.set(LAST_SENT, mark)
  }
  const { url, body } = ntfyRequest(s.server, s.topic, note)
  const res = await post($, url, body)
  if (res.ok) {
    if (isTest) await $.state.set(LAST_SENT, mark)
  } else if (!isTest) {
    // A note that did not go may go again: the mark is taken back unless a later one replaced it.
    if (lastMark === mark) lastMark = null
    const last = (await $.state.get(LAST_SENT)).value
    if (last?.key === mark.key && last.at === mark.at) await $.state.set(LAST_SENT, null)
    if (!(await $.state.get(HAS_FAILED)).value) {
      await $.state.set(HAS_FAILED, true)
      $.ui.toast(`スマホ通知を送れませんでした（${res.reason ?? '不明'}）`)
    }
  }

  return res
}

// Sends without the hook waiting for it: a question shows, a turn ends, at once, however slow ntfy is.
function sendSoon($: EngineInterface, s: Settings, note: Note | Promise<Note>): void {
  void Promise.resolve(note)
    .then(n => send($, s, n))
    .catch(() => {})
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

  // The engine's own waits (an approval), the notices other mods raise with $.ui.notify, and anything else
  // it raises, which goes as a plain notice rather than as a wait it may not be.
  on('classic.Notification', async ($, e, next) => {
    const below = await next(e)
    const kind = e.notification_type
    if (kind === 'plugin_notification') {
      if (s.isModsOn) sendSoon($, s, label($).then(where => fromMod(where, e.title, e.message, s.isModDetailed)))
    } else if (WAITING_KINDS.includes(kind)) {
      if (s.isWaitingOn) sendSoon($, s, label($).then(where => waiting(where, e.message)))
    } else if (!QUIET_KINDS.includes(kind) && s.isWaitingOn) {
      sendSoon($, s, label($).then(where => notice(where, e.message)))
    }

    return below
  })

  // A question waits for the person: the note goes out as it shows. Asked mid-turn, the work goes on
  // once answered, so the turn's end is still news.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (s.isWaitingOn && e.agentId === undefined) {
      const first = (e as unknown as { questions?: { question?: unknown }[] }).questions?.[0]?.question
      sendSoon($, s, label($).then(where => question(where, typeof first === 'string' ? first : '')))
    }

    return next(e)
  })

  // The desktop app's turns often end with a question in the next-step box, however short the turn.
  // That question is the turn's last word: its end is not told again as finished work.
  on('tool.call', { tool: WRAP_UP }, async ($, e, next) => {
    const ran = await next(e)
    const ask = (e as unknown as { ask?: unknown }).ask
    if (s.isWaitingOn && e.agentId === undefined && ran.deny === undefined && typeof ask === 'string' && ask.trim() !== '') {
      await $.state.set(ASKED, true).catch(() => {})
      sendSoon($, s, label($).then(where => question(where, ask)))
    }

    return ran
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await $.state.set(ASKED, false).catch(() => {})

    return next(e)
  })

  // The end of a long piece of work; the person's own interruption and short turns are not news,
  // and a turn that ended asking in the next-step box was already told as a question.
  on('turn.complete', async ($, e, next) => {
    const below = await next(e)
    if (s.isDoneOn && e.agentId === undefined && e.reason === 'answer' && e.durationMs >= s.doneAfterMs) {
      const asked = (await $.state.get(ASKED).catch(() => undefined))?.value === true
      if (!asked) sendSoon($, s, label($).then(where => done(where, e.durationMs)))
    }

    return below
  })

  on('classic.StopFailure', async ($, e, next) => {
    const below = await next(e)
    if (s.isErrorOn && e.agent_id === undefined) sendSoon($, s, label($).then(where => failed(where, e.error)))

    return below
  })
}
