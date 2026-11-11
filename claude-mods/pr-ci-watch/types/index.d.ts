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
  /** Auto-merge was armed on this PR (enable_pr_auto_merge or watch_pr armed:true): watch until it merges (LC-1975). */
  armed?: boolean
  /** When CI was first seen all green while armed; the merge clock runs from here. */
  greenAt?: number
  /** Stuck-in-queue wakes already sent. */
  stuckWakes?: number
  /** `head|reason` of the last Mergify dequeue reported, so one dequeue wakes once (LCH-614). */
  dequeueSig?: string
}

declare module 'claude-code' {
  interface PluginState {
    'pr-ci-watch': { watches: Watch[]; finished: string[] }
  }
}
