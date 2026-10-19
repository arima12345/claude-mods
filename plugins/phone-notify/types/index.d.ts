// The last notification sent, to keep a repeat within a minute from going out again.
export type Sent = { key: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'phone-notify': {
      // The name of the folder the session opened, to tell parallel sessions apart.
      label: string
      lastSent: Sent | null
      // Whether a failed send was already shown in this session.
      hasFailed: boolean
      // Whether the main turn under way ended asking in the desktop app's next-step box (a question was sent for it).
      asked: boolean
    }
  }
}
