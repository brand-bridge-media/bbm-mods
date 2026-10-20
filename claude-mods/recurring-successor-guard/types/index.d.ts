export type Row = Record<string, unknown>

declare module 'claude-code' {
  interface PluginState {
    'recurring-successor-guard': { rows: Row[] }
  }
}
