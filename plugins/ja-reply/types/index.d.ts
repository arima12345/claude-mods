declare module 'claude-code' {
  interface PluginState {
    // Whether a rewrite was already asked for since the person last wrote.
    'ja-reply': { isAsked: boolean }
  }
}
