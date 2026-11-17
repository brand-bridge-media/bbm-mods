export type Row = Record<string, unknown>

declare module 'claude-code' {
  interface PluginState {
    'lch600-review-gate': { rows: Row[] }
  }
}
