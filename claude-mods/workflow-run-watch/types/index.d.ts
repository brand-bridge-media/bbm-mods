/** One workflow run this session started or re-ran through the GitHub MCP (LC-1975). */
export type Watch = {
  owner: string
  repo: string
  /** GitHub MCP server the start went through; the polls use the same one. */
  server: string
  /** run_workflow: the workflow file or id. A re-run: undefined. */
  workflow?: string
  /** A re-run: the run id. run_workflow: filled in once the new run is found. */
  runId?: number
  /** ISO time a minute before the start: runs (or attempts) from here on are this one. */
  since: string
  startedAt: number
  errors?: number
  warnedLong?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'workflow-run-watch': { watches: Watch[]; finished: string[] }
  }
}
