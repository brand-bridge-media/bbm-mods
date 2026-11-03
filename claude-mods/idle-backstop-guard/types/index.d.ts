/** A server-side check-in call this session made (send_later / create_trigger), kept so Stop can see when it fires. */
export type Call = { tool: string; input: Record<string, unknown>; result: string; at_ms: number }

/** The last verdict, for the operator to read back. */
export type Receipt = { at: number; verdict: 'PASS' | 'BLOCK' | 'NOT CHECKED'; reason: string }

declare module 'claude-code' {
  interface PluginState {
    'idle-backstop-guard': { calls: Call[]; blocks: number; receipt: Receipt | null }
  }
}
