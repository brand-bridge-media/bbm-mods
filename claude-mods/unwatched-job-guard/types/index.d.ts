/** One job this session started that must be watched until it finishes (LC-1975). */
export type Job = {
  /** Matches the watcher's `watching` keys: pr:o/r#N, dispatch:<wf>, run:o/r:<wf|id>; bash:<cmd> has no watcher. */
  key: string
  /** The mod whose `watching` tool holds it, or undefined when no mod can (a shell start). */
  holder?: 'pr-ci-watch' | 'dispatch-watch' | 'workflow-run-watch'
  /** What the session did, for the block message. */
  what: string
  startedAt: number
  /** A check-in (send_later, ScheduleWakeup, Monitor, ...) made after the start holds it. */
  checkIn?: boolean
  /** How many turn ends this job has blocked. */
  blocks?: number
}

declare module 'claude-code' {
  interface PluginState {
    'unwatched-job-guard': { jobs: Job[] }
  }
}
