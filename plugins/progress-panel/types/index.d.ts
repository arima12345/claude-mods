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

declare module 'claude-code' {
  interface PluginState {
    'progress-panel': { progress: Progress; now: number }
  }
}
