// Pure decisions for pr-ci-watch. register.ts gathers facts (git, GitHub MCP) and acts on these.
//
// Why (LC-1896, 2026-10-22): PR #2041's required review failed at 17:33Z and the session that
// owned it sat idle until the operator asked. GitHub's PR events never reached it (the Claude
// App could not see the repo under its pre-move name) and its fallback check-in was 50 minutes
// out for a CI that finishes in 4. The platform also lists gaps where events never arrive even
// when they work. This mod watches CI itself after a push, the way dispatch-watch watches a run.

import type { Watch } from '../types'

export const POLL_MS = 2 * 60_000
export const NO_CHECKS_MS = 15 * 60_000 // nothing registered by now: a workflow did not trigger
export const LONG_MS = 60 * 60_000
export const ADOPT_HEAD_MS = 10 * 60_000 // the PR still shows another head: watch whatever it shows
export const MAX_ERRORS = 5

export type CheckRun = { name: string; status: string; conclusion: string | null }

export type Observation =
  | { kind: 'pr'; state: string; merged: boolean; headSha: string; runs: CheckRun[] | undefined }
  | { kind: 'error'; detail: string }

export type Decision = { done: boolean; wake?: string; patch?: Partial<Watch> }

const BAD = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale'])
// Only these read as a pass. neutral, null or anything unrecognised is never reported as green.
const GOOD = new Set(['success', 'skipped'])

// ------------------------------------------------------------------ recognising a push

export type PushCmd = { dir?: string; remote?: string; src?: string; branch?: string }

/** Words of one simple command, quotes removed. Enough to find `git push`; anything stranger is not watched. */
function words(cmd: string): string[] {
  return (cmd.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map(w => w.replace(/^['"]|['"]$/g, ''))
}

/**
 * The pushes in a Bash command. A false positive costs one PR lookup; a miss leaves the session
 * where it is today (events or a check-in), so this stays deliberately small.
 */
export function parsePushes(command: string): PushCmd[] {
  const out: PushCmd[] = []
  let cdDir: string | undefined
  for (const part of command.split(/&&|\|\||;|\n/)) {
    const w = words(part.trim())
    if (w[0] === 'cd' && w[1]) { cdDir = w[1]; continue }
    const g = w.indexOf('git')
    if (g < 0) continue
    let i = g + 1
    let dir = cdDir
    for (; i < w.length; i++) {
      if (w[i] === '-C' && w[i + 1]) dir = w[++i]
      else if (w[i] === '-c' && w[i + 1]) i++
      else if (!w[i]!.startsWith('-')) break
    }
    if (w[i] !== 'push') continue
    const rest = w.slice(i + 1)
    if (rest.some(t => t === '--dry-run' || t === '-n' || t === '--delete' || t === '-d' || t === '--tags')) continue
    const pos = rest.filter(t => !t.startsWith('-'))
    const spec = (pos[1] ?? '').replace(/^\+/, '')
    if (spec.startsWith(':')) continue // deletes a branch
    const [src, dst] = spec.includes(':') ? spec.split(':', 2) as [string, string] : [spec, spec]
    const branch = dst && dst !== 'HEAD' ? dst.replace(/^refs\/heads\//, '') : undefined
    out.push({ dir, remote: pos[0], src: src || undefined, branch })
  }
  return out
}

/** owner/repo from a remote URL (https, ssh, or a proxy path ending in owner/repo). */
export function parseRemote(url: string): { owner: string; repo: string } | undefined {
  const m = url.trim().match(/[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/)
  return m ? { owner: m[1]!, repo: m[2]! } : undefined
}

// ------------------------------------------------------------------ reading MCP results

function json(text: string): unknown {
  try { return JSON.parse(text) } catch { return undefined }
}

/** The open PR whose head branch is `branch`, from list_pull_requests text. */
export function findPr(text: string, branch: string): number | undefined {
  const v = json(text)
  if (!Array.isArray(v)) return undefined
  const hit = v.find(p => p && typeof p === 'object' && (p as any).head?.ref === branch && (p as any).state !== 'closed')
  return hit && typeof (hit as any).number === 'number' ? (hit as any).number : undefined
}

/**
 * The new PR's number from a create_pull_request result: the JSON `number` field, else the LAST
 * /pull/N URL (the PR's own url comes after any URL quoted in the title or body).
 */
export function prNumberFrom(text: string): number | undefined {
  const v = json(text) as any
  if (v && typeof v === 'object' && Number.isInteger(v.number)) return v.number
  const all = [...text.matchAll(/\/pull\/(\d+)/g)]
  return all.length ? Number(all[all.length - 1]![1]) : undefined
}

/** state, merged and head sha from pull_request_read get text. */
export function parsePr(text: string): { state: string; merged: boolean; headSha: string } | undefined {
  const v = json(text) as any
  if (!v || typeof v !== 'object' || typeof v.head?.sha !== 'string') return undefined
  return { state: String(v.state ?? ''), merged: v.merged === true || typeof v.merged_at === 'string', headSha: v.head.sha }
}

/** get_check_runs text. undefined = not readable as a list of runs. */
export function parseCheckRuns(text: string): CheckRun[] | undefined {
  const v = json(text)
  const list = Array.isArray(v) ? v : (v && typeof v === 'object' ? (v as { check_runs?: unknown }).check_runs : undefined)
  if (!Array.isArray(list)) return undefined
  const out: CheckRun[] = []
  for (const r of list) {
    if (!r || typeof r !== 'object' || typeof (r as any).name !== 'string' || typeof (r as any).status !== 'string') return undefined
    out.push({ name: (r as any).name, status: (r as any).status.toLowerCase(),
      conclusion: typeof (r as any).conclusion === 'string' ? (r as any).conclusion.toLowerCase() : null })
  }
  return out
}

// ------------------------------------------------------------------ the decision

const label = (w: Watch) => `${w.owner}/${w.repo}#${w.number}`
const short = (sha: string) => sha.slice(0, 7)
const list = (rs: CheckRun[]) => rs.slice(0, 6).map(r => `${r.name} (${r.conclusion})`).join('; ') + (rs.length > 6 ? `; +${rs.length - 6} more` : '')

export function decide(w: Watch, o: Observation, now: number): Decision {
  const P = `[mod:pr-ci-watch] ${label(w)}`
  if (o.kind === 'error') {
    const errors = (w.errors ?? 0) + 1
    if (errors < MAX_ERRORS) return { done: false, patch: { errors } }
    return { done: true, wake: `${P}: could not read the PR or its checks ${errors} times in a row (${o.detail}); stopped watching. Check its CI yourself now.` }
  }
  if (o.merged) return { done: true, wake: `${P} merged. Do what the merge calls for (Jira, mirror, follow-ups).` }
  if (o.state === 'closed') return { done: true, wake: `${P} was closed without merging.` }

  const base: Partial<Watch> = { errors: 0 }
  // Right after a push the PR can still show the previous head, whose finished runs would read as done.
  // A watch made from create_pull_request or watch_pr has no pushed sha: it takes the PR's head.
  if (!w.sha) {
    base.sha = o.headSha
  } else if (o.headSha !== w.sha) {
    if (now - w.startedAt < ADOPT_HEAD_MS) return { done: false, patch: base }
    base.sha = o.headSha // someone else pushed, or the push never landed: watch what the PR shows
    base.lastSig = undefined
  }
  const sha = base.sha ?? w.sha
  const runs = o.runs
  // Unreadable check runs are a read error, never a quiet wait: otherwise the session could idle forever.
  if (runs === undefined) {
    const errors = (w.errors ?? 0) + 1
    if (errors < MAX_ERRORS) return { done: false, patch: { ...base, errors } }
    return { done: true, wake: `${P}: could not read the check runs ${errors} times in a row; stopped watching. Check its CI yourself now.` }
  }

  if (runs.length === 0) {
    if (!w.warnedNone && now - w.startedAt >= NO_CHECKS_MS) {
      return { done: false, patch: { ...base, warnedNone: true },
        wake: `${P}: no checks have registered on ${short(sha)} after ${Math.round((now - w.startedAt) / 60_000)} min. A workflow may not have triggered; look at the PR's Actions.` }
    }
    return { done: false, patch: base }
  }

  const running = runs.filter(r => r.status !== 'completed')
  if (running.length > 0) {
    const patch = { ...base, lastSig: undefined }
    if (!w.warnedLong && now - w.startedAt >= LONG_MS) {
      return { done: false, patch: { ...patch, warnedLong: true },
        wake: `${P}: CI on ${short(sha)} is still running after ${Math.round((now - w.startedAt) / 60_000)} min (${running.slice(0, 4).map(r => r.name).join(', ')}). A queued job may be waiting on a busy runner; check before assuming it is dead.` }
    }
    return { done: false, patch }
  }

  // Everything finished. Wait for the same picture twice: a slow workflow can still register a run.
  const sig = `${sha}|` + runs.map(r => `${r.name}=${r.conclusion}`).sort().join(',')
  if (w.lastSig !== sig) return { done: false, patch: { ...base, lastSig: sig } }

  const bad = runs.filter(r => r.conclusion !== null && BAD.has(r.conclusion))
  if (bad.length > 0) {
    return { done: true, wake: `${P}: CI finished on ${short(sha)}: ${bad.length} of ${runs.length} checks failed: ${list(bad)}. ` +
      'This PR is yours to drive: read the failure (delegate the log), fix and push.' }
  }
  const unclear = runs.filter(r => r.conclusion === null || !GOOD.has(r.conclusion))
  if (unclear.length > 0) {
    return { done: true, wake: `${P}: CI finished on ${short(sha)} but ${unclear.length} of ${runs.length} checks did not clearly pass: ` +
      `${list(unclear)}. Read them before treating the PR as green.` }
  }
  return { done: true, wake: `${P}: CI finished on ${short(sha)}: all ${runs.length} checks passed. Do what the PR needs next (review threads, ready-for-review, auto-merge).` }
}
