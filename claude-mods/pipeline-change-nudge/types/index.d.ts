export type Told = boolean

declare module 'claude-code' {
  interface PluginState {
    'pipeline-change-nudge': { told: Told }
  }
}
