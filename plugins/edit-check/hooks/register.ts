import type { EngineInterface, Register } from 'claude-code'

import type { CheckRun, EditCheckState } from '../types'

const STATE = { plugin: 'edit-check', key: 'state' } as const

// Files that mark a project's top folder, nearest first.
const MARKERS = ['.claude/edit-check.json', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', '.claude-plugin/plugin.json']
// Blocking Claude's stop this many times in a row is enough: then the stop goes through.
const MAX_BLOCKS = 3
// What a shell may still answer when a command it runs is not installed.
const NOT_FOUND = [9009, 127]
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit']

const empty: EditCheckState = { pending: [], isOff: false, lastFailure: null, blocks: 0, lastRuns: [] }

// Set from the plugin's options each time the module loads.
let timeoutMs = 300_000

async function getState($: EngineInterface): Promise<EditCheckState> {
  return (await $.state.get(STATE)).value ?? empty
}

async function setState($: EngineInterface, state: EditCheckState): Promise<void> {
  await $.state.set(STATE, state)
}

export const register: Register = (on, options) => {
  timeoutMs = Math.min(600, Math.max(10, Number(options.timeoutSeconds ?? 300))) * 1000

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'edit-check',
      description: '変更後の自動チェックの状態を見る・止める・再開する',
      argumentHint: '[off | on]',
      immediate: true,
    })

    return next(e)
  })

  on('command.run', { command: 'edit-check' }, async ($, e) => {
    const args = e.args.trim()
    const state = await getState($)
    if (args === 'off') {
      await setState($, { ...state, isOff: true, pending: [] })
      $.ui.status('自動チェック 停止中')

      return { text: 'このセッションの自動チェックを止めました。/edit-check on で再開します。' }
    }
    if (args === 'on') {
      await setState($, { ...state, isOff: false })
      $.ui.status(undefined)

      return { text: '自動チェックを再開しました。' }
    }

    return { text: describeState(state) }
  })

  // Every edit, the main Claude's or a subagent's, marks its project for the next check.
  // The mod only watches here: a failure in it never stands in the way of the edit.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (!EDIT_TOOLS.includes(e.tool) || ran.deny !== undefined || ran.isError === true) return ran
    await mark($, e as unknown as { file_path?: unknown; notebook_path?: unknown }).catch(() => {})

    return ran
  }).catch(($, e, next) => next(e))

  // When the main Claude tries to stop: check what changed, and keep it working while a check fails.
  on('classic.Stop', async ($, e, next) => {
    const below = await next(e)
    if (e.agent_id !== undefined || below.block !== undefined) return below
    const state = await getState($)
    if (state.isOff || state.pending.length === 0) return below

    $.ui.status('自動チェック中…')
    const runs: CheckRun[] = []
    for (const root of state.pending) runs.push(...(await checkProject($, root)))
    const failed = runs.filter(r => r.status === 'failed')
    $.ui.status(statusLine(runs))

    if (failed.length === 0) {
      await setState($, { ...state, pending: [], lastFailure: null, blocks: 0, lastRuns: runs })

      return below
    }

    const signature = failed.map(r => `${r.root}\n${r.command}\n${normalize(r.output)}`).join('\n\n')
    if (signature === state.lastFailure || state.blocks >= MAX_BLOCKS) {
      await setState($, { ...state, pending: [], lastFailure: signature, blocks: 0, lastRuns: runs })
      $.ui.toast(`自動チェックが通らないまま終わりました（${failed.map(r => r.command).join('、')}）`)

      return below
    }

    await setState($, { ...state, pending: [...new Set(failed.map(r => r.root))], lastFailure: signature, blocks: state.blocks + 1, lastRuns: runs })

    return { block: blockMessage(failed) }
  }).catch(($, e, next) => next(e)) // A check that breaks never keeps Claude from stopping.
}

async function mark($: EngineInterface, e: { file_path?: unknown; notebook_path?: unknown }): Promise<void> {
  const path = typeof e.file_path === 'string' ? e.file_path : typeof e.notebook_path === 'string' ? e.notebook_path : null
  if (path === null || /[\\/]node_modules[\\/]/.test(path)) return
  const absolute = isAbsolute(path) ? path : join(await $.session.root(), path)
  const root = await findRoot($, parent(absolute))
  if (root === null) return
  const state = await getState($)
  if (state.isOff || state.pending.includes(root)) return
  await setState($, { ...state, pending: [...state.pending, root] })
}

// The nearest folder above the file holding a project marker, never the home folder or a drive's top.
export async function findRoot($: EngineInterface, start: string | null): Promise<string | null> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? null
  let dir: string | null = start
  while (dir !== null && !isTop(dir) && !samePath(dir, home)) {
    for (const marker of MARKERS) {
      if (await $.fs.exists(join(dir, marker))) return dir
    }
    dir = parent(dir)
  }

  return null
}

// How each package manager runs the TypeScript compiler a project installed.
const TSC = { npm: 'npx tsc --noEmit', pnpm: 'pnpm exec tsc --noEmit', yarn: 'yarn tsc --noEmit', bun: 'bunx tsc --noEmit' } as const

// The checks a project asks for: its own list first, else what its files show.
export async function commandsFor($: EngineInterface, root: string): Promise<string[]> {
  const has = (name: string) => $.fs.exists(join(root, name))
  const text = async (name: string) => String(await $.fs.read(join(root, name)))

  if (await has('.claude/edit-check.json')) {
    const parsed = JSON.parse(await text('.claude/edit-check.json')) as { commands?: unknown }

    return Array.isArray(parsed.commands) ? parsed.commands.filter((c): c is string => typeof c === 'string' && c.trim() !== '') : []
  }

  const commands: string[] = []
  if (await has('package.json')) {
    const scripts = ((JSON.parse(await text('package.json')) as { scripts?: Record<string, unknown> }).scripts ?? {})
    const pm: keyof typeof TSC = (await has('pnpm-lock.yaml')) ? 'pnpm' : (await has('yarn.lock')) ? 'yarn' : (await has('bun.lockb')) || (await has('bun.lock')) ? 'bun' : 'npm'
    if (typeof scripts.typecheck === 'string') commands.push(`${pm} run typecheck`)
    else if ((await has('tsconfig.json')) && (await has('node_modules/typescript'))) commands.push(TSC[pm])
    if (typeof scripts.lint === 'string') commands.push(`${pm} run lint`)
  }
  if (await has('pyproject.toml')) {
    const pyproject = await text('pyproject.toml')
    if (/^\[tool\.ruff/m.test(pyproject)) commands.push('ruff check .')
    if (/^\[tool\.mypy/m.test(pyproject)) commands.push('mypy .')
  }
  if (await has('go.mod')) commands.push('go vet ./...')
  if (await has('Cargo.toml')) commands.push('cargo check --quiet')
  if (await has('.claude-plugin/plugin.json')) commands.push('claude plugin validate .')

  return commands
}

async function checkProject($: EngineInterface, root: string): Promise<CheckRun[]> {
  let commands: string[]
  try {
    commands = await commandsFor($, root)
  } catch (error) {
    return [{ root, command: '.claude/edit-check.json などの読み込み', status: 'skipped', output: String(error) }]
  }
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const runs: CheckRun[] = []
  for (const command of commands) {
    if (!(await isInstalled($, command, root, isWindows))) {
      runs.push({ root, command, status: 'skipped', output: '' })
      continue
    }
    const argv = isWindows ? ['cmd', '/c', command] : ['sh', '-c', command]
    try {
      const ran = await $.process.run(argv, { cwd: root, timeoutMs })
      const output = tail(`${ran.stdout}\n${ran.stderr}`, 1500)
      const status = ran.exitCode === 0 ? 'passed' : NOT_FOUND.includes(ran.exitCode) ? 'skipped' : 'failed'
      runs.push({ root, command, status, output })
    } catch (error) {
      runs.push({ root, command, status: 'failed', output: `実行できないか、${timeoutMs / 1000}秒で終わりませんでした: ${String(error)}` })
    }
  }

  return runs
}

// A missing tool must not read as a failed check, and Windows answers it with exit code 1
// and a message in the system's language, so the tool is looked up before it runs.
async function isInstalled($: EngineInterface, command: string, root: string, isWindows: boolean): Promise<boolean> {
  const exe = command.trim().split(/\s+/)[0] ?? ''
  if (!/^[\w.-]+$/.test(exe)) return true
  try {
    const found = await $.process.run(isWindows ? ['where', exe] : ['sh', '-c', `command -v ${exe}`], { cwd: root })

    return found.exitCode === 0
  } catch {
    return true
  }
}

function blockMessage(failed: CheckRun[]): string {
  const parts = failed.map(r => `［${r.root}］ ${r.command}\n${r.output}`).join('\n\n')

  return `ファイルを変更したあとの自動チェックが通りませんでした。\n\n${parts}\n\n原因を直してから終えてください。今回の変更と関係のない、もともとあった問題なら、直さずにそのことを報告して終えて構いません。`
}

function statusLine(runs: CheckRun[]): string | undefined {
  if (runs.length === 0) return undefined
  const failed = runs.filter(r => r.status === 'failed')
  const skipped = runs.filter(r => r.status === 'skipped')
  const note = skipped.length > 0 ? `（未インストールで飛ばした: ${skipped.map(r => r.command).join('、')}）` : ''

  return failed.length === 0 ? `自動チェック ✓${note}` : `自動チェック ✗ ${failed.map(r => r.command).join('、')}${note}`
}

function describeState(state: EditCheckState): string {
  const lines = [state.isOff ? '自動チェック: 停止中（/edit-check on で再開）' : '自動チェック: 有効']
  if (state.pending.length > 0) lines.push(`次に確かめるプロジェクト: ${state.pending.join('、')}`)
  if (state.lastRuns.length === 0) lines.push('このセッションではまだチェックを実行していません。')
  for (const r of state.lastRuns) lines.push(`${r.status === 'passed' ? '✓' : r.status === 'failed' ? '✗' : '－'} ${r.command}（${r.root}）`)

  return lines.join('\n')
}

// Timings and counters change between runs of the same failure.
function normalize(output: string): string {
  return output.replace(/\d+(\.\d+)?\s*(ms|s|秒)\b/g, '').replace(/\s+/g, ' ').trim()
}

function isAbsolute(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\')
}

function separator(path: string): string {
  return path.includes('\\') ? '\\' : '/'
}

export function join(dir: string, name: string): string {
  const sep = separator(dir)

  return `${dir.replace(/[\\/]+$/, '')}${sep}${name.replace(/[\\/]/g, sep)}`
}

export function parent(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (cut < 0) return null
  const up = trimmed.slice(0, cut)

  // C:\a → C:\ and /a → /: the top keeps its separator.
  return /^[A-Za-z]:$/.test(up) || up === '' ? `${up}${separator(path)}` : up
}

function isTop(dir: string): boolean {
  return /^[A-Za-z]:[\\/]?$/.test(dir) || dir === '/' || dir === '\\'
}

function samePath(a: string, b: string | null): boolean {
  if (b === null) return false
  const norm = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()

  return norm(a) === norm(b)
}

function tail(text: string, max: number): string {
  const trimmed = text.trim()

  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`
}
