/** One workflow run this session dispatched through the github-dispatch bridge. */
export type Watch = {
  workflow: string
  /** Supabase MCP server and project the dispatch went through; the status check uses the same. */
  server: string
  projectId: string
  /** ISO time a minute before the dispatch: runs created from here on are candidates. */
  since: string
  startedAt: number
  /** The pending status request (net.http_post id) and when it was sent. */
  reqId?: number
  reqAt?: number
  warnedLong?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'dispatch-watch': { watches: Watch[] }
  }
}
