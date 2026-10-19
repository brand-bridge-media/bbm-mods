// What the session has touched, learned only from tool calls actually observed.
export type Ledger = {
  turns: number
  // Turn number of the last nudge, so a nudge repeats only after a quiet stretch.
  lastNudgeTurn: number
  // Jira keys the session worked on (transitioned, edited, or named by its branch / commit / PR).
  served: string[]
  // Jira keys that got an addCommentToJiraIssue.
  commented: string[]
  // Non-trivial-work signals: Webflow writes, merged PRs, commits, PRs opened.
  webflowWrites: number
  prsMerged: number
  commits: number
  prsOpened: number
  // INSERTs into knowledge_memories that succeeded.
  ingests: number
  // refresh_runs ids the session read or wrote -> last observed state.
  runs: Record<string, 'in_progress' | 'closed'>
  // A Webflow publish call went through (Stan's gate; the mod never makes one).
  published: boolean
  // Scheduling writes (send_later / create_trigger / CronCreate / Jira "next due"),
  // split by what the scheduled text covers.
  cannibScheduled: boolean
  gscScheduled: boolean
  // Pass A / Pass B verdicts: an `article_audit.py --write-receipt` run, or an
  // anchored "Pass A: PASS|BLOCK" Jira comment on a ticket the session worked.
  // SQL text is never read for verdicts.
  passA: boolean
  passB: boolean
  // `[mod:<name>]` messages seen on tool results and toasts, as "name: reason" (newest last, capped).
  modActions: string[]
  // Turn number of the last wrap-up that listed the mod actions with nothing else unmet.
  lastModListTurn: number
  // Child cloud sessions fleet-tracker still has open, one "ticket (label) bucket id" per line, as of the
  // last read (LC-1835). Only trusted while fleetLoaded; an unreadable fleet-tracker leaves this empty
  // and fleetLoaded false, which is "not checked", never "zero children".
  fleetOpen: string[]
  fleetLoaded: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'session-close': { ledger: Ledger }
  }
}
