/** The pick_images order this session has claimed (LC-2296). Null when none is open. */
export type Order = {
  orderId: string
  claimId: string
  /** The operator's token ceiling (payload.approval.limits.tokens); null when the order carries none. */
  ceiling: number | null
  /** Tokens this session has already committed against the ceiling. */
  spent: number
}

declare module 'claude-code' {
  interface PluginState {
    'roominate-order-guard': { order: Order | null }
  }
}
