export type TaskStatus = 'pending' | 'in_progress' | 'completed'
export type Task = { id: string; title: string; status: TaskStatus }
export type Progress = {
  isWorking: boolean
  startedAt: number
  endedAt: number
  action: string
  tools: number
  tasks: Task[]
}

// One rate-limit window as the last response reported it.
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Sample = { t: number; pct: number; resetsAt: string }
export type ContextFill = { percent?: number; tokens?: number; window: number }
// A context fill and the count of main turns finished when it was read.
export type ContextReading = { turn: number; pct: number }
export type Usage = {
  // When the rate limits were last read; 0 before any reading.
  measuredAt: number
  limits: Limit[]
  context: ContextFill | null
  // Readings per window kind, for the pace.
  samples: Record<string, Sample[]>
  // Windows whose pace runs fast, by kind: when they would reach 100% (0 when not projected).
  fast: Record<string, number>
  // The last few context fills, the latest of each turn, for the growth per turn.
  contextHistory: ContextReading[]
  // Main turns finished this session, which the context readings are counted in.
  turns?: number
  // The highest context threshold already announced.
  contextLevel: number
  // Where automatic compaction runs, in tokens; absent until read, -1 when it is off.
  valve?: number
  // The context window the valve was read for: another one (a /model switch) reads it again.
  valveWindow?: number
  // Whether the last warning before automatic compaction was given.
  isValveWarned?: boolean
  // The context fill at the last "good moment to compact" notice; 0 or absent when none.
  breakNotified?: number
  // The last main turn ended at a break, waiting for its fill to arrive.
  isBreakPending?: boolean
}

// A subagent this session started; endedAt is 0 while it runs.
export type SubAgent = { id: string; description: string; type: string; startedAt: number; endedAt: number }

export type Outcome = 'pass' | 'fail' | 'interrupted' | 'background'
// One line of the work log; `agent` names the subagent whose call it was.
export type LogEntry =
  | { kind: 'edit'; t: number; path: string; count: number; agent?: string }
  | { kind: 'test' | 'check'; t: number; command: string; outcome: Outcome; agent?: string }
  | { kind: 'commit'; t: number; hash: string; subject: string; agent?: string }

declare module 'claude-code' {
  interface PluginState {
    'progress-panel': { progress: Progress; now: number; usage: Usage; agents: SubAgent[]; log: LogEntry[] }
  }
}
