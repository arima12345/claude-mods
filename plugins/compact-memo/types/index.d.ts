// A memo handed back after one compaction.
export type MemoRecord = { at: number; trigger: string; text: string }
// One compaction as it happened, to learn where automatic compaction really starts.
export type CompactionRecord = { at: number; trigger: string; percent?: number; tokens?: number; window: number }

// The parts of other mods' state this one reads, when they are installed. It never writes them.
export type GoalSlice = { condition: string; status: string } | null
export type TaskSlice = { title: string; status: string }
export type LogSlice = { kind: string; t: number; path?: string; command?: string; outcome?: string; hash?: string; subject?: string }

declare module 'claude-code' {
  interface PluginState {
    // The name of the folder the session opened, for the memo's heading.
    'compact-memo': { label: string }
    goal2: { goal: GoalSlice }
    'progress-panel': { progress: { tasks: TaskSlice[] }; log: LogSlice[] }
  }
}
