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
  return `select net.http_post(url := '${FN_URL}?secret=' || (select decrypted_secret from vault.decrypted_secrets ` +
    `where name = 'edge_function_shared_secret'), headers := '{"Content-Type":"application/json"}'::jsonb, ` +
    `body := '${body}'::jsonb) as req_id`
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

export type Decision = { done: boolean; wake?: string; warnedLong?: boolean }

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
      ? { done: true, wake: `${tag}: no run appeared ${mins(now - w.startedAt)} after the dispatch. It likely never ` +
          'registered: read the dispatch reply in net._http_response before waiting further.' }
      : { done: false }
  }
  if (run.status !== 'completed') {
    if (now - w.startedAt > LONG_MS && !w.warnedLong) {
      return { done: false, warnedLong: true, wake: `${tag} run ${run.id} is still ${run.status} after ` +
        `${mins(now - w.startedAt)}. ${run.html_url}` }
    }
    return { done: false }
  }
  const took = Date.parse(run.updated_at) - Date.parse(run.run_started_at ?? run.created_at)
  const fast = Number.isFinite(took) && took < FAST_MS
  return { done: true, wake: `${tag} run ${run.id} finished: ${run.conclusion ?? 'no conclusion'} after ${mins(took)}. ` +
    `${run.html_url}` + (fast ? ' A finish under 2 minutes usually means it did nothing (memory 1440431b: a section ' +
    'parked at `partial`; read the newest receipts and redispatch it by name).' : ' Read its outcome and continue.') }
}
