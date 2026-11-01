/** One thing a child waits on (LC-1975 fix 4), read from its watcher mods' own lines. */
export type Await = {
  key: string // pr:o/r#N | run:o/r:<workflow> | dispatch:<workflow>
  kind: 'pr' | 'run' | 'dispatch'
  owner?: string
  repo?: string
  number?: number
  workflow?: string
  untilMerge?: boolean // pr-ci-watch said "until it merges": a green CI is not the end
  since: number // when the child's watcher announced it
  doneAt?: number // when the orchestrator first saw it finished
  doneWhat?: string
  checkedAt?: number
  woke?: boolean
}

export type FleetRow = {
  sessionId: string
  ticket: string
  label: string
  bucket: string
  status: string
  summary: string
  costUsd: number
  updatedAt: string
  checkedAt: number
  note: string
  needsYou: boolean
  error: string
  // Stall state (optional so rows saved by the previous version still load).
  lastActivity?: string
  nudgedAt?: number
  stallEscalated?: boolean
  // Close-out reminder state (LC-1835; optional so older rows load): when the row
  // entered its current bucket, and when its one reminder for this episode was sent.
  bucketSince?: number
  closeoutWokeAt?: number
  // Waiting reminder state (LC-1881; optional so older rows load): the waiting bucket the clock
  // runs for, when the row entered it, when it was last reminded, and the child's own words.
  waitBucket?: string
  waitSince?: number
  waitRemindedAt?: number
  needsAction?: string
  statusDetail?: string
  // What the child waits on (LC-1975 fix 4; optional so older rows load): the watches its own mods
  // announced, and the transcript version (updated_at) they were last read from.
  awaits?: Await[]
  awaitsScannedAt?: string
}

declare module 'claude-code' {
  interface PluginState {
    'fleet-tracker': { rows: FleetRow[] }
  }
}
