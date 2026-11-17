// Why (LCH-600): ordinary changes (a 7-row data fix, a picture swap) were taking over an hour to reach
// production, and every session re-discovered "it's the queue" from scratch. This mod puts a clock on every
// PR a session opens, wakes the session when the clock passes its budget, and files the diagnosis as a child
// of the LCH-600 epic so the incidents add up to evidence about WHICH stage eats the time.
// Decisions live here (pure, tested); ./register.ts gathers facts through the session's MCP servers and acts.

export const OWN = '[mod:slowness-report]'
export const EPIC = 'LCH-600'
export const CLOUD_ID = '6a32dd03-81a6-42d8-a7c0-e2f3a045696d'

const MIN = 60_000
/** A small change should be live inside this. A target, not today's median (37 min green-to-merged on 2026-11-05). */
export const BUDGET_MS = 30 * MIN
/** One wake per PR, at the budget. One PR is one occurrence: a second report would double-count the cause. */
export const WAKE_AT_MS = [BUDGET_MS] as const
export const POLL_MS = 3 * MIN
export const MAX_ERRORS = 5

// Operator decision (2026-11-05, LCH-600): an incident is never its own ticket. It is recorded as one dated
// occurrence comment, with references, on the ticket that owns its CAUSE, so recurrence piles up where the
// architectural fix lives and the comment count per cause ticket is the recurrence measure. This table is the
// only place a stage maps to a cause ticket; a cause with no ticket yet goes to the epic itself.
// LCH-720 (2026-11-17): LCH-603, LCH-614 and LCH-595 closed on 11-15/16 but kept receiving occurrences, so the stories
// that now own those causes never saw their recurrence. Re-pointed at the open owners; routeOccurrence() below sends a
// report to the epic whenever an owner turns out to be closed, so a stale entry can never hide an occurrence again.
export const CAUSE_TICKETS = {
  runner_queue: 'LCH-618',   // jobs waiting for a free check runner (capacity; was LCH-603, closed 2026-11-16)
  train_wait: 'LCH-697',     // green, waiting for the merge queue (Trunk) to form or tick (was LCH-614, closed 2026-11-16)
  train_recheck: 'LCH-697',  // the queue re-running checks or rejecting a batch member (was LCH-614)
  reviewer: EPIC,            // AI reviewer slow, timed out or red (LCH-595 closed 2026-11-15; no open reviewer story)
  failed_check: EPIC,        // a red check, eviction or retry round
  deploy: EPIC,              // merged, waiting on the deploy
  human: EPIC,               // waiting on a person
  other: EPIC,
} as const
export type Stage = keyof typeof CAUSE_TICKETS
export const STAGES = Object.keys(CAUSE_TICKETS) as Stage[]

export type { Clock } from '../types'
import type { Clock } from '../types'

export type CheckRun = { name: string; status: string; conclusion: string | null }
export type PrFacts = { state: string; merged: boolean; mergedAt?: number; title?: string; autoMerge?: boolean; mergeableState?: string }
export type Observation = { kind: 'pr'; pr: PrFacts; runs?: CheckRun[] } | { kind: 'error' }

export const clockKey = (c: Pick<Clock, 'owner' | 'repo' | 'number'>) => `${c.owner}/${c.repo}#${c.number}`

function json(text: string): unknown {
  try { return JSON.parse(text) } catch { return undefined }
}

export function prNumberFrom(text: string): number | undefined {
  const v = json(text) as any
  if (v && typeof v === 'object' && Number.isInteger(v.number)) return v.number
  const all = [...text.matchAll(/\/pull\/(\d+)/g)]
  return all.length ? Number(all[all.length - 1]![1]) : undefined
}

/** pull_request_read `get` text -> the facts a stall needs. Undefined when unreadable. */
export function parsePr(text: string): PrFacts | undefined {
  const v = json(text) as any
  // Only a state GitHub actually uses counts as read; anything else goes down the error path.
  if (!v || typeof v !== 'object' || !['open', 'closed'].includes(String(v.state).toLowerCase())) return undefined
  const mergedAt = typeof v.merged_at === 'string' ? Date.parse(v.merged_at) : NaN
  return {
    state: v.state.toLowerCase(),
    // An empty or unparseable merged_at is not a merge: only merged:true or a real timestamp ends the clock.
    merged: v.merged === true || Number.isFinite(mergedAt),
    ...(Number.isFinite(mergedAt) ? { mergedAt } : {}),
    ...(typeof v.title === 'string' ? { title: v.title } : {}),
    ...(v.auto_merge !== undefined ? { autoMerge: !!v.auto_merge } : {}),
    ...(typeof v.mergeable_state === 'string' ? { mergeableState: v.mergeable_state } : {}),
  }
}

export function parseCheckRuns(text: string): CheckRun[] | undefined {
  const v = json(text)
  const list = Array.isArray(v) ? v : (v && typeof v === 'object' ? (v as { check_runs?: unknown }).check_runs : undefined)
  if (!Array.isArray(list)) return undefined
  return list.filter((r: any) => r && typeof r.name === 'string' && typeof r.status === 'string')
    .map((r: any) => ({ name: r.name, status: r.status.toLowerCase(), conclusion: typeof r.conclusion === 'string' ? r.conclusion.toLowerCase() : null }))
}

/** One line a person can read: how many checks are waiting for a runner, running, failed, done. */
export function summariseRuns(runs: CheckRun[] | undefined): string {
  if (!runs) return 'check runs: NOT CHECKED (unreadable)'
  if (runs.length === 0) return 'check runs: none registered'
  const queued = runs.filter(r => r.status === 'queued' || r.status === 'waiting' || r.status === 'pending')
  const running = runs.filter(r => r.status === 'in_progress')
  const failed = runs.filter(r => r.status === 'completed' && ['failure', 'timed_out', 'cancelled', 'action_required'].includes(r.conclusion ?? ''))
  const names = (l: CheckRun[]) => l.slice(0, 6).map(r => r.name).join(', ') + (l.length > 6 ? `, +${l.length - 6}` : '')
  const parts = [`${runs.length} checks`, `${queued.length} queued${queued.length ? ` (${names(queued)})` : ''}`,
    `${running.length} running${running.length ? ` (${names(running)})` : ''}`, `${failed.length} failed${failed.length ? ` (${names(failed)})` : ''}`]
  return `check runs: ${parts.join('; ')}`
}

const mins = (ms: number) => Math.round(ms / MIN)
const iso = (t: number) => new Date(t).toISOString().slice(0, 16) + 'Z'

export type Decision = { done: boolean; wake?: string; patch?: Partial<Clock> }

/** What one poll means for one clock. Merged/closed ends it quietly; a crossed threshold wakes the session. */
export function decide(c: Clock, o: Observation, now: number): Decision {
  if (o.kind === 'error') {
    const errors = (c.errors ?? 0) + 1
    return errors >= MAX_ERRORS ? { done: true } : { done: false, patch: { errors } }
  }
  if (o.pr.merged || o.pr.state === 'closed') return { done: true }
  const due = WAKE_AT_MS[c.nextWake]
  const elapsed = now - c.startedAt
  if (due === undefined || elapsed < due) return { done: false, patch: { errors: 0 } }
  return { done: false, patch: { errors: 0, nextWake: c.nextWake + 1 }, wake: wakeText(c, o, now) }
}

export function wakeText(c: Clock, o: Extract<Observation, { kind: 'pr' }>, now: number): string {
  const key = clockKey(c)
  const facts = [
    `opened ${iso(c.startedAt)}, ${mins(now - c.startedAt)} min ago (budget ${mins(BUDGET_MS)} min); not merged`,
    `auto-merge ${o.pr.autoMerge === undefined ? 'NOT CHECKED' : o.pr.autoMerge ? 'on' : 'OFF'}`,
    o.pr.mergeableState ? `mergeable_state ${o.pr.mergeableState}` : '',
    summariseRuns(o.runs),
  ].filter(Boolean).join('; ')
  return `${OWN} ${key} is over its time budget: ${facts}. ` +
    `Find where the time went (${STAGES.join(' / ')}): read the PR's check runs (queued vs started times), its merge-train status and comment, ` +
    `and .github/MERGE-TRAIN.md. Measure; do not guess. Then call mcp__slowness-report__report once with pr "${key}", the stage, the cause, ` +
    `the evidence (run ids, check names, minutes) and the fix. It records ONE occurrence comment on the ticket that owns that cause ` +
    `(never a new ticket). Keep moving the change itself too: a data fix can be applied as data now (CLAUDE.md section 3).`
}

export type Report = {
  subject: string
  stage: Stage
  cause: string
  evidence: string
  fix: string
  pr?: string
  startedAt?: number
  waitedMinutes?: number
  stillWaiting?: boolean
  /** An existing ticket that already owns this cause better than the default table (e.g. LC-2076 for data writes). */
  causeTicket?: string
  source: 'auto' | 'operator' | 'session'
}

/** Checks the model's report call. Returns the report or the reason it was refused. */
export function readReport(a: Record<string, unknown>, source: Report['source']): Report | string {
  const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string).trim() : '')
  const missing = ['subject', 'stage', 'cause', 'evidence', 'fix'].filter(k => !s(k))
  if (missing.length) return `${OWN} missing ${missing.join(', ')}. Every occurrence needs what was being changed, the stage, the cause, the evidence and the fix.`
  const stage = s('stage') as Stage
  if (!STAGES.includes(stage)) return `${OWN} stage must be one of ${STAGES.join(', ')}.`
  const ticket = s('cause_ticket').toUpperCase()
  if (ticket && !/^(LCH|LC|BBM|LCC)-\d+$/.test(ticket)) return `${OWN} cause_ticket must be an existing LCH/LC/BBM/LCC key, e.g. LCH-614.`
  const started = s('started_at') ? Date.parse(s('started_at')) : NaN
  const waited = Number(a.waited_minutes)
  return {
    subject: s('subject'), stage, cause: s('cause'), evidence: s('evidence'), fix: s('fix'),
    ...(s('pr') ? { pr: s('pr') } : {}),
    ...(Number.isFinite(started) ? { startedAt: started } : {}),
    ...(Number.isFinite(waited) && waited > 0 ? { waitedMinutes: Math.round(waited) } : {}),
    ...(a.still_waiting === true ? { stillWaiting: true } : {}),
    ...(ticket ? { causeTicket: ticket } : {}),
    source,
  }
}

/** Accepts `owner/repo#N`, `#N` or `N` (the last two need a default repo) -> a clock key. */
export function normalisePr(pr: string | undefined, defaultRepo?: { owner: string; repo: string }): string | undefined {
  if (!pr) return undefined
  const full = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(pr.trim())
  if (full) return `${full[1]}/${full[2]}#${full[3]}`
  const url = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(pr)
  if (url) return `${url[1]}/${url[2]}#${url[3]}`
  const n = /^#?(\d+)$/.exec(pr.trim())
  return n && defaultRepo ? `${defaultRepo.owner}/${defaultRepo.repo}#${n[1]}` : undefined
}

/** The measured clock wins over the model's numbers; the model's numbers fill in when no clock ran. */
export function timing(r: Report, clock: Clock | undefined, now: number): { startedAt?: number; waited?: number; measured: boolean } {
  if (clock) return { startedAt: clock.startedAt, waited: mins(now - clock.startedAt), measured: true }
  if (r.startedAt !== undefined) return { startedAt: r.startedAt, waited: mins(now - r.startedAt), measured: false }
  return { waited: r.waitedMinutes, measured: false }
}

/** Where this occurrence is recorded: the session's named cause ticket, else the table's owner for the stage. */
export function causeTicketFor(r: Report): string {
  return r.causeTicket ?? CAUSE_TICKETS[r.stage]
}

export type Route = { ticket: string; note?: string }

/**
 * LCH-720: where the occurrence is actually written, given the owner's Jira status category ('new', 'indeterminate',
 * 'done'; undefined = could not read it). A closed owner sends it to the epic with a note naming the closed ticket, so
 * the occurrence stays where someone reads it and the stale table entry is visible. An unreadable status keeps the
 * owner (fail open: a Jira hiccup must not move every report) and says the status was NOT CHECKED.
 */
export function routeOccurrence(owner: string, statusCategory: string | undefined): Route {
  if (owner === EPIC) return { ticket: EPIC }
  if (statusCategory === undefined) return { ticket: owner, note: `owner status NOT CHECKED (Jira status unreadable)` }
  if (statusCategory.toLowerCase() === 'done') {
    return { ticket: EPIC, note: `cause owner ${owner} is closed, so this was recorded on ${EPIC} instead; point CAUSE_TICKETS (claude-mods/slowness-report/hooks/logic.ts) or cause_ticket at an open story (LCH-720)` }
  }
  return { ticket: owner }
}

/** Jira getJiraIssue text -> the status category key, or undefined when it cannot be read. */
export function statusCategoryFrom(text: string | undefined): string | undefined {
  const v = text === undefined ? undefined : json(text) as any
  const issue = v?.issues?.nodes?.[0] ?? v
  const key = issue?.fields?.status?.statusCategory?.key
  return typeof key === 'string' && key ? key : undefined
}

/** One occurrence, as one comment. Its first line is fixed-format so occurrences can be counted and grepped. */
export function occurrenceBody(r: Report, t: ReturnType<typeof timing>, now: number, routeNote?: string): string {
  const by = r.source === 'auto' ? 'auto: PR passed its time budget' : r.source === 'operator' ? 'operator ran /slow' : 'session report'
  return [
    `SLOWNESS OCCURRENCE ${iso(now)} | stage ${r.stage} | waited ${t.waited !== undefined ? `${t.waited} min` : 'NOT CHECKED'} (budget ${mins(BUDGET_MS)}) | ${r.pr ?? 'no PR'} | ${by}`,
    '',
    `- Change: ${r.subject}`,
    `- Clock: started ${t.startedAt !== undefined ? iso(t.startedAt) : 'NOT CHECKED'}${t.measured ? ' (measured from PR creation)' : ' (as reported)'}; still waiting: ${r.stillWaiting ? 'yes' : 'no / not stated'}`,
    `- Cause: ${r.cause}`,
    `- Evidence: ${r.evidence}`,
    `- Fix / note: ${r.fix}`,
    ...(routeNote ? [`- Routing: ${routeNote}`] : []),
    '',
    `Recorded by the slowness-report mod (epic ${EPIC}). One comment per occurrence; the count of these comments is this cause's recurrence.`,
  ].join('\n')
}

/** What /slow asks the session to do. */
export function operatorAsk(args: string): string {
  const what = args.trim() || '(not described: work out from this session what is waiting)'
  return `${OWN} The operator ran /slow: something in this session is taking too long. They said: "${what}". ` +
    `Find what is waiting and measure where the time went (runner queue / checks running / merge train / failed check & retry / deploy / review / human), ` +
    `from check runs, merge-train status and workflow runs, not from memory. Then call mcp__slowness-report__report (source is recorded as the operator) ` +
    `with the PR if there is one; it records one occurrence on the ticket that owns the cause (never a new ticket). ` +
    `Tell the operator in plain words what is stuck, why, and which cause ticket it was recorded on. ` +
    `Then keep the actual change moving.`
}
