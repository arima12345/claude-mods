// What goes to the phone: the folder, the moment and a short reason, never code, replies or commands.
export type Note = { title: string; message: string; priority: 3 | 4; tags: string[] }

const MAX_MESSAGE = 200
const REPEAT_MS = 60_000

export const cut = (text: string, max: number) => {
  const one = text.replace(/\s+/g, ' ').trim()

  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

export const folderName = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd

const head = (label: string, what: string) => (label ? `【${label}】${what}` : what)

export function waiting(label: string, message: string): Note {
  return { title: head(label, '入力待ち'), message: cut(message || '承認か入力を待っています', MAX_MESSAGE), priority: 4, tags: ['hourglass'] }
}

export function question(label: string, text: string): Note {
  return { title: head(label, '質問があります'), message: cut(text || '質問に答えてください', 120), priority: 4, tags: ['question'] }
}

export function minutes(ms: number): string {
  const m = Math.round(ms / 60_000)

  return m >= 60 ? `${Math.floor(m / 60)}時間${m % 60}分` : `${m}分`
}

export function done(label: string, durationMs: number): Note {
  return { title: head(label, '作業が終わりました'), message: `${minutes(durationMs)}かかりました`, priority: 3, tags: ['white_check_mark'] }
}

export function failed(label: string, error: string): Note {
  return { title: head(label, 'エラーで止まりました'), message: cut(error || '不明なエラー', MAX_MESSAGE), priority: 4, tags: ['warning'] }
}

export function fromMod(label: string, title: string | undefined, message: string): Note {
  return { title: head(label, cut(title || 'mod からの知らせ', 60)), message: cut(message, MAX_MESSAGE), priority: 4, tags: ['bell'] }
}

export const keyOf = (note: Note) => `${note.title}\n${note.message}`

// A note the same as the last one, within a minute of it, is not sent again.
export const isRepeat = (last: { key: string; at: number } | null, note: Note, now: number) =>
  last !== null && last.key === keyOf(note) && now - last.at < REPEAT_MS

// ntfy's JSON form: a Japanese title in a header would not survive, a JSON body does.
export function ntfyRequest(server: string, topic: string, note: Note): { url: string; body: string } {
  return { url: server.replace(/\/+$/, ''), body: JSON.stringify({ topic, title: note.title, message: note.message, priority: note.priority, tags: note.tags }) }
}

export const SETUP = 'スマホ通知のトピック名が未設定です。/plugin configure phone-notify@claude-mods で ntfy のトピック名を入れてください'
