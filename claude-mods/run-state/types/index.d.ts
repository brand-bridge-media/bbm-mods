export type RunSection = {
  id: string
  label: string
  state: string
  unmet: string[]
}

export type RunView = {
  runId: string
  slug: string
  status: string
  pipelineVersion: number
  sections: RunSection[]
  // stage/part per section id, so a receipt written as (stage, part) maps to a section
  table: { id: string; stage: number; part: string | null }[]
  passA: { verdict: string | null; at: string | null } | null
  fetchedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'run-state': {
      // `/run-state <slug|run_id>` pin; '' = latest active run (ambiguous if several)
      pin: string
      view: RunView | null
      // why the plan could not be read; the guard asks while this is set
      error: string
      // Clock time of the last check that found NO active run (0 = not idle). While fresh, the
      // guard is inert and nothing is queried, so turn.complete does not hit the database each turn.
      idleAt: number
    }
  }
}
