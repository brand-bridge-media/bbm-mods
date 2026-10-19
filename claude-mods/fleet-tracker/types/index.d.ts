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
}

declare module 'claude-code' {
  interface PluginState {
    'fleet-tracker': { rows: FleetRow[] }
  }
}
