export type Size = { lines: number; chars: number }
export type Limits = { maxLines: number; maxChars: number }

// Characters with a CRLF counted as one, and lines with a last line that has no newline counted too.
export function measure(text: string): Size {
  const lf = text.replace(/\r\n/g, '\n')
  const chars = [...lf].length
  if (lf === '') return { lines: 0, chars }
  const breaks = lf.split('\n').length - 1

  return { lines: lf.endsWith('\n') ? breaks : breaks + 1, chars }
}

export const isOver = (size: Size, limits: Limits) => size.lines > limits.maxLines || size.chars > limits.maxChars

// Whether a later size is worth saying again: more than what was last said.
export const hasGrown = (size: Size, said: Size | undefined) => said === undefined || size.lines > said.lines || size.chars > said.chars

// A root CLAUDE.md holds only the import of AGENTS.md (and blank lines).
export function hasOwnContent(claudeMd: string): boolean {
  return claudeMd.split(/\r?\n/).some(line => {
    const t = line.trim()

    return t !== '' && t !== '@AGENTS.md' && t !== '@./AGENTS.md'
  })
}

const slashed = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '')
// A key for a path: Windows paths compare without case.
export const pathKey = (path: string) => slashed(path).toLowerCase()
export const baseName = (path: string) => slashed(path).split('/').at(-1) ?? ''
export const dirOf = (path: string) => slashed(path).split('/').slice(0, -1).join('/')

// "AGENTS.md" at the root, "AGENTS.md（ゲーム開発/）" below it, the full folder outside it.
export function fileLabel(path: string, root: string): string {
  const dir = dirOf(path)
  const name = baseName(path)
  if (pathKey(dir) === pathKey(root)) return name
  const rootKey = `${pathKey(root)}/`
  const shown = pathKey(dir).startsWith(rootKey) ? slashed(dir).slice(rootKey.length) : slashed(dir)

  return `${name}（${shown}/）`
}

const fmt = (n: number) => n.toLocaleString('en-US')
const sizeText = (s: Size) => `${fmt(s.lines)}行・${fmt(s.chars)}字`
const limitText = (l: Limits) => `${fmt(l.maxLines)}行・${fmt(l.maxChars)}字`

export const overToast = (label: string, size: Size, limits: Limits) =>
  `${label} が目安を超えています（${sizeText(size)}／目安 ${limitText(limits)}）。削る候補を Claude に出してもらうのがおすすめです。`

export const overContext = (label: string, size: Size, limits: Limits) =>
  `〔agents-guard〕${label} は ${sizeText(size)}で、目安（${limitText(limits)}）を超えています。全体の指示書の決まりに従い、消す・まとめる・別の資料へ出す候補をユーザーに示してください。了承なしに削らないでください。`

export const CLAUDE_MD_TOAST = 'CLAUDE.md に @AGENTS.md 以外の中身があります。AGENTS.md へ移すのがおすすめです。'
export const CLAUDE_MD_CONTEXT =
  '〔agents-guard〕CLAUDE.md は `@AGENTS.md` の1行だけにする決まりです。中身を AGENTS.md へ移す案をユーザーに示してください。'
