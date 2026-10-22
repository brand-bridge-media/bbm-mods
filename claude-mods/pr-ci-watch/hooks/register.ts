import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Watch } from '../types'
import { decide, findPr, prNumberFrom, parseCheckRuns, parsePr, parsePushes, parseRemote, POLL_MS } from './logic'
import type { Observation, PushCmd } from './logic'

// Why (LC-1896): a session must not depend on GitHub's PR events alone to learn its CI finished.
// Decisions live in ./logic.ts; this file gathers facts (git, GitHub MCP) and acts.

const DEFAULT_SERVER = 'github'
const watches = atom({ plugin: 'pr-ci-watch', key: 'watches' } as const, [] as Watch[])

// Wakes the host refused (submitted from inside a tool call) wait for the turn's end.
const pendingWakes: string[] = []
let ticking = false
let busy = false

function textOf(r: { content?: readonly unknown[] }): string {
  return (r.content ?? []).map(c => String((c as { text?: unknown }).text ?? '')).join('')
}

function flush($: any) {
  if (pendingWakes.length === 0) return
  const lines = pendingWakes.splice(0)
  try { $.ui.toast(lines[0]!.slice(0, 200)) } catch { /* a toast never changes a wake */ }
  Promise.resolve()
    .then(() => $.prompt.submit({ text: lines.join('\n') }))
    .catch(() => { pendingWakes.unshift(...lines) })
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

async function observe($: any, w: Watch): Promise<Observation> {
  const pr = parsePr((await mcp($, w.server, 'pull_request_read', { method: 'get', owner: w.owner, repo: w.repo, pullNumber: w.number })) ?? '')
  if (!pr) return { kind: 'error', detail: 'pull_request_read get unreadable' }
  if (pr.merged || pr.state === 'closed') return { kind: 'pr', ...pr, runs: [] }
  const runs = parseCheckRuns((await mcp($, w.server, 'pull_request_read',
    { method: 'get_check_runs', owner: w.owner, repo: w.repo, pullNumber: w.number, perPage: 100 })) ?? '')
  return { kind: 'pr', ...pr, runs }
}

async function tick($: any) {
  if (busy) return
  busy = true
  try {
    const now = await $.clock.now()
    for (const w of await read($, watches)) {
      const d = decide(w, await observe($, w), now)
      if (d.wake) { pendingWakes.push(d.wake); flush($) }
      const same = (x: Watch) => x.owner === w.owner && x.repo === w.repo && x.number === w.number && x.startedAt === w.startedAt
      await update($, watches, l => (d.done ? l.filter(x => !same(x)) : l.map(x => (same(x) ? { ...x, ...d.patch } : x))))
    }
  } catch { /* a failed tick is retried by the next one */ } finally {
    busy = false
  }
}

/** Adds or replaces the watch for one PR (a new push restarts its clock), and starts the timer. */
async function watch($: any, w: Omit<Watch, 'startedAt'>): Promise<string> {
  const startedAt = await $.clock.now()
  await update($, watches, l => [...l.filter(x => !(x.owner === w.owner && x.repo === w.repo && x.number === w.number)), { ...w, startedAt }])
  if (!ticking) {
    ticking = true
    $.clock.every(POLL_MS, () => { void tick($) })
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
      description: 'Watch an existing PR\'s CI and be woken when it finishes. Pushes and create_pull_request are watched automatically; use this for a PR this session did not just push.',
      inputSchema: {
        type: 'object',
        properties: { owner: { type: 'string' }, repo: { type: 'string' }, pullNumber: { type: 'number' } },
        required: ['owner', 'repo', 'pullNumber'],
      },
    })
    return started
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__pr-ci-watch__watch_pr' }, async ($, e: any) => {
    const number = Number(e.pullNumber)
    if (!e.owner || !e.repo || !Number.isInteger(number)) return { result: '[mod:pr-ci-watch] owner, repo and pullNumber are required.' }
    return { result: await watch($, { owner: String(e.owner), repo: String(e.repo), number, server: DEFAULT_SERVER, sha: '' }) }
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

  on('turn.complete', async ($, e, next) => {
    const res = await next(e)
    flush($)
    return res
  })
}
