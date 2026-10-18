export type GoalStatus = 'active' | 'verifying' | 'paused'
export type Goal = {
  condition: string
  check: string | null
  setAt: number
  status: GoalStatus
  pauseReason: string | null
  checks: number
  lastReason: string | null
  sameReasonCount: number
  retries: number
  verifierAgentId: string | null
  verifierFails: number
}

declare module 'claude-code' {
  interface PluginState {
    goal2: { goal: Goal | null; userPrompt: string | null }
  }
}
