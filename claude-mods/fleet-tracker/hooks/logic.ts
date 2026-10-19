// Pure wake decision for fleet-tracker, split out so leave-and-return cycles
// can be tested directly (the mod harness re-arms its poll timer only once per
// test, so a multi-transition sequence cannot be driven through the timer).

export const NEEDS_STAN = new Set(['BLOCKED', 'FAILED'])
const WAKE_ORCHESTRATOR = new Set(['BLOCKED', 'FAILED', 'REVIEW_READY', 'COMPLETED', 'NEEDS_INPUT'])

// SUPPRESSION IS EXACT PHRASES ONLY; ANYTHING ELSE WAKES.
// An extra wake costs the orchestrator one cheap turn; a missed wake loses a READY
// report for good. Four rounds of widening regexes each produced a new false
// suppression, so the filter is an anchored allowlist: a summary is "just waiting
// on CI" only when its WHOLE trimmed text is one of these short phrases, with an
// optional leading "PR #N" and trailing "on <sha|number|#N>" reference. Do NOT widen
// this with free-text patterns; add a new exact phrase and a test instead.
const WAIT_PHRASE = new RegExp(
  '^(?:pr\\s*#\\d+[,:]?\\s+)?(?:' + [
    'waiting (?:on|for) (?:ci|checks|ci checks|re-?run)(?: to (?:pass|finish|complete|go green))?',
    'awaiting (?:ci|checks|re-?run)',
    '(?:ci|checks?)(?: is| are)?(?: still)? (?:running|re-?running|restarting|pending|queued|in progress|polling)',
    'polling for completion',
  ].join('|') + ')(?:\\s+(?:on|for)\\s+(?:#\\d+|\\d+|[0-9a-f]{3,40}))?\\s*[.!]?$',
  'i',
)
// `READY:` / `NEEDS STAN:` are the protocol our briefs require at the end of a turn.
// Anywhere in a summary they mean "not just waiting", checked before the allowlist,
// so they can never be filtered.
const PROTOCOL = /\b(READY|NEEDS STAN):/i

function justWaitingOn(summary: string): boolean {
  if (PROTOCOL.test(summary)) return false
  return WAIT_PHRASE.test(summary.trim())
}

export function decideWake(
  lastWoken: Map<string, string>,
  sessionId: string,
  prevBucket: string,
  bucket: string,
  summary: string,
): { wake: boolean; holdPrevBucket: boolean } {
  // Two polls can overlap (timer + a status/track call) and both see the old
  // bucket; the memory covers only that overlap. Leaving the bucket clears it,
  // so a later re-entry (BLOCKED -> RUNNING -> BLOCKED) wakes again.
  if (lastWoken.has(sessionId) && lastWoken.get(sessionId) !== bucket) lastWoken.delete(sessionId)
  // A session that says it is just waiting on CI has nothing for the
  // orchestrator yet (seen 2026-10-07). Never applies to BLOCKED/FAILED.
  const justWaiting = !NEEDS_STAN.has(bucket) && justWaitingOn(summary)
  const alreadyWoken = lastWoken.get(sessionId) === bucket
  // A just-created session briefly reports REVIEW_READY/COMPLETED with an
  // empty summary before its first turn ends (seen 2026-10-07); not a signal.
  const startupBlip = prevBucket === '' && !summary.trim() && !NEEDS_STAN.has(bucket)
  // A suppressed wake must not record the new bucket on the row: otherwise the
  // next poll (now with a real summary) sees no transition and the wake is lost.
  // Hold the PREVIOUS bucket (not ''): '' would make a later empty-summary poll
  // look like a brand-new session and get filtered as a blip. For a blip the
  // previous bucket is already ''.
  const wakeBucketEntry = bucket !== prevBucket && WAKE_ORCHESTRATOR.has(bucket)
  if (wakeBucketEntry && (startupBlip || justWaiting)) return { wake: false, holdPrevBucket: true }
  if (wakeBucketEntry && !alreadyWoken) {
    lastWoken.set(sessionId, bucket)
    return { wake: true, holdPrevBucket: false }
  }
  return { wake: false, holdPrevBucket: false }
}

// ---- Stall detection (LC-1834) ----
// A hung session never changes bucket: it sits in WORKING, so the wake gate above
// never fires (Stan, 2026-10-15: "it gets hung and nobody nudges it for an hour").
// get_session's updated_at only moves at turn boundaries (measured 2026-10-15: it
// stayed put across a dozen tool calls in one turn), so progress is read from the
// newest transcript event instead, which moves on every tool call and reply.
// Presence is not progress (CLAUDE.md §4): WORKING with no new event IS the stall.
export const STALL_MS = 15 * 60_000 // a single long test run can sit quiet ~10 min
export const ESCALATE_MS = 10 * 60_000 // how long a nudge gets before the orchestrator hears

export type StallStep = 'none' | 'clear' | 'nudge' | 'escalate'

export function decideStall(
  bucket: string,
  lastActivityMs: number | null,
  now: number,
  nudgedAt: number,
  escalated: boolean,
): StallStep {
  const flagged = nudgedAt > 0 || escalated
  // A bad poll's UNKNOWN is not a bucket change: clearing on it would restart the
  // nudge cycle on a flapping session (review finding 6).
  if (bucket === 'UNKNOWN') return 'none'
  // Only a session mid-turn can be hung; every other bucket already wakes on entry.
  if (bucket !== 'WORKING') return flagged ? 'clear' : 'none'
  if (lastActivityMs === null) {
    // Unknown activity never STARTS a stall (it is evidence about our poll). But once
    // nudged, a transcript we cannot read for the whole window must not hide the
    // stall forever: the orchestrator hears (review finding 5).
    if (nudgedAt && !escalated && now - nudgedAt >= ESCALATE_MS) return 'escalate'
    return 'none'
  }
  if (now - lastActivityMs < STALL_MS) return flagged ? 'clear' : 'none'
  if (!nudgedAt) return 'nudge'
  if (!escalated && now - nudgedAt >= ESCALATE_MS) return 'escalate'
  return 'none'
}

// Newest event time from a list_events reply, skipping our own nudge (its delivery
// is an event too, and must not read as the session waking up). null = unreadable.
export function newestActivity(listEventsText: string): number | null {
  const start = listEventsText.indexOf('{'), end = listEventsText.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let data: unknown
  try {
    const parsed = JSON.parse(listEventsText.slice(start, end + 1))
    data = (parsed.ccr ?? parsed).data
  } catch {
    return null
  }
  if (!Array.isArray(data)) return null
  let best: number | null = null
  for (const ev of data) {
    // Only the delivered message (a user event) is skipped: a reply quoting it is real work.
    if ((ev as { user?: unknown })?.user && JSON.stringify(ev).includes(NUDGE_MARK)) continue
    const t = Date.parse(String((ev as { created_at?: unknown })?.created_at ?? ''))
    if (!Number.isNaN(t) && (best === null || t > best)) best = t
  }
  return best
}

export const NUDGE_MARK = '[mod:fleet-tracker] stall-nudge'
export const NUDGE_TEXT =
  `${NUDGE_MARK}: automated check from your orchestrator's fleet monitor. This session has shown ` +
  'no new activity for 15+ minutes. If you stopped to ask whether this is really your task: it is, ' +
  'continue it. If you are waiting on a long command that is still making progress (a CI run, a ' +
  'sweep), do NOT stop it: reply with one line saying what you are waiting on and keep waiting. ' +
  'Stop a command only if you have confirmed it is hung. If something genuinely blocks you, end ' +
  'your turn with a line starting `NEEDS STAN:` saying what; that line is how your orchestrator hears you.'

// Jira key from a session title or brief, for auto-tracked rows.
export function ticketOf(...texts: unknown[]): string {
  for (const t of texts) {
    const m = String(t ?? '').match(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/)
    if (m) return m[0]
  }
  return 'untagged'
}

// The new child's id from a create_session result. Structured fields first; the text
// fallback takes only real-length ids and never the caller's own (review finding 1:
// a first-match regex caught the literal key `session_id`, or the parent's id, and
// the mod then watched -- and could nudge -- the orchestrator itself).
const ID = /\bsession_[0-9A-Za-z]{16,}\b/g

export function childIdOf(resultText: string, ownId: string): string | null {
  const ok = (v: unknown) => typeof v === 'string' && /^session_[0-9A-Za-z]{16,}$/.test(v) && v !== ownId
  const start = resultText.indexOf('{'), end = resultText.lastIndexOf('}')
  // Without our own id the child cannot be told from the parent in a structured field,
  // so the structured path is skipped and the text scan must find exactly one id.
  if (ownId !== '' && start >= 0 && end > start) {
    try {
      const j = JSON.parse(resultText.slice(start, end + 1))
      // ALL valid ids in the structured fields, not the first (PR #1808 review): a result
      // naming two different sessions must not be settled by field order.
      const found = [...new Set([j?.id, j?.session_id, j?.ccr?.id, j?.session?.id, j?.ccr?.session_id].filter(ok) as string[])]
      if (found.length === 1) return found[0]
    } catch { /* fall through to the text scan */ }
  }
  const ids = [...new Set(resultText.match(ID) ?? [])].filter(ok)
  // Exactly one candidate or nothing: a guess would track the wrong session.
  return ids.length === 1 ? ids[0] : null
}

// ---- Close-out reminder (LC-1835) ----
// Claude is responsible for the sessions it spins up (Stan, 2026-10-15): a child that
// finished and was never archived is a leak. A row that has sat in COMPLETED or
// REVIEW_READY for CLOSEOUT_MS without changing bucket gets ONE wake per bucket episode.
export const CLOSEOUT_MS = 60 * 60_000
export const CLOSEOUT_BUCKETS = new Set(['COMPLETED', 'REVIEW_READY'])

export function decideCloseout(bucket: string, bucketSince: number, now: number, alreadyWoken: boolean): boolean {
  if (alreadyWoken || !CLOSEOUT_BUCKETS.has(bucket) || !bucketSince) return false
  return now - bucketSince >= CLOSEOUT_MS
}

export function closeoutLine(ticket: string, label: string, bucket: string, bucketSince: number, now: number): string {
  const mins = Math.floor((now - bucketSince) / 60_000)
  return `${ticket} (${label}) idle in ${bucket} for ${mins}m: close it out — untrack (archives) or untrack with keep_reason`
}

// Buckets in which archiving would lose live work (unpushed commits, an unanswered question).
export const LIVE_BUCKETS = new Set(['WORKING', 'NEEDS_INPUT'])
// Archive is an ALLOWLIST (review of LC-1835): only a child that a fresh, error-free
// poll shows as finished may be archived. A denylist of live buckets let a stale row
// (poll error kept the old COMPLETED), UNKNOWN, '' (not yet polled) or BLOCKED through,
// and archiving a session that still holds unpushed work destroys it.
export const CLOSABLE_BUCKETS = new Set(['COMPLETED', 'REVIEW_READY'])

