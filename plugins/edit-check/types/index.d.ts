export type CheckRun = { root: string; command: string; status: 'passed' | 'failed' | 'skipped'; output: string }
export type EditCheckState = {
  pending: string[]
  isOff: boolean
  lastFailure: string | null
  blocks: number
  lastRuns: CheckRun[]
}

declare module 'claude-code' {
  interface PluginState {
    'edit-check': { state: EditCheckState }
  }
}
