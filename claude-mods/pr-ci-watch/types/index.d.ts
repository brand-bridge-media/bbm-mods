/** One PR whose CI this session is waiting on after a push. */
export type Watch = {
  owner: string
  repo: string
  number: number
  /** GitHub MCP server the PR is read through (e.g. `github`). */
  server: string
  /** The head this session pushed; replaced by the PR's head after ADOPT_HEAD_MS. */
  sha: string
  startedAt: number
  /** Signature of the last all-finished picture; the same one twice means done. */
  lastSig?: string
  errors?: number
  warnedNone?: boolean
  warnedLong?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'pr-ci-watch': { watches: Watch[] }
  }
}
