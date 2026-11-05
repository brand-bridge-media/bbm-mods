/** One PR this session put into the pipeline, timed from its creation until it merges or closes. */
export type Clock = {
  owner: string
  repo: string
  number: number
  /** GitHub MCP server the PR is read through (e.g. `github`). */
  server: string
  startedAt: number
  /** Index into WAKE_AT_MS of the next wake. */
  nextWake: number
  /** Cause ticket this PR's one occurrence was recorded on; a second report for the PR is refused. */
  reportedTo?: string
  errors?: number
}

declare module 'claude-code' {
  interface PluginState {
    'slowness-report': { clocks: Clock[]; operatorAsked: boolean }
  }
}
