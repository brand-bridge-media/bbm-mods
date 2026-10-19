export type PassAEntry = {
  slug: string
  runId: string
  /** ms epoch of the exit-0 `article_audit.py --pass a --write-receipt` */
  at: number
  stale: boolean
  /** ms epoch of the Webflow item write that invalidated it; 0 while fresh */
  staleAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'refresh-run-guard': {
      passA: Record<string, PassAEntry>
      /** Webflow item id -> count of lc-deal-pill spans seen in its live post-body */
      pills: Record<string, number>
    }
  }
}
