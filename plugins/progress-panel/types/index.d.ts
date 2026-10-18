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
export type Usage = {
  // When the rate limits were last read; 0 before any reading.
  measuredAt: number
  limits: Limit[]
  context: ContextFill | null
  // Readings per window kind, for the pace.
  samples: Record<string, Sample[]>
  // Windows whose pace runs fast, by kind: when they would reach 100% (0 when not projected).
  fast: Record<string, number>
  // The last few context fills, one per measurement, for the growth per turn.
  contextHistory: number[]
  // The highest context threshold already announced.
  contextLevel: number
}

declare module 'claude-code' {
  interface PluginState {
    'progress-panel': { progress: Progress; now: number; usage: Usage }
  }
}
