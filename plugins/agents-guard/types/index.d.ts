// A file's length: lines, and characters with a CRLF counted as one.
export type Size = { lines: number; chars: number }

declare module 'claude-code' {
  interface PluginState {
    'agents-guard': {
      // Per file (its path key), the size last told; absent when under the limit or not yet told.
      said: Record<string, Size>
      // Per file, the modification time last seen, to look again only after a change.
      mtimes: Record<string, number>
      // Per file, the toast a subagent's edit left for the person, shown at the main turn's end.
      pending: Record<string, string>
    }
  }
}
