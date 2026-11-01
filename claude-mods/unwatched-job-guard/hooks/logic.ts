// unwatched-job-guard (LC-1975, fix 3). One job: a session another session created may not end its turn
// while a job it started is unfinished and nothing is watching it.
//
// Why: on 2026-10-31 child sessions ended turns with "the run will wake me" and nothing did. LC-1935 sat
// ~3 h after its run finished; LC-1967 waited 3 h+ on a DB-test run and then on an armed PR the queue
// never took. The watcher mods (dispatch-watch, workflow-run-watch, pr-ci-watch) cover the usual starts;
// this guard is the net under them: any start no watcher holds blocks the turn's end, deterministically.
// Top-level sessions (a person is there) are never blocked: they get a toast.

import type { Job } from '../types'

export const MAX_BLOCKS = 2 // per job: then the turn may end (toasted), so a guard bug can never trap a session
export const OWN = '[mod:unwatched-job-guard]'

const FN_RE = /\/functions\/v1\/github-dispatch\b/

/** The job a tool call starts, or null. `e` is the tool.call event (tool name + args). */
export function jobOf(e: Record<string, any>, now: number): Job | null {
  const tool = String(e.tool ?? '')
  if (/^mcp__.*__execute_sql$/.test(tool)) {
    const q = String(e.query ?? '')
    if (!FN_RE.test(q) || !/net\.http_post/i.test(q) || /"action"\s*:\s*"status"/.test(q)) return null
    const m = q.match(/"workflow"\s*:\s*"([\w.-]+)"/)
    return m ? { key: `dispatch:${m[1]}`.toLowerCase(), holder: 'dispatch-watch', what: `bridge dispatch of ${m[1]}`, startedAt: now } : null
  }
  if (/^mcp__.*__actions_run_trigger$/.test(tool)) {
    const method = String(e.method ?? '')
    if (!e.owner || !e.repo) return null
    if (method === 'run_workflow' && String(e.workflow_id ?? '').trim()) {
      const wf = String(e.workflow_id).trim().replace(/^.*\//, '')
      return { key: `run:${e.owner}/${e.repo}:${wf}`.toLowerCase(), holder: 'workflow-run-watch', what: `${e.owner}/${e.repo} ${wf} (started)`, startedAt: now }
    }
    if ((method === 'rerun_workflow_run' || method === 'rerun_failed_jobs') && Number.isInteger(Number(e.run_id)) && Number(e.run_id) > 0) {
      return { key: `run:${e.owner}/${e.repo}:${Number(e.run_id)}`.toLowerCase(), holder: 'workflow-run-watch', what: `${e.owner}/${e.repo} run ${e.run_id} (re-run)`, startedAt: now }
    }
    return null
  }
  if (/^mcp__.*__enable_pr_auto_merge$/.test(tool)) {
    const n = Number(e.pullNumber)
    if (!e.owner || !e.repo || !Number.isInteger(n)) return null
    return { key: `pr:${e.owner}/${e.repo}#${n}`.toLowerCase(), holder: 'pr-ci-watch', what: `${e.owner}/${e.repo}#${n} armed for auto-merge`, startedAt: now }
  }
  return null
}

/** Every job a tool call starts: one for an MCP start, one per matching segment of a shell command. */
export function jobsOf(e: Record<string, any>, now: number): Job[] {
  if (String(e.tool ?? '') !== 'Bash') {
    const j = jobOf(e, now)
    return j ? [j] : []
  }
  const out: Job[] = []
  // Quotes removed and every separator split (&, |, $( and backticks too), so `a & b` and `bash -c '...'` count each start.
  for (const part of String(e.command ?? '').replace(/['"]/g, ' ').split(/&&|\|\||[;&|\n`]|\$\(|\)/)) {
    const p = part.trim().replace(/\s+/g, ' ')
    if (!p) continue
    if (/\bgh workflow run\b|\bgh run rerun\b|\bgh pr merge\b.*--auto\b|actions\/workflows\/[^\s/]+\/dispatches/.test(p)) {
      const cmd = p.slice(0, 120)
      if (!out.some(j => j.key === `bash:${cmd}`)) out.push({ key: `bash:${cmd}`, what: `shell start: \`${cmd}\``, startedAt: now })
    }
  }
  return out
}

/** Tools whose call counts as a check-in that will bring the session back. */
export const CHECK_IN_RE = /^(mcp__.*__send_later|mcp__.*__create_trigger|ScheduleWakeup|Monitor|CronCreate)$/

export type Held = { active: string[]; finished: string[] } | null

/** A watcher's `watching` reply, or null when it is unreadable (mod not loaded, error, garbage). */
export function parseWatching(out: any): Held {
  if (!out || out.deny || out.isError) return null
  const text = typeof out.result === 'string' ? out.result : typeof out.text === 'string' ? out.text : ''
  try {
    const v = JSON.parse(text)
    if (Array.isArray(v?.active) && Array.isArray(v?.finished)) return { active: v.active.map(String), finished: v.finished.map(String) }
  } catch { /* unreadable */ }
  return null
}

export type Verdict = { finished: string[]; unwatched: { job: Job; why: string }[] }

/** Splits open jobs into finished (drop them) and unwatched (block on them). Held jobs are neither. */
export function judge(jobs: Job[], held: Record<string, Held>): Verdict {
  const v: Verdict = { finished: [], unwatched: [] }
  for (const j of jobs) {
    if (j.checkIn) continue
    if (!j.holder) { v.unwatched.push({ job: j, why: 'no watcher mod follows a shell start' }); continue }
    const h = held[j.holder]
    if (h === null || h === undefined) { v.unwatched.push({ job: j, why: `${j.holder} is not loaded or did not answer` }); continue }
    if (h.active.includes(j.key)) continue
    if (h.finished.includes(j.key)) { v.finished.push(j.key); continue }
    v.unwatched.push({ job: j, why: `${j.holder} is not watching it` })
  }
  return v
}

const REMEDY: Record<string, string> = {
  'pr-ci-watch': 'call mcp__pr-ci-watch__watch_pr with armed: true',
  'dispatch-watch': 'read its run now (dispatch-watch\'s status request) and stay on it until it finishes',
  'workflow-run-watch': 'read the run now with actions_get / actions_list and stay on it until it finishes',
}

export function blockText(u: Verdict['unwatched']): string {
  const lines = u.map(({ job, why }) => `- ${job.what}: ${why}. Fix: ${job.holder ? REMEDY[job.holder] : 'check its result now and stay on it until it finishes'}, ` +
    'or schedule a check-in for when it should be done (send_later), or, if it already finished, call ' +
    `mcp__unwatched-job-guard__release with job "${job.key}" and what you saw.`)
  return `${OWN} No human is watching this session, and it is about to end its turn waiting on ${u.length} job(s) nothing will wake it ` +
    `for (LC-1975: "the run will wake me" left sessions idle for hours on 2026-10-31):\n${lines.join('\n')}`
}

// ---- who is watching (copied from no-ask-in-child, LC-1968: one mod cannot import another) ----

export type Signal = { kind: 'child'; parent: string } | { kind: 'top' } | { kind: 'unreadable'; reason: string }

function jsonObjects(raw: string): unknown[] {
  const out: unknown[] = []
  let i = 0
  while (i < raw.length) {
    i = raw.indexOf('{', i)
    if (i < 0) break
    let depth = 0, inStr = false, esc = false, end = -1
    for (let j = i; j < raw.length; j++) {
      const c = raw[j]
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
      if (c === '"') inStr = true
      else if (c === '{') depth++
      else if (c === '}' && --depth === 0) { end = j; break }
    }
    let next = i + 1
    if (end > i) { try { out.push(JSON.parse(raw.slice(i, end + 1))); next = end + 1 } catch { /* prose braces */ } }
    i = next
  }
  return out
}

/** get_session (no id) reply -> child / top / unreadable. Unreadable never blocks. */
export function signalOf(res: unknown): Signal {
  try {
    const r = res as { isError?: boolean; content?: readonly unknown[] } | null | undefined
    if (!r || typeof r !== 'object' || r.isError) return { kind: 'unreadable', reason: 'no reply or error' }
    const raw = (r.content ?? []).map(b => (b && typeof (b as any).text === 'string' ? (b as any).text : '')).join('')
    const all = (jsonObjects(raw) as any[]).map(o => o?.ccr).filter(c => c && typeof c.id === 'string' && c.id !== '')
    if (all.length !== 1) return { kind: 'unreadable', reason: `${all.length} session objects` }
    const p = all[0].parent_session_id
    if (typeof p === 'string' && p.trim() !== '') return { kind: 'child', parent: p.trim() }
    if (p === undefined || p === null || (typeof p === 'string' && p.trim() === '')) return { kind: 'top' }
    return { kind: 'unreadable', reason: 'parent_session_id has an unexpected type' }
  } catch (err) {
    return { kind: 'unreadable', reason: String(err).slice(0, 80) }
  }
}
