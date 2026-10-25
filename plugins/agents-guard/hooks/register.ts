import type { EngineInterface, Register } from 'claude-code'

import type { Size } from '../types'
import {
  baseName,
  CLAUDE_MD_CONTEXT,
  CLAUDE_MD_TOAST,
  dirOf,
  fileLabel,
  hasGrown,
  hasOwnContent,
  isOver,
  measure,
  overContext,
  overToast,
  pathKey,
  type Limits,
} from './measure'

const SAID = { plugin: 'agents-guard', key: 'said' } as const
const MTIMES = { plugin: 'agents-guard', key: 'mtimes' } as const
const PENDING = { plugin: 'agents-guard', key: 'pending' } as const
const STARTED = { plugin: 'agents-guard', key: 'startedFor' } as const
const EDITS = new Set(['Edit', 'Write', 'MultiEdit'])
const TOAST_MS = 12_000

type Settings = Limits & { isClaudeMdChecked: boolean }
// Why a file is looked at: the session's start says what stands; later looks speak only of growth,
// but a subagent's growth, already told to the subagent, is told to the person at the turn's end as it now stands.
type Why = 'start' | 'edit' | 'turn' | 'pending'

function settingsOf(options: Record<string, unknown>): Settings {
  const positive = (v: unknown, fallback: number) => (typeof v === 'number' && v > 0 ? v : fallback)

  return {
    maxLines: positive(options.maxLines, 100),
    maxChars: positive(options.maxChars, 6000),
    isClaudeMdChecked: options.checkClaudeMd !== false,
  }
}

async function readSaid($: EngineInterface): Promise<Record<string, Size>> {
  return $.state.get(SAID).then(
    r => r.value ?? {},
    () => ({}),
  )
}

async function setSaid($: EngineInterface, key: string, size: Size | undefined): Promise<void> {
  const said = { ...(await readSaid($)) }
  if (size === undefined) delete said[key]
  else said[key] = size
  await $.state.set(SAID, said).catch(() => {})
}

// One file, measured: what to tell the person (a toast) and the model (after an edit), if anything.
// A missing or unreadable file says nothing and, like one back under the limit, is forgotten,
// so the file made again over the limit (another branch checked out, say) is told again.
async function look($: EngineInterface, s: Settings, path: string, root: string, why: Why): Promise<{ toast: string; context: string } | undefined> {
  const text = await $.fs.read(path).then(
    t => (typeof t === 'string' ? t : undefined),
    () => undefined,
  )
  const key = pathKey(path)
  if (text === undefined) {
    if ((await readSaid($))[key]) await setSaid($, key, undefined)

    return undefined
  }
  const isClaudeMd = baseName(path).toLowerCase() === 'claude.md'
  const size = measure(text)
  const isBad = isClaudeMd ? hasOwnContent(text) : isOver(size, s)
  const said = (await readSaid($))[key]
  if (!isBad) {
    if (said) await setSaid($, key, undefined)

    return undefined
  }
  const isQuiet = why === 'pending' ? false : why === 'start' ? said !== undefined && !hasGrown(size, said) : !hasGrown(size, said)
  if (isQuiet) return undefined
  await setSaid($, key, size)
  if (isClaudeMd) return { toast: CLAUDE_MD_TOAST, context: CLAUDE_MD_CONTEXT }
  const label = fileLabel(path, root)

  return { toast: overToast(label, size, s), context: overContext(label, size, s) }
}

const rootFiles = (root: string, s: Settings) => [`${root}/AGENTS.md`, ...(s.isClaudeMdChecked ? [`${root}/CLAUDE.md`] : [])]

// Whether an edited file is one this mod watches: any AGENTS.md, and the root's CLAUDE.md.
function isWatched(path: string, root: string, s: Settings): boolean {
  const name = baseName(path).toLowerCase()
  if (name === 'agents.md') return true

  return s.isClaudeMdChecked && name === 'claude.md' && pathKey(dirOf(path)) === pathKey(root)
}

const rootOf = ($: EngineInterface) => $.session.root().then(r => r.replace(/\\/g, '/').replace(/\/+$/, ''))

// A conversation's start: the root files as they stand, told once, and the session it was told for.
async function startCheck($: EngineInterface, s: Settings, sessionId: string | undefined): Promise<void> {
  if (sessionId !== undefined) await $.state.set(STARTED, sessionId).catch(() => {})
  const root = await rootOf($).catch(() => undefined)
  if (root === undefined) return
  for (const path of rootFiles(root, s)) {
    const found = await look($, s, path, root, 'start').catch(() => undefined)
    if (found) $.ui.toast(found.toast, { timeoutMs: TOAST_MS })
    await noteMtime($, path)
  }
}

export const register: Register = (on, options) => {
  const s = settingsOf(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await startCheck($, s, await $.session.id().catch(() => undefined))

    return started
  })

  // A /clear or a resume goes on under a new session id with no session.start: the first main turn starts over.
  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    if (e.agentId) return started
    const id = await $.session.id().catch(() => undefined)
    const seen = await $.state.get(STARTED).then(
      r => r.value,
      () => undefined,
    )
    if (id === undefined || id === seen) return started
    await $.state.set(SAID, {}).catch(() => {})
    await $.state.set(MTIMES, {}).catch(() => {})
    await $.state.set(PENDING, {}).catch(() => {})
    await startCheck($, s, id)

    return started
  })

  on('tool.call', async ($, e, next) => {
    const done = await next(e)
    if (!EDITS.has(e.tool) || done.deny !== undefined || done.isError) return done
    const path = (e as unknown as { file_path?: unknown }).file_path
    if (typeof path !== 'string') return done
    const root = await rootOf($).catch(() => undefined)
    if (root === undefined || !isWatched(path, root, s)) return done
    const found = await look($, s, path, root, 'edit').catch(() => undefined)
    await noteMtime($, path)
    if (!found) return done
    // A subagent's edit is told to the subagent; the person hears of it at the main turn's end.
    if (e.agentId) await setPending($, pathKey(path), path)
    else {
      await setPending($, pathKey(path), undefined)
      $.ui.toast(found.toast, { timeoutMs: TOAST_MS })
    }

    return { ...done, context: [...(done.context ?? []), found.context] }
  })

  // Shell commands and scripts rewrite files without an Edit: look again when a root file changed.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId) return done
    const root = await rootOf($).catch(() => undefined)
    if (root === undefined) return done
    // Files a subagent grew are measured again: a later cut or rewrite decides what is told, once per file.
    const pending = await readPending($)
    if (Object.keys(pending).length > 0) await $.state.set(PENDING, {}).catch(() => {})
    for (const path of Object.values(pending)) {
      const found = await look($, s, path, root, 'pending').catch(() => undefined)
      if (found) $.ui.toast(found.toast, { timeoutMs: TOAST_MS })
      await noteMtime($, path)
    }
    for (const path of rootFiles(root, s)) {
      if (!(await hasChanged($, path))) continue
      const found = await look($, s, path, root, 'turn').catch(() => undefined)
      if (found) $.ui.toast(found.toast, { timeoutMs: TOAST_MS })
    }

    return done
  })
}

async function readPending($: EngineInterface): Promise<Record<string, string>> {
  return $.state.get(PENDING).then(
    r => r.value ?? {},
    () => ({}),
  )
}

// A file a subagent grew waits for the main turn's end; the main loop's own toast on it stands in for that.
async function setPending($: EngineInterface, key: string, path: string | undefined): Promise<void> {
  const pending = { ...(await readPending($)) }
  if (path === undefined && !(key in pending)) return
  if (path === undefined) delete pending[key]
  else pending[key] = path
  await $.state.set(PENDING, pending).catch(() => {})
}

async function mtimeOf($: EngineInterface, path: string): Promise<number | undefined> {
  return $.fs.stat(path).then(
    st => st.mtimeMs,
    () => undefined,
  )
}

// Whether the file's modification time moved since it was last seen, and remembers the new one.
// A missing file stands as 0, so it is not "changed" at every turn's end.
async function hasChanged($: EngineInterface, path: string): Promise<boolean> {
  const mtimes: Record<string, number> = await $.state.get(MTIMES).then(r => r.value ?? {}, () => ({}))
  const at = (await mtimeOf($, path)) ?? 0
  const key = pathKey(path)
  if (mtimes[key] === at) return false
  await $.state.set(MTIMES, { ...mtimes, [key]: at }).catch(() => {})

  return true
}

const noteMtime = async ($: EngineInterface, path: string) => void (await hasChanged($, path))
