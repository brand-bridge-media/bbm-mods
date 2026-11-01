// What each child is waiting on, and whether that already finished (LC-1975, fix 4).
//
// Why: on 2026-10-31 children ended turns with "the run will wake me" and sat idle for hours after the
// thing finished (LC-1935: a run done in a minute, ~3 h idle; LC-1967: #2398). The child-side watchers
// (pr-ci-watch, workflow-run-watch, dispatch-watch) now wake the child, and unwatched-job-guard stops a
// child ending a turn on an unwatched job. This is the net under those: the orchestrator reads what the
// child announced it was waiting on, checks that thing itself, and is woken when it finished 10+ minutes
// ago while the child still sits idle. Pure decisions here; register.tsx gathers the facts.

export const AWAIT_STALE_MS = 10 * 60_000 // finished this long ago, child still idle: wake the orchestrator
export const AWAIT_CHECK_MS = 3 * 60_000 // re-check an open item at most this often (GitHub calls cost)
export const IDLE_BUCKETS = new Set(['REVIEW_READY', 'COMPLETED'])

import type { Await } from '../types'
export type { Await }

const lower = (s: string) => s.toLowerCase()

/** created_at of the event a match sits in: the nearest "created_at" before it in the list_events text. */
function eventTime(text: string, index: number): number {
  const before = text.slice(0, index)
  const all = [...before.matchAll(/"created_at"\s*:\s*"([^"]+)"/g)]
  const t = all.length ? Date.parse(all[all.length - 1]![1]!) : NaN
  return Number.isFinite(t) ? t : 0
}

/**
 * The watches a child announced, and the ones its own watcher already reported finished, from its transcript
 * (list_events text). Announcements and reports are the mods' own `[mod:<name>]` lines, so this needs no model.
 */
export function parseAwaits(text: string): { announced: Await[]; resolved: Map<string, number> } {
  const announced: Await[] = []
  const resolved = new Map<string, number>()
  const add = (a: Await) => { if (!announced.some(x => x.key === a.key && x.since >= a.since)) announced.push(a) }
  for (const m of text.matchAll(/\[mod:pr-ci-watch\] Watching (CI on )?([\w.-]+)\/([\w.-]+)#(\d+)( until it merges)?/g)) {
    add({ key: lower(`pr:${m[2]}/${m[3]}#${m[4]}`), kind: 'pr', owner: m[2], repo: m[3], number: Number(m[4]),
      untilMerge: !!m[5], since: eventTime(text, m.index!) })
  }
  // enable_pr_auto_merge on a PR already watched arms it in place: "[mod:pr-ci-watch] o/r#N is armed: watching it until it merges".
  for (const m of text.matchAll(/\[mod:pr-ci-watch\] ([\w.-]+)\/([\w.-]+)#(\d+) is armed: watching it until it merges/g)) {
    add({ key: lower(`pr:${m[1]}/${m[2]}#${m[3]}`), kind: 'pr', owner: m[1], repo: m[2], number: Number(m[3]), untilMerge: true, since: eventTime(text, m.index!) })
  }
  for (const m of text.matchAll(/\[mod:workflow-run-watch\] Watching ([\w.-]+)\/([\w.-]+) ([\w.-]+?)(?=:| run \d)/g)) {
    add({ key: lower(`run:${m[1]}/${m[2]}:${m[3]}`), kind: 'run', owner: m[1], repo: m[2], workflow: m[3], since: eventTime(text, m.index!) })
  }
  for (const m of text.matchAll(/\[mod:dispatch-watch\] Watching ([\w.-]+):/g)) {
    add({ key: lower(`dispatch:${m[1]}`), kind: 'dispatch', workflow: m[1], since: eventTime(text, m.index!) })
  }
  // The child's own watcher reported the END (it was woken): what it waited on is no longer the orchestrator's net.
  // Only final reports count: the 30-min "green but not merged" reminder is not the end; "but still not merged" is
  // the watcher giving up (#2444 review).
  const end = (key: string, i: number) => { const t = eventTime(text, i); if (t >= (resolved.get(key) ?? 0)) resolved.set(key, t) }
  for (const m of text.matchAll(/\[mod:pr-ci-watch\] ([\w.-]+)\/([\w.-]+)#(\d+)(?: merged| was closed|: CI finished|: could not read| is armed for auto-merge and green on \w+, but still not merged)/g)) {
    end(lower(`pr:${m[1]}/${m[2]}#${m[3]}`), m.index!)
  }
  for (const m of text.matchAll(/\[mod:workflow-run-watch\] ([\w.-]+)\/([\w.-]+) ([\w.-]+)(?: run \d+ finished|: no run appeared|: could not read)/g)) {
    end(lower(`run:${m[1]}/${m[2]}:${m[3]}`), m.index!)
  }
  for (const m of text.matchAll(/\[mod:dispatch-watch\] ([\w.-]+)(?: run \d+ finished|: no run appeared|: the status check failed)/g)) {
    end(lower(`dispatch:${m[1]}`), m.index!)
  }
  return { announced, resolved }
}

/** Merges a fresh parse into the row's list: new announcements added, items the child was told about dropped. */
export function mergeAwaits(prev: Await[], parsed: ReturnType<typeof parseAwaits>): Await[] {
  const out = new Map(prev.map(a => [a.key, a]))
  for (const a of parsed.announced) {
    const cur = out.get(a.key)
    if (!cur || a.since > cur.since) out.set(a.key, a) // a newer announcement is a new watch
  }
  for (const [key, at] of parsed.resolved) {
    const cur = out.get(key)
    if (cur && at >= cur.since) out.delete(key)
  }
  return [...out.values()].slice(-10)
}

export type ItemState = { done: boolean; what: string } | null // null = could not tell

const BAD = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale'])

/** A PR's state from pull_request_read get + get_check_runs texts. */
export function prState(getText: string, runsText: string | undefined, untilMerge: boolean): ItemState {
  let pr: any
  try { pr = JSON.parse(getText) } catch { return null }
  if (!pr || typeof pr !== 'object' || typeof pr.state !== 'string') return null
  // merged === true or a real timestamp; an empty or malformed merged_at is not a merge (#2444 review).
  if (pr.merged === true || (typeof pr.merged_at === 'string' && Number.isFinite(Date.parse(pr.merged_at)))) return { done: true, what: 'merged' }
  if (pr.state === 'closed') return { done: true, what: 'closed without merging' }
  if (runsText === undefined) return null
  let v: any
  try { v = JSON.parse(runsText) } catch { return null }
  const runs = Array.isArray(v) ? v : v?.check_runs
  if (!Array.isArray(runs)) return null
  const bad = runs.filter((r: any) => BAD.has(String(r?.conclusion ?? '').toLowerCase()))
  if (bad.length) return { done: true, what: `CI failed (${bad.slice(0, 3).map((r: any) => r.name).join(', ')})` }
  if (untilMerge) return { done: false, what: 'armed, not merged' }
  if (runs.length && runs.every((r: any) => String(r?.status ?? '').toLowerCase() === 'completed')) return { done: true, what: 'CI finished green' }
  return { done: false, what: 'CI running' }
}

/** A workflow's newest run created after `since`, from list_workflow_runs text. */
export function runState(text: string, since: number): ItemState {
  let v: any
  try { v = JSON.parse(text) } catch { return null }
  const list = Array.isArray(v) ? v : v?.workflow_runs
  if (!Array.isArray(list)) return null
  const run = list.filter((r: any) => Date.parse(r?.created_at) >= since - 60_000)
    .sort((a: any, b: any) => Date.parse(a.created_at) - Date.parse(b.created_at))[0]
  if (!run) return { done: false, what: 'no run yet' }
  return run.status === 'completed'
    ? { done: true, what: `run ${run.id} ${run.conclusion ?? 'finished'}` }
    : { done: false, what: `run ${run.id} ${run.status}` }
}

/**
 * One item, one decision. The first time it reads finished, doneAt is set; once it has been finished
 * AWAIT_STALE_MS while the child stayed idle with no activity since, the orchestrator is woken, once.
 */
export function decideAwait(a: Await, s: ItemState, bucket: string, childLastActivity: number, now: number): { item: Await; wake?: string } {
  const item: Await = { ...a, checkedAt: now }
  if (s === null) return { item }
  if (!s.done) return { item: { ...item, doneAt: undefined, doneWhat: s.what } }
  item.doneAt = a.doneAt ?? now
  item.doneWhat = s.what
  if (a.woke || !IDLE_BUCKETS.has(bucket)) return { item }
  if (childLastActivity > item.doneAt) return { item } // the child moved after it finished: it knows
  if (now - item.doneAt < AWAIT_STALE_MS) return { item }
  return { item: { ...item, woke: true }, wake: `${label(a)} ${s.what} ${Math.round((now - item.doneAt) / 60_000)}+ min ago, and the child is still ${bucket} ` +
    'with no activity since. Its own watcher did not bring it back: send_message it (priority next) to act on it, or act yourself.' }
}

export function label(a: Await): string {
  return a.kind === 'pr' ? `${a.owner}/${a.repo}#${a.number}` : a.kind === 'run' ? `${a.owner}/${a.repo} ${a.workflow}` : `${a.workflow} (bridge)`
}

/** The dashboard's "waiting on" text for a row. */
export function waitingOn(list: Await[] | undefined): string {
  if (!list?.length) return ''
  return 'waiting on: ' + list.map(a => `${label(a)}${a.doneWhat ? ` (${a.doneWhat})` : a.kind === 'dispatch' ? ' (not checked here)' : ''}`).join('; ')
}
