import type { Watch } from '../types'

// Pure decisions for dispatch-watch (LCH-528). register.ts only gathers facts and acts.
//
// Why this exists: a session that starts a workflow through the github-dispatch bridge has no
// GitHub access to the target repo (LC-1879), so it could not see the run. On 2026-10-20 a
// refresh-run.yml run finished in 85 s having done nothing, and the session waited hours on a
// check-in it had scheduled for later. Memory 1440431b had already said "check within 1-2
// minutes; a fast finish is the signal". This mod does that check, every minute, by itself.

export const POLL_MS = 60_000
export const NO_RUN_MS = 6 * 60_000 // no run listed this long after dispatch: it never registered
export const LONG_MS = 90 * 60_000 // still running this long: say so once
export const FAST_MS = 2 * 60_000 // finished faster than this: likely did nothing (1440431b)
export const REPLY_STALE_MS = 5 * 60_000 // pg_net never answered the status request: send another

const FN_URL = 'https://tlcbwwgfqnasmiipgmmd.supabase.co/functions/v1/github-dispatch'
// pg_net's default is 5 s; the bridge mints an App token and lists runs, which can take longer.
// A status poll that hit 5 s paged as cron_http_timeout (incident 6b1a672a, 2026-11-18).
export const STATUS_TIMEOUT_MS = 30_000

// LCH-543: an old copy of this mod could not read its own request ids, so it re-sent every watch's status request
// every minute for days (about 27 watches, 1,600 requests an hour) and never read a reply. A watch now ends itself
// after this many unreadable sends in a row, or at this age, whatever the replies say.
export const MAX_SEND_FAILS = 3
export const MAX_WATCH_MS = 6 * 60 * 60_000

/** Why a watch must stop before sending again, or null to carry on. */
export function giveUp(w: Pick<Watch, 'workflow' | 'startedAt' | 'sendFails'>, now: number): string | null {
  const tag = `[mod:dispatch-watch] ${w.workflow}`
  if ((w.sendFails ?? 0) >= MAX_SEND_FAILS) {
    return `${tag}: ${MAX_SEND_FAILS} status requests in a row returned no request id, so I stopped watching. ` +
      'Check the run another way.'
  }
  if (now - w.startedAt >= MAX_WATCH_MS) {
    return `${tag}: watched for ${Math.round(MAX_WATCH_MS / 3_600_000)} h with no end state, so I stopped watching. ` +
      'Check the run another way.'
  }
  return null
}

/** The workflow a bridge DISPATCH names, or null (a status request is not a dispatch). */
export function parseDispatch(query: string): string | null {
  // The real bridge only: its function URL, not any http_post that mentions the name.
  if (!/\/functions\/v1\/github-dispatch\b/.test(query) || !/net\.http_post/i.test(query)) return null
  if (/"action"\s*:\s*"status"/.test(query)) return null
  const m = query.match(/"workflow"\s*:\s*"([\w.-]+)"/)
  return m ? m[1]! : null
}

/** SQL that sends the bridge's read-only status request; the secret is read inside the statement. */
export function statusSql(w: Pick<Watch, 'workflow' | 'since'>): string {
  const body = JSON.stringify({ action: 'status', workflow: w.workflow, since: w.since }).replace(/'/g, "''")
  // LCH-543: the secret travels in the x-cron-secret header; request logs record the URL.
  return `select net.http_post(url := '${FN_URL}', headers := jsonb_build_object('Content-Type', 'application/json', ` +
    `'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'edge_function_shared_secret')), ` +
    `body := '${body}'::jsonb, timeout_milliseconds := ${STATUS_TIMEOUT_MS}) as req_id`
}

export function replySql(reqId: number): string {
  return `select status_code, content::text as content from net._http_response where id = ${Math.trunc(reqId)}`
}

/** The JSON rows inside an execute_sql result text (the MCP wraps them in an untrusted-data block). */
export function sqlRows(text: string): Record<string, unknown>[] | null {
  let body = text
  try {
    const outer = JSON.parse(text)
    if (outer && typeof outer.result === 'string') body = outer.result
  } catch { /* already the inner text */ }
  const m = body.match(/<untrusted-data-[^>]*>\s*([\s\S]*?)\s*<\/untrusted-data/)
  try {
    const rows = JSON.parse(m ? m[1]! : body)
    return Array.isArray(rows) ? rows.filter(r => r && typeof r === 'object') : null
  } catch { return null }
}

export function parseReqId(text: string): number | null {
  const id = Number(sqlRows(text)?.[0]?.req_id)
  return Number.isFinite(id) && id > 0 ? id : null
}

export type Run = { id: number; status: string; conclusion: string | null; created_at: string;
  updated_at: string; run_started_at: string | null; html_url: string }
export type Reply = { kind: 'pending' } | { kind: 'error'; detail: string } | { kind: 'runs'; runs: Run[] }

/** The bridge's answer from a net._http_response read. */
export function parseReply(text: string): Reply {
  const row = sqlRows(text)?.[0]
  if (!row) return { kind: 'pending' }
  const code = Number(row.status_code)
  let content: any
  try { content = JSON.parse(String(row.content ?? '')) } catch { content = null }
  if (code !== 200 || !content?.ok || !Array.isArray(content.runs)) {
    return { kind: 'error', detail: `HTTP ${row.status_code}: ${String(content?.message ?? row.content ?? '').slice(0, 160)}` }
  }
  return { kind: 'runs', runs: content.runs as Run[] }
}

export type Decision = { done: boolean; wake?: string; warnedLong?: boolean; /** When the event the wake reports really happened (LC-2043). */ eventAt?: number }

const mins = (ms: number) => (ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`)

/** What one status answer means for a watch. */
export function decide(w: Watch, reply: Reply, now: number): Decision {
  const tag = `[mod:dispatch-watch] ${w.workflow}`
  if (reply.kind === 'pending') return { done: false }
  if (reply.kind === 'error') {
    return { done: true, wake: `${tag}: the status check failed (${reply.detail}). The run's state is unknown; ` +
      'check it another way before waiting on it.' }
  }
  const floor = Date.parse(w.since)
  const run = reply.runs.find(r => Date.parse(r.created_at) >= floor)
  if (!run) {
    return now - w.startedAt > NO_RUN_MS
      ? { done: true, eventAt: w.startedAt + NO_RUN_MS, wake: `${tag}: no run appeared ${mins(now - w.startedAt)} after the dispatch. It likely never ` +
          'registered: read the dispatch reply in net._http_response before waiting further.' }
      : { done: false }
  }
  if (run.status !== 'completed') {
    if (now - w.startedAt > LONG_MS && !w.warnedLong) {
      return { done: false, warnedLong: true, eventAt: w.startedAt + LONG_MS, wake: `${tag} run ${run.id} is still ${run.status} after ` +
        `${mins(now - w.startedAt)}. ${run.html_url}` }
    }
    return { done: false }
  }
  const took = Date.parse(run.updated_at) - Date.parse(run.run_started_at ?? run.created_at)
  const fast = Number.isFinite(took) && took < FAST_MS
  return { done: true, eventAt: Date.parse(run.updated_at), wake: `${tag} run ${run.id} finished: ${run.conclusion ?? 'no conclusion'} after ${mins(took)}. ` +
    `${run.html_url}` + (fast ? ' A finish under 2 minutes usually means it did nothing (memory 1440431b: a section ' +
    'parked at `partial`; read the newest receipts and redispatch it by name).' : ' Read its outcome and continue.') }
}

/** The key other mods use for a bridge dispatch of `workflow` (unwatched-job-guard, LC-1975). */
export const watchKey = (workflow: string) => `dispatch:${workflow}`.toLowerCase()

// LATE-NOTE-BEGIN (LC-2043; keep identical in the logic.ts of fleet-tracker, pr-ci-watch, workflow-run-watch and dispatch-watch)
// A wake delivered long after its event reads as news. When the timer that should have fired it stopped (the session
// idled), the event can be hours old: say when it really happened and how late it arrives.
export const LATE_MS = 5 * 60_000
export type Wake = { text: string; at: number }
export function lateNote(eventAt: number, deliveredAt: number): string {
  const late = deliveredAt - eventAt
  if (!Number.isFinite(eventAt) || !Number.isFinite(deliveredAt) || late < LATE_MS) return ''
  const iso = new Date(eventAt).toISOString()
  const when = late >= 12 * 3_600_000 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z` : `${iso.slice(11, 16)}Z`
  return ` (event at ${when}, delivered ${Math.round(late / 60_000)} min late)`
}
export const stampWake = (w: Wake, deliveredAt: number): string => w.text + lateNote(w.at, deliveredAt)
// LATE-NOTE-END

// LC-2043: the watch list lives in $.state, which a process or container restart empties (2026-11-05: the list was
// found empty twice and six merges went unannounced). register.ts saves it to $.store with the session's id; this
// decides what may come back. Only a list saved by THIS session returns: an unreadable id, another session's list
// (a fresh session, or another session sharing the same machine) or a malformed one restores nothing.
export type Saved = { sessionId: string; watches: Watch[]; finished: string[] }

export function restorable(saved: unknown, sessionId: string): { watches: Watch[]; finished: string[] } | undefined {
  if (!sessionId || !saved || typeof saved !== 'object') return undefined
  const s = saved as Partial<Saved>
  if (s.sessionId !== sessionId || !Array.isArray(s.watches)) return undefined
  // A row needs a real start time, a server to poll through and the fields that name what it watches; anything
  // else would poll nothing or wake on garbage.
  const watches = s.watches.filter(w => !!w && typeof w === 'object' && Number.isFinite((w as Watch).startedAt)
    && typeof (w as Watch).server === 'string' && (w as Watch).server !== ''
    && typeof (w as Watch).workflow === 'string' && (w as Watch).workflow !== '' && typeof (w as Watch).projectId === 'string' && (w as Watch).projectId !== ''
    && typeof (w as Watch).since === 'string' && (w as Watch).since !== '')
  const finished = Array.isArray(s.finished) ? s.finished.filter((k): k is string => typeof k === 'string') : []
  return { watches, finished }
}
