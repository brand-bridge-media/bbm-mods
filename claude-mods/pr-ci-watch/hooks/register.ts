import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Watch } from '../types'
import { decide, findPr, mergeFactsDue, prNumberFrom, parseCheckRuns, parsePr, parsePushes, parseRemote, parseTrainComment, parseTrainStatus, POLL_MS, splitMergify, stampWake, watchKey } from './logic'
import type { Observation, PushCmd, Wake } from './logic'

// Why (LC-1896): a session must not depend on GitHub's PR events alone to learn its CI finished.
// Decisions live in ./logic.ts; this file gathers facts (git, GitHub MCP) and acts.

const DEFAULT_SERVER = 'github'
const watches = atom({ plugin: 'pr-ci-watch', key: 'watches' } as const, [] as Watch[])
// Keys of watches that ended (merged, closed, failed, gave up): unwatched-job-guard reads them via `watching`.
const finished = atom({ plugin: 'pr-ci-watch', key: 'finished' } as const, [] as string[])

// Wakes the host refused (submitted from inside a tool call) wait for the turn's end.
const pendingWakes: Wake[] = []
let ticking = false
let busy = false

function textOf(r: { content?: readonly unknown[] }): string {
  return (r.content ?? []).map(c => String((c as { text?: unknown }).text ?? '')).join('')
}

function flush($: any) {
  if (pendingWakes.length === 0) return
  const wakes = pendingWakes.splice(0)
  // LC-2043: stamp each line with its real event time and how late it arrives, at the moment of delivery.
  Promise.resolve()
    .then(async () => {
      const now = await $.clock.now()
      const lines = wakes.map(w => stampWake(w, now))
      try { $.ui.toast(lines[0]!.slice(0, 200)) } catch { /* a toast never changes a wake */ }
      await $.prompt.submit({ text: lines.join('\n') })
    })
    .catch(() => { pendingWakes.unshift(...wakes) })
}

async function mcp($: any, server: string, tool: string, args: Record<string, unknown>): Promise<string | undefined> {
  try {
    const r = await $.mcp.call(server, tool, args)
    return r.isError ? undefined : textOf(r)
  } catch { return undefined }
}

async function git($: any, args: string[]): Promise<string | undefined> {
  try {
    const r = await $.process.run(['git', ...args], { timeoutMs: 10_000 })
    const out = String(r.stdout ?? '').trim()
    return r.exitCode === 0 && out ? out : undefined
  } catch { return undefined }
}

async function observe($: any, w: Watch, now: number): Promise<Observation> {
  const pr = parsePr((await mcp($, w.server, 'pull_request_read', { method: 'get', owner: w.owner, repo: w.repo, pullNumber: w.number })) ?? '')
  if (!pr) return { kind: 'error', detail: 'pull_request_read get unreadable' }
  if (pr.merged || pr.state === 'closed') return { kind: 'pr', ...pr, runs: [] }
  const all = parseCheckRuns((await mcp($, w.server, 'pull_request_read',
    { method: 'get_check_runs', owner: w.owner, repo: w.repo, pullNumber: w.number, perPage: 100 })) ?? '')
  // LCH-614: Mergify's own checks are queue state, not CI (see splitMergify).
  const split = all ? splitMergify(all) : undefined
  const runs = split?.ci
  const queue = split?.queue
  const queueFacts = queue ? { queue } : {}
  if (!mergeFactsDue(w, now) || pr.headSha !== w.sha) return { kind: 'pr', ...pr, runs, ...queueFacts }
  // A stuck wake is due: read why the queue has not taken it (best effort; missing facts say "unknown").
  const raw = (await mcp($, w.server, 'pull_request_read', { method: 'get', owner: w.owner, repo: w.repo, pullNumber: w.number })) ?? ''
  let mergeableState: string | undefined
  try { mergeableState = JSON.parse(raw)?.mergeable_state } catch { /* unknown */ }
  const status = parseTrainStatus((await mcp($, w.server, 'pull_request_read', { method: 'get_status', owner: w.owner, repo: w.repo, pullNumber: w.number })) ?? '')
  const trainRun = (runs ?? []).find(r => r.name === 'merge-train' && r.status === 'completed')
  const train = status ?? (trainRun ? { state: trainRun.conclusion ?? 'unknown' } : undefined)
  const trainComment = parseTrainComment((await mcp($, w.server, 'pull_request_read', { method: 'get_comments', owner: w.owner, repo: w.repo, pullNumber: w.number, perPage: 100 })) ?? '')
  return { kind: 'pr', ...pr, runs, ...queueFacts, merge: { mergeableState, train, trainComment, ...queueFacts } }
}

async function tick($: any) {
  if (busy) return
  busy = true
  try {
    const now = await $.clock.now()
    for (const w of await read($, watches)) {
      const d = decide(w, await observe($, w, now), now)
      if (d.wake) { pendingWakes.push({ text: d.wake, at: d.eventAt ?? now }); flush($) }
      const same = (x: Watch) => x.owner === w.owner && x.repo === w.repo && x.number === w.number && x.startedAt === w.startedAt
      await update($, watches, l => (d.done ? l.filter(x => !same(x)) : l.map(x => (same(x) ? { ...x, ...d.patch } : x))))
      if (d.done) await update($, finished, l => [...l.filter(k => k !== watchKey(w)), watchKey(w)].slice(-50))
    }
  } catch { /* a failed tick is retried by the next one */ } finally {
    busy = false
  }
}

/** Adds or replaces the watch for one PR (a new push restarts its clock), and starts the timer. */
async function watch($: any, w: Omit<Watch, 'startedAt'>): Promise<string> {
  const startedAt = await $.clock.now()
  const samePr = (x: Watch) => x.owner === w.owner && x.repo === w.repo && x.number === w.number
  // A push to an armed PR keeps it armed: auto-merge survives a push on GitHub, so the watch must too.
  const armed = !!w.armed || (await read($, watches)).some(x => samePr(x) && x.armed)
  await update($, watches, l => [...l.filter(x => !samePr(x)), { ...w, armed: armed || undefined, startedAt }])
  await update($, finished, l => l.filter(k => k !== watchKey(w)))
  if (!ticking) {
    ticking = true
    $.clock.every(POLL_MS, () => { void tick($) })
  }
  if (armed) {
    return `[mod:pr-ci-watch] Watching ${w.owner}/${w.repo}#${w.number} until it merges: checked every 2 minutes; this session is ` +
      'woken when it merges, when CI fails, or if it is green but not merged within 30 minutes (with the reason). No check-in needed for it.'
  }
  return `[mod:pr-ci-watch] Watching CI on ${w.owner}/${w.repo}#${w.number}: checked every 2 minutes; this session is ` +
    'woken when it finishes (or registers nothing, or runs past an hour). No check-in needed for it.'
}

async function fromPush($: any, p: PushCmd): Promise<string | undefined> {
  const at = p.dir ? ['-C', p.dir] : []
  const remote = parseRemote((await git($, [...at, 'remote', 'get-url', p.remote ?? 'origin'])) ?? '')
  if (!remote) return undefined
  const branch = p.branch ?? (await git($, [...at, 'rev-parse', '--abbrev-ref', 'HEAD']))
  const sha = await git($, [...at, 'rev-parse', p.src ?? 'HEAD'])
  if (!branch || branch === 'HEAD' || !sha) return undefined
  const number = findPr((await mcp($, DEFAULT_SERVER, 'list_pull_requests',
    { ...remote, state: 'open', perPage: 100, fields: ['number', 'head', 'state'] })) ?? '', branch)
  if (number === undefined) return undefined // no PR yet: create_pull_request starts the watch
  return watch($, { ...remote, number, server: DEFAULT_SERVER, sha })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'watch_pr',
      description: 'Watch an existing PR\'s CI and be woken when it finishes. Pushes, create_pull_request and enable_pr_auto_merge are watched automatically; use this for a PR this session did not just push. armed: true = auto-merge is on, keep watching until it merges.',
      inputSchema: {
        type: 'object',
        properties: { owner: { type: 'string' }, repo: { type: 'string' }, pullNumber: { type: 'number' }, armed: { type: 'boolean' } },
        required: ['owner', 'repo', 'pullNumber'],
      },
    })
    await $.tool.register({
      name: 'watching',
      description: 'What pr-ci-watch is watching now and which watches ended (JSON {active, finished} of pr:owner/repo#N keys). Read by unwatched-job-guard.',
      inputSchema: { type: 'object', properties: {} },
    })
    return started
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__pr-ci-watch__watch_pr' }, async ($, e: any) => {
    const number = Number(e.pullNumber)
    if (!e.owner || !e.repo || !Number.isInteger(number)) return { result: '[mod:pr-ci-watch] owner, repo and pullNumber are required.' }
    return { result: await watch($, { owner: String(e.owner), repo: String(e.repo), number, server: DEFAULT_SERVER, sha: '', armed: e.armed === true || undefined }) }
  }).catch(() => ({ result: '[mod:pr-ci-watch] could not start the watch; check the PR\'s CI yourself.' }))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const command = String((e as { command?: unknown }).command ?? '')
    if (!/\bpush\b/.test(command)) return ran
    const notes: string[] = []
    for (const p of parsePushes(command)) {
      const note = await fromPush($, p)
      if (note && !notes.includes(note)) notes.push(note)
    }
    return notes.length ? { ...ran, context: [...(ran.context ?? []), ...notes] } : ran
  // Fail open: a bug here must never change the push's outcome.
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: /^mcp__.*__create_pull_request$/ }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const text = String((ran as any).text ?? JSON.stringify((ran as any).result ?? ''))
    const a = e as any
    if (!a.owner || !a.repo) return ran
    const number = prNumberFrom(text)
    if (number === undefined) return ran
    const server = String(a.tool).split('__')[1] ?? DEFAULT_SERVER
    const note = await watch($, { owner: String(a.owner), repo: String(a.repo), number, server, sha: '' })
    return { ...ran, context: [...(ran.context ?? []), note] }
  }).catch(($, e, next) => next(e))

  // LC-1975 (fix 2): arming auto-merge hands a tier-0 PR to GitHub (tier 1+ uses the `queue` label, below); keep watching until it merges.
  on('tool.call', { tool: /^mcp__.*__enable_pr_auto_merge$/ }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const a = e as any
    const number = Number(a.pullNumber)
    if (!a.owner || !a.repo || !Number.isInteger(number)) return ran
    const server = String(a.tool).split('__')[1] ?? DEFAULT_SERVER
    const prior = (await read($, watches)).find(x => x.owner === a.owner && x.repo === a.repo && x.number === number)
    // Already watching this head: arm it in place so a green picture already seen is not thrown away.
    if (prior) {
      await update($, watches, l => l.map(x => (x === prior || (x.owner === prior.owner && x.repo === prior.repo && x.number === prior.number) ? { ...x, armed: true } : x)))
      return { ...ran, context: [...(ran.context ?? []), `[mod:pr-ci-watch] ${a.owner}/${a.repo}#${number} is armed: watching it until it merges; ` +
        'woken on merge, on a CI failure, or if green but not merged within 30 minutes (with the reason). No check-in needed.'] }
    }
    const note = await watch($, { owner: String(a.owner), repo: String(a.repo), number, server, sha: '', armed: true })
    return { ...ran, context: [...(ran.context ?? []), note] }
  }).catch(($, e, next) => next(e))

  // LCH-614: the `queue` label is how a PR enters the Mergify merge queue (it replaced arming auto-merge for tier 1+).
  // Adding it hands the PR to the queue exactly as arming did for the train: keep watching until it merges.
  on('tool.call', { tool: /^mcp__.*__issue_write$/ }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const a = e as any
    const number = Number(a.issue_number)
    const labels: unknown = a.labels
    if (!a.owner || !a.repo || !Number.isInteger(number) || !Array.isArray(labels) || !labels.includes('queue')) return ran
    const server = String(a.tool).split('__')[1] ?? DEFAULT_SERVER
    const prior = (await read($, watches)).find(x => x.owner === a.owner && x.repo === a.repo && x.number === number)
    if (prior) {
      await update($, watches, l => l.map(x => (x.owner === prior.owner && x.repo === prior.repo && x.number === prior.number ? { ...x, armed: true } : x)))
      return { ...ran, context: [...(ran.context ?? []), `[mod:pr-ci-watch] ${a.owner}/${a.repo}#${number} carries the queue label: watching it until it merges; ` +
        'woken on merge, on a CI failure, a dequeue, or if green but not merged within 30 minutes (with the reason).'] }
    }
    const note = await watch($, { owner: String(a.owner), repo: String(a.repo), number, server, sha: '', armed: true })
    return { ...ran, context: [...(ran.context ?? []), note] }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__pr-ci-watch__watching' }, async $ => {
    const active = (await read($, watches)).map(watchKey)
    return { result: JSON.stringify({ active, finished: (await read($, finished)).filter(k => !active.includes(k)) }) }
  }).catch(() => ({ result: '{"error":"pr-ci-watch could not read its watches"}' }))

  on('turn.complete', async ($, e, next) => {
    const res = await next(e)
    flush($)
    return res
  })
}
