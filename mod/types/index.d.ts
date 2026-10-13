// What the mod keeps in the session's state, which a plugin reload does not
// clear: the main loop's running turn, so "send now" can still stop it right
// after /reload-plugins.
export type RunningTurn = string | null

declare module 'claude-code' {
  interface PluginState {
    choibuddy: { turn: RunningTurn }
  }
}
