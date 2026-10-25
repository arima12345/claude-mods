import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { fileLabel, hasOwnContent, measure } from '../hooks/measure'

const ROOT = 'C:/proj'
const AGENTS = `${ROOT}/AGENTS.md`
const CLAUDE = `${ROOT}/CLAUDE.md`

// The engine hands fs hooks Windows paths.
const native = (path: string) => path.replace(/\//g, '\\')

// A file of n lines, each of the given text.
const lines = (n: number, text = '決まり') => Array.from({ length: n }, (_, i) => `- ${text}${i}`).join('\n') + '\n'

type World = { files: Map<string, { text: string; mtime: number }>; toasts: string[]; reads: string[]; write: (path: string, text: string) => void }

function world(on: On): World {
  let clock = 1
  const w: World = {
    files: new Map(),
    toasts: [],
    reads: [],
    write: (path, text) => void w.files.set(native(path), { text, mtime: clock++ }),
  }
  on('session.root', async () => ({ value: ROOT }) as never)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('fs.read', async (_$, e) => {
    w.reads.push(e.path)
    const f = w.files.get(e.path)
    if (!f) throw new Error('ENOENT')

    return { value: f.text } as never
  })
  on('fs.stat', async (_$, e) => {
    const f = w.files.get(e.path)
    if (!f) throw new Error('ENOENT')

    return { value: { kind: 'file', size: f.text.length, mtimeMs: f.mtime, isLink: false } } as never
  })
  on('ui.toast', async (_$, e) => {
    w.toasts.push(String(e.text))

    return { value: undefined } as never
  })
  on('tool.call', async (_$, e) => {
    const call = e as unknown as { tool: string; file_path?: string; content?: string; fail?: boolean }
    if (call.fail) return { result: 'no match', text: 'error', isError: true } as never
    if (call.file_path && call.content !== undefined) w.write(call.file_path, call.content)

    return { result: { ok: true }, text: 'ok' } as never
  })
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', async () => ({ text: '' }))

  return w
}

const start = { cwd: ROOT, surface: 'desktop', isInteractive: true } as never
const done = (turnId: string) => ({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId }) as never
type Ran = { context?: readonly string[] }
const edit = (file_path: string, content: string, extra: Record<string, unknown> = {}) =>
  ({ tool: 'Write', file_path, content, ...extra }) as never

test('lengths count a CRLF as one character and a last line without a newline as a line', () => {
  expect(measure('')).toEqual({ lines: 0, chars: 0 })
  expect(measure('a\nb\n')).toEqual({ lines: 2, chars: 4 })
  expect(measure('a\nb')).toEqual({ lines: 2, chars: 3 })
  expect(measure('あ\r\nい\r\n')).toEqual({ lines: 2, chars: 4 })
})

test('a root CLAUDE.md may hold only the import of AGENTS.md', () => {
  expect(hasOwnContent('@AGENTS.md\n')).toBe(false)
  expect(hasOwnContent('\n@./AGENTS.md\r\n\n')).toBe(false)
  expect(hasOwnContent('@AGENTS.md\n\n# メモ\n')).toBe(true)
})

test('files below the root are named with their folder', () => {
  expect(fileLabel('C:/proj/AGENTS.md', 'C:/proj')).toBe('AGENTS.md')
  expect(fileLabel('c:\\proj\\ゲーム開発\\AGENTS.md', 'C:/proj')).toBe('AGENTS.md（ゲーム開発/）')
  expect(fileLabel('D:/other/AGENTS.md', 'C:/proj')).toBe('AGENTS.md（D:/other/）')
})

test('the session start tells what stands over the limit, and nothing when all is well', async ($, on) => {
  const w = world(on)
  w.write(AGENTS, lines(120))
  w.write(CLAUDE, '@AGENTS.md\n\n# 古いメモ\n')
  await $.session.start(start)
  expect(w.toasts).toHaveLength(2)
  expect(w.toasts[0]).toMatch(/^AGENTS\.md が目安を超えています（120行・[\d,]+字／目安 100行・6,000字）/)
  expect(w.toasts[1]).toBe('CLAUDE.md に @AGENTS.md 以外の中身があります。AGENTS.md へ移すのがおすすめです。')
})

test('a short AGENTS.md and an import-only CLAUDE.md say nothing', async ($, on) => {
  const w = world(on)
  w.write(AGENTS, lines(30))
  w.write(CLAUDE, '@AGENTS.md\n')
  await $.session.start(start)
  expect(w.toasts).toEqual([])
})

test('missing files say nothing', async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  expect(w.toasts).toEqual([])
})

test('an edit that grows AGENTS.md past the limit tells the person and the model, once per growth', async ($, on) => {
  const w = world(on)
  w.write(AGENTS, lines(90))
  await $.session.start(start)
  expect(w.toasts).toEqual([])

  const grown = (await $.tool.call(edit(AGENTS, lines(110)))) as Ran
  expect(w.toasts).toHaveLength(1)
  expect(grown.context?.at(-1)).toMatch(/^〔agents-guard〕AGENTS\.md は 110行・[\d,]+字で、目安（100行・6,000字）を超えています。/)
  expect(grown.context?.at(-1)).toContain('了承なしに削らないでください')

  // The same length again, and a cut that is still over: nothing.
  const same = (await $.tool.call(edit(AGENTS, lines(110, 'きまり')))) as Ran
  const cut = (await $.tool.call(edit(AGENTS, lines(105)))) as Ran
  expect(same.context ?? []).toEqual([])
  expect(cut.context ?? []).toEqual([])
  expect(w.toasts).toHaveLength(1)

  // Growing again is said again; under the limit and over again is said too.
  await $.tool.call(edit(AGENTS, lines(115)))
  await $.tool.call(edit(AGENTS, lines(50)))
  await $.tool.call(edit(AGENTS, lines(101)))
  expect(w.toasts).toHaveLength(3)
})

test('a long line count is not needed: characters alone can be over', async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  await $.tool.call(edit(AGENTS, `${'あ'.repeat(6001)}\n`))
  expect(w.toasts[0]).toContain('AGENTS.md が目安を超えています（1行・6,002字／目安 100行・6,000字）')
})

test('an AGENTS.md below the root is named with its folder; a CLAUDE.md below it is not watched', async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  await $.tool.call(edit(`${ROOT}/ゲーム開発/AGENTS.md`, lines(120)))
  await $.tool.call(edit(`${ROOT}/ゲーム開発/CLAUDE.md`, lines(300)))
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toMatch(/^AGENTS\.md（ゲーム開発\/） が目安を超えています/)
})

test('editing the root CLAUDE.md beyond the import asks the model to move it', async ($, on) => {
  const w = world(on)
  w.write(CLAUDE, '@AGENTS.md\n')
  await $.session.start(start)
  const ran = (await $.tool.call(edit(CLAUDE, '@AGENTS.md\n\n- 新しい決まり\n'))) as Ran
  expect(w.toasts).toEqual(['CLAUDE.md に @AGENTS.md 以外の中身があります。AGENTS.md へ移すのがおすすめです。'])
  expect(ran.context?.at(-1)).toContain('CLAUDE.md は `@AGENTS.md` の1行だけにする決まりです')
})

test('failed edits and other files do nothing; a subagent hears it but the person gets no toast mid-turn', async ($, on) => {
  const w = world(on)
  w.write(AGENTS, lines(120, 'old'))
  await $.session.start(start)
  w.toasts.length = 0

  const failed = (await $.tool.call(edit(AGENTS, lines(200), { fail: true }))) as Ran
  await $.tool.call(edit(`${ROOT}/README.md`, lines(500)))
  expect(failed.context ?? []).toEqual([])
  expect(w.toasts).toEqual([])

  const sub = (await $.tool.call(edit(AGENTS, lines(130), { agentId: 'a1' }))) as Ran
  expect(sub.context?.at(-1)).toContain('〔agents-guard〕AGENTS.md は 130行')
  expect(w.toasts).toEqual([])
})

test('a turn end reads the root files again only when they changed (a shell rewrite)', async ($, on) => {
  const w = world(on)
  w.write(AGENTS, lines(50))
  await $.session.start(start)
  w.reads.length = 0

  await $.turn.start({ text: '進めて', turnId: 't1' })
  await $.turn.complete(done('t1'))
  expect(w.reads).toEqual([])

  // A script rewrote AGENTS.md: no Edit, so the turn's end is where it is seen.
  w.write(AGENTS, lines(140))
  await $.turn.start({ text: '進めて', turnId: 't2' })
  await $.turn.complete(done('t2'))
  expect(w.reads).toEqual([native(AGENTS)])
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toMatch(/^AGENTS\.md が目安を超えています（140行/)
})

test('the limits follow the settings, and the CLAUDE.md check can be turned off', { options: { maxLines: 20, maxChars: 100000, checkClaudeMd: false } }, async ($, on) => {
  const w = world(on)
  w.write(AGENTS, lines(25))
  w.write(CLAUDE, '# 中身あり\n')
  await $.session.start(start)
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toMatch(/（25行・[\d,]+字／目安 20行・100,000字）/)
})

test("a subagent's edit reaches the person at the main turn's end, once", async ($, on) => {
  const w = world(on)
  w.write(AGENTS, lines(50))
  await $.session.start(start)
  await $.turn.start({ text: '進めて', turnId: 't1' })
  // Two growing edits by subagents, one in a folder below: each file is told once, with its latest size.
  await $.tool.call(edit(AGENTS, lines(120), { agentId: 'a1' }))
  await $.tool.call(edit(AGENTS, lines(130), { agentId: 'a1' }))
  await $.tool.call(edit(`${ROOT}/ゲーム開発/AGENTS.md`, lines(110), { agentId: 'a2' }))
  // A subagent's own turn ending is not the main turn's.
  await $.turn.complete({ ...(done('s1') as object), agentId: 'a1' } as never)
  expect(w.toasts).toEqual([])

  await $.turn.complete(done('t1'))
  expect(w.toasts).toHaveLength(2)
  expect(w.toasts[0]).toMatch(/^AGENTS\.md が目安を超えています（130行/)
  expect(w.toasts[1]).toMatch(/^AGENTS\.md（ゲーム開発\/） が目安を超えています（110行/)

  // Told once: the next turn's end says nothing more.
  await $.turn.start({ text: '続けて', turnId: 't2' })
  await $.turn.complete(done('t2'))
  expect(w.toasts).toHaveLength(2)
})

test("the main loop's own toast stands in for a subagent's that waits on the same file", async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  await $.turn.start({ text: '進めて', turnId: 't1' })
  await $.tool.call(edit(AGENTS, lines(120), { agentId: 'a1' }))
  await $.tool.call(edit(AGENTS, lines(140)))
  expect(w.toasts).toHaveLength(1)
  await $.turn.complete(done('t1'))
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toMatch(/（140行/)
})

test('a file that disappears is forgotten, so made again over the limit it is told again', async ($, on) => {
  const w = world(on)
  w.write(AGENTS, lines(120))
  await $.session.start(start)
  expect(w.toasts).toHaveLength(1)

  // Another branch checked out without AGENTS.md, then one with a shorter (but still long) one.
  w.files.delete(native(AGENTS))
  await $.turn.start({ text: 'a', turnId: 't1' })
  await $.turn.complete(done('t1'))
  w.write(AGENTS, lines(110))
  await $.turn.start({ text: 'b', turnId: 't2' })
  await $.turn.complete(done('t2'))
  expect(w.toasts).toHaveLength(2)
  expect(w.toasts[1]).toMatch(/（110行/)
})
