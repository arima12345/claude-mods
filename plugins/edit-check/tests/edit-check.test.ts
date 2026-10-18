import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

type Ran = { argv: readonly string[]; cwd: string | undefined }
type Fakes = { files: Map<string, string>; ran: Ran[]; exits: Record<string, number>; outputs: Record<string, string>; statuses: (string | undefined)[]; toasts: string[]; deny: boolean; missing: Set<string> }

// Stands in for the engine beneath the plugin: the file system, commands, and the UI.
function fake(on: On, files: Record<string, string>): Fakes {
  const f: Fakes = { files: new Map(Object.entries(files)), ran: [], exits: {}, outputs: {}, statuses: [], toasts: [], deny: false, missing: new Set() }
  mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\me' })
  on('fs.exists', async (_$, e) => ({ value: [...f.files.keys()].some(p => p === e.path || p.startsWith(`${e.path}\\`)) }) as never)
  on('fs.read', async (_$, e) => ({ value: f.files.get(e.path) ?? '' }) as never)
  on('process.run', async (_$, e) => {
    // The lookup of a tool before it runs: found unless the test says it is missing.
    if (e.argv[0] === 'where') return { value: { exitCode: f.missing.has(String(e.argv[1])) ? 1 : 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
    const command = String(e.argv.at(-1))
    f.ran.push({ argv: e.argv, cwd: e.init?.cwd })

    return { value: { exitCode: f.exits[command] ?? 0, stdout: f.outputs[command] ?? 'ok', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('tool.call', async () => (f.deny ? { deny: 'no' } : { result: {}, text: 'ok' }) as never)
  on('classic.Stop', async () => ({}))
  on('ui.status', async (_$, e) => {
    f.statuses.push(e.text)

    return { value: undefined } as never
  })
  on('ui.toast', async (_$, e) => {
    f.toasts.push(String(e.text))

    return { value: undefined } as never
  })

  return f
}

const stop = { stop_hook_active: false, last_assistant_message: 'できました' }
const NODE = {
  'C:\\proj\\package.json': JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', lint: 'eslint .' } }),
  'C:\\proj\\src\\a.ts': '',
}

test('an edit in a project runs its checks once Claude tries to stop', async ($, on) => {
  const f = fake(on, NODE)
  // Nothing edited: nothing runs.
  expect((await $.classic.Stop(stop)).block).toBeUndefined()
  expect(f.ran).toHaveLength(0)

  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\src\\a.ts', old_string: 'a', new_string: 'b' } as never)
  await $.tool.call({ tool: 'Write', file_path: 'C:\\proj\\src\\b.ts', content: 'x' } as never)
  expect(f.ran).toHaveLength(0)

  expect((await $.classic.Stop(stop)).block).toBeUndefined()
  expect(f.ran.map(r => r.argv)).toEqual([['cmd', '/c', 'npm run typecheck'], ['cmd', '/c', 'npm run lint']])
  expect(f.ran[0]?.cwd).toBe('C:\\proj')
  expect(f.statuses.at(-1)).toBe('自動チェック ✓')

  // Checked already: the next stop with no new edit runs nothing.
  await $.classic.Stop(stop)
  expect(f.ran).toHaveLength(2)
})

test('a failing check keeps Claude working until it passes', async ($, on) => {
  const f = fake(on, NODE)
  f.exits['npm run typecheck'] = 2
  f.outputs['npm run typecheck'] = "src/a.ts(3,1): error TS2322: Type 'string' is not assignable to type 'number'."
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\src\\a.ts', old_string: 'a', new_string: 'b' } as never)

  const blocked = await $.classic.Stop(stop)
  expect(blocked.block).toContain('自動チェックが通りませんでした')
  expect(blocked.block).toContain('npm run typecheck')
  expect(blocked.block).toContain('TS2322')
  expect(f.statuses.at(-1)).toBe('自動チェック ✗ npm run typecheck')

  // Claude fixed it: the same project is checked again even without a new edit.
  f.exits['npm run typecheck'] = 0
  expect((await $.classic.Stop(stop)).block).toBeUndefined()
  expect(f.statuses.at(-1)).toBe('自動チェック ✓')
  expect((await $.command.run({ command: 'edit-check', args: '' } as never)).text).toContain('✓ npm run typecheck（C:\\proj）')
})

test('the same failure twice lets the stop through, so an old problem cannot trap Claude', async ($, on) => {
  const f = fake(on, NODE)
  f.exits['npm run lint'] = 1
  f.outputs['npm run lint'] = 'old.js 1:1 error no-undef (12ms)'
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\src\\a.ts', old_string: 'a', new_string: 'b' } as never)
  expect((await $.classic.Stop(stop)).block).toBeDefined()

  // Only the timing differs: still the same failure.
  f.outputs['npm run lint'] = 'old.js 1:1 error no-undef (15ms)'
  expect((await $.classic.Stop(stop)).block).toBeUndefined()
  expect(f.toasts.at(-1)).toContain('自動チェックが通らないまま終わりました（npm run lint）')
})

test('a different failure each time stops blocking after three tries', async ($, on) => {
  const f = fake(on, NODE)
  f.exits['npm run lint'] = 1
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\src\\a.ts', old_string: 'a', new_string: 'b' } as never)
  const blocks: (string | undefined)[] = []
  for (let n = 1; n <= 4; n++) {
    f.outputs['npm run lint'] = `error number ${'x'.repeat(n)}`
    blocks.push((await $.classic.Stop(stop)).block)
  }
  expect(blocks.slice(0, 3).every(b => b !== undefined)).toBe(true)
  expect(blocks[3]).toBeUndefined()
})

test('files outside any project, and subagent stops, run nothing', async ($, on) => {
  const f = fake(on, { ...NODE, 'C:\\Users\\me\\package.json': '{}', 'C:\\Users\\me\\.claude\\settings.json': '{}' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\Users\\me\\.claude\\settings.json', old_string: 'a', new_string: 'b' } as never)
  await $.classic.Stop(stop)
  expect(f.ran).toHaveLength(0)

  // A subagent's edit counts, but only the main Claude's stop runs the check.
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\src\\a.ts', old_string: 'a', new_string: 'b', agentId: 'sub-1' } as never)
  await $.classic.Stop({ ...stop, agent_id: 'sub-1', agent_type: 'general-purpose' } as never)
  expect(f.ran).toHaveLength(0)
  await $.classic.Stop(stop)
  expect(f.ran).toHaveLength(2)
})

test('a check whose tool is not installed is skipped, not failed', async ($, on) => {
  const f = fake(on, { 'C:\\py\\pyproject.toml': '[project]\nname = "x"\n\n[tool.ruff]\nline-length = 100\n' })
  // Windows answers a missing tool with exit code 1, the same as a failed check.
  f.exits['ruff check .'] = 1
  f.missing.add('ruff')
  await $.tool.call({ tool: 'Write', file_path: 'C:\\py\\app\\main.py', content: 'x' } as never)
  expect((await $.classic.Stop(stop)).block).toBeUndefined()
  expect(f.statuses.at(-1)).toBe('自動チェック ✓（未インストールで飛ばした: ruff check .）')
  expect(f.ran).toHaveLength(0)
})

test('a project can name its own checks, or none', async ($, on) => {
  const f = fake(on, {
    ...NODE,
    'C:\\proj\\.claude\\edit-check.json': JSON.stringify({ commands: ['npm test'] }),
    'C:\\quiet\\.claude\\edit-check.json': JSON.stringify({ commands: [] }),
    'C:\\quiet\\package.json': JSON.stringify({ scripts: { lint: 'eslint .' } }),
  })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\src\\a.ts', old_string: 'a', new_string: 'b' } as never)
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\quiet\\b.ts', old_string: 'a', new_string: 'b' } as never)
  await $.classic.Stop(stop)
  expect(f.ran.map(r => r.argv.at(-1))).toEqual(['npm test'])
})

test('pnpm, a bare tsconfig, Go, Rust and mods are found by their files', async ($, on) => {
  const f = fake(on, {
    'C:\\web\\package.json': JSON.stringify({ scripts: {} }),
    'C:\\web\\pnpm-lock.yaml': '',
    'C:\\web\\tsconfig.json': '{}',
    'C:\\web\\node_modules\\typescript\\package.json': '{}',
    'C:\\svc\\go.mod': 'module x',
    'C:\\crate\\Cargo.toml': '[package]',
    'C:\\mods\\my-mod\\.claude-plugin\\plugin.json': '{}',
  })
  for (const file of ['C:\\web\\src\\a.ts', 'C:\\svc\\main.go', 'C:\\crate\\src\\lib.rs', 'C:\\mods\\my-mod\\hooks\\register.ts']) {
    await $.tool.call({ tool: 'Write', file_path: file, content: 'x' } as never)
  }
  await $.classic.Stop(stop)
  expect(f.ran.map(r => `${r.cwd} ${r.argv.at(-1)}`)).toEqual([
    'C:\\web pnpm exec tsc --noEmit',
    'C:\\svc go vet ./...',
    'C:\\crate cargo check --quiet',
    'C:\\mods\\my-mod claude plugin validate .',
  ])
})

test('/edit-check off pauses the checks for the session, on resumes them', async ($, on) => {
  const f = fake(on, NODE)
  expect((await $.command.run({ command: 'edit-check', args: 'off' } as never)).text).toContain('止めました')
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\src\\a.ts', old_string: 'a', new_string: 'b' } as never)
  await $.classic.Stop(stop)
  expect(f.ran).toHaveLength(0)

  await $.command.run({ command: 'edit-check', args: 'on' } as never)
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\src\\a.ts', old_string: 'a', new_string: 'b' } as never)
  await $.classic.Stop(stop)
  expect(f.ran).toHaveLength(2)
})

test('a refused or failed edit marks nothing', async ($, on) => {
  const f = fake(on, NODE)
  f.deny = true
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\src\\a.ts', old_string: 'a', new_string: 'b' } as never)
  await $.classic.Stop(stop)
  expect(f.ran).toHaveLength(0)
})
