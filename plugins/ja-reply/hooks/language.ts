// What is English by nature in a Japanese report: code, commands, links and paths.
const CODE_BLOCK = /```[\s\S]*?(```|$)/g
const INLINE_CODE = /`[^`\n]*`/g
const LINK_TARGET = /\]\([^)]*\)/g
const URL = /\bhttps?:\/\/\S+/g
const PATH = /\S*[\\/]\S*/g

const JAPANESE = /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/g
const LATIN = /[A-Za-z]/g

export const MIN_LETTERS = 150
export const MAX_SHARE = 0.2

export function prose(text: string): string {
  return text.replace(CODE_BLOCK, ' ').replace(INLINE_CODE, ' ').replace(LINK_TARGET, ' ').replace(URL, ' ').replace(PATH, ' ')
}

// The share of Japanese among the letters of the prose, and how many letters it has.
export function japaneseShare(text: string): { share: number; letters: number } {
  const rest = prose(text)
  const ja = rest.match(JAPANESE)?.length ?? 0
  const latin = rest.match(LATIN)?.length ?? 0
  const letters = ja + latin

  return { share: letters === 0 ? 1 : ja / letters, letters }
}

// Long enough to judge, and under a fifth Japanese.
export function isMostlyEnglish(text: string): boolean {
  const { share, letters } = japaneseShare(text)

  return letters >= MIN_LETTERS && share < MAX_SHARE
}

export const REWRITE =
  '直前の報告がほとんど英語でした。CLAUDE.md の決まりどおり、ユーザーへの報告を日本語で書き直してください。作業の続きはせず、同じ内容の報告を日本語で書くだけにしてください。'
