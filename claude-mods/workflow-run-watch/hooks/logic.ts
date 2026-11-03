// Pure decisions for workflow-run-watch (LC-1975). register.ts gathers facts (GitHub MCP) and acts.
//
// Why: on 2026-10-31 a child started a workflow straight through the GitHub MCP, ended its turn saying
// "the run will wake me", and nothing did: LC-1935 sat ~3 h after its run finished in a minute, and
// LC-1967 waited 3 h+ on a DB-test run. dispatch-watch covers only the github-dispatch bridge (and
// refresh-run.yml may only start there: refresh-start-path-guard). This covers every other workflow a
// session starts or re-runs directly, the same way: poll, then wake.

import type { Watch } from '../types'

export const POLL_MS = 60_000
export const NO_RUN_MS = 6 * 60_000
export const LONG_MS = 90 * 60_000
export const FAST_MS = 2 * 60_000
export const MAX_ERRORS = 5

export type Run = { id: number; status: string; conclusion: string | null; created_at: string; updated_at: string;
  run_started_at: string | null; html_url: string; event?: string }

export type Observation = { kind: 'runs'; runs: Run[] } | { kind: 'error'; detail: string }
export type Decision = { done: boolean; wake?: string; patch?: Partial<Watch>; /** When the event the wake reports really happened (LC-2043). */ eventAt?: number }

const STARTS = new Set(['run_workflow', 'rerun_workflow_run', 'rerun_failed_jobs'])

/** What an actions_run_trigger call starts, or null (cancel, delete logs, bad args). */
export function parseStart(a: Record<string, unknown>): { workflow?: string; runId?: number } | null {
  const method = String(a.method ?? '')
  if (!STARTS.has(method) || !a.owner || !a.repo) return null
  if (method === 'run_workflow') {
    const wf = String(a.workflow_id ?? '').trim()
    return wf ? { workflow: wf } : null
  }
  const id = Number(a.run_id)
  return Number.isInteger(id) && id > 0 ? { runId: id } : null
}

/** The key other mods use for this watch (unwatched-job-guard). */
export function watchKey(w: { owner: string; repo: string; workflow?: string; runId?: number }): string {
  // A run_workflow watch keeps its workflow key after the run id is found, so the guard can match it.
  const what = w.workflow !== undefined ? w.workflow.replace(/^.*\//, '') : String(w.runId)
  return `run:${w.owner}/${w.repo}:${what}`.toLowerCase()
}

function json(text: string): unknown {
  try { return JSON.parse(text) } catch { return undefined }
}

function isRun(r: any): r is Run {
  return r && typeof r === 'object' && typeof r.id === 'number' && typeof r.status === 'string' && typeof r.created_at === 'string'
}

/** Runs from list_workflow_runs text (a bare list or {workflow_runs}), or one run from get_workflow_run. */
export function parseRuns(text: string): Run[] | undefined {
  const v = json(text) as any
  if (isRun(v)) return [v]
  const list = Array.isArray(v) ? v : v?.workflow_runs
  if (!Array.isArray(list)) return undefined
  return list.filter(isRun)
}

const mins = (ms: number) => (ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`)

export function decide(w: Watch, o: Observation, now: number): Decision {
  const tag = `[mod:workflow-run-watch] ${w.owner}/${w.repo} ${w.workflow ?? 'workflow'}`
  if (o.kind === 'error') {
    const errors = (w.errors ?? 0) + 1
    if (errors < MAX_ERRORS) return { done: false, patch: { errors } }
    return { done: true, wake: `${tag}: could not read the run ${errors} times in a row (${o.detail}); stopped watching. Check it yourself now.` }
  }
  const floor = Date.parse(w.since)
  // A new run: created after the start. A re-run: the same id, with an attempt started after the start.
  const run = w.runId !== undefined
    ? o.runs.find(r => r.id === w.runId && Date.parse(r.run_started_at ?? r.created_at) >= floor)
    : o.runs.filter(r => Date.parse(r.created_at) >= floor).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0]
  if (!run) {
    return now - w.startedAt > NO_RUN_MS
      ? { done: true, eventAt: w.startedAt + NO_RUN_MS, wake: `${tag}: no run appeared ${mins(now - w.startedAt)} after the start. It likely never registered ` +
          '(a workflow_dispatch file must be on the default branch; check the ref and inputs) before waiting further.' }
      : { done: false, patch: { errors: 0 } }
  }
  const patch: Partial<Watch> = { errors: 0, runId: run.id }
  if (run.status !== 'completed') {
    if (now - w.startedAt > LONG_MS && !w.warnedLong) {
      return { done: false, patch: { ...patch, warnedLong: true }, eventAt: w.startedAt + LONG_MS, wake: `${tag} run ${run.id} is still ${run.status} after ` +
        `${mins(now - w.startedAt)}. A queued job may be waiting on a busy runner; check before assuming it is dead. ${run.html_url}` }
    }
    return { done: false, patch }
  }
  const took = Date.parse(run.updated_at) - Date.parse(run.run_started_at ?? run.created_at)
  const fast = Number.isFinite(took) && took < FAST_MS
  return { done: true, eventAt: Date.parse(run.updated_at), wake: `${tag} run ${run.id} finished: ${run.conclusion ?? 'no conclusion'} after ${mins(took)}. ${run.html_url}` +
    (fast ? ' A finish under 2 minutes often means it did nothing: read what it wrote before treating it as done.' : ' Read its outcome and continue.') }
}

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
