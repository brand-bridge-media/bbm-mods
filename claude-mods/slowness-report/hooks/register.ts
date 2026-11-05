import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Clock } from '../types'
import {
  CAUSE_TICKETS, CLOUD_ID, EPIC, OWN, POLL_MS, STAGES, causeTicketFor, clockKey, decide,
  normalisePr, occurrenceBody, operatorAsk, parseCheckRuns, parsePr, prNumberFrom, readReport, timing,
} from './logic'
import type { Observation, Report } from './logic'

// Why (LCH-600): see ./logic.ts. This file starts clocks on PRs, polls them, wakes the session, and writes Jira.

const clocks = atom({ plugin: 'slowness-report', key: 'clocks' } as const, [] as Clock[])
// Set by /slow; the next report is recorded as the operator's.
const operatorAsked = atom({ plugin: 'slowness-report', key: 'operatorAsked' } as const, false)

const JIRA = 'Atlassian'
const pendingWakes: string[] = []
let ticking = false
let busy = false

function textOf(r: { content?: readonly unknown[] }): string {
  return (r.content ?? []).map(c => String((c as { text?: unknown }).text ?? '')).join('')
}

async function mcp($: any, server: string, tool: string, args: Record<string, unknown>): Promise<string | undefined> {
  try {
    const r = await $.mcp.call(server, tool, args)
    return r.isError ? undefined : textOf(r)
  } catch { return undefined }
}

function flush($: any) {
  if (pendingWakes.length === 0) return
  const wakes = pendingWakes.splice(0)
  Promise.resolve()
    .then(async () => {
      try { $.ui.toast(wakes[0]!.slice(0, 200)) } catch { /* a toast never changes a wake */ }
      await $.prompt.submit({ text: wakes.join('\n\n') })
    })
    .catch(() => { pendingWakes.unshift(...wakes) })
}

async function observe($: any, c: Clock): Promise<Observation> {
  const pr = parsePr((await mcp($, c.server, 'pull_request_read', { method: 'get', owner: c.owner, repo: c.repo, pullNumber: c.number })) ?? '')
  if (!pr) return { kind: 'error' }
  if (pr.merged || pr.state === 'closed') return { kind: 'pr', pr }
  const runs = parseCheckRuns((await mcp($, c.server, 'pull_request_read',
    { method: 'get_check_runs', owner: c.owner, repo: c.repo, pullNumber: c.number, perPage: 100 })) ?? '')
  return { kind: 'pr', pr, runs }
}

async function tick($: any) {
  if (busy) return
  busy = true
  try {
    const now = await $.clock.now()
    for (const c of await read($, clocks)) {
      const d = decide(c, await observe($, c), now)
      if (d.wake) { pendingWakes.push(d.wake); flush($) }
      const same = (x: Clock) => clockKey(x) === clockKey(c)
      await update($, clocks, l => (d.done ? l.filter(x => !same(x)) : l.map(x => (same(x) ? { ...x, ...d.patch } : x))))
    }
  } catch { /* a failed tick is retried by the next one */ } finally {
    busy = false
  }
}

async function start($: any, c: Omit<Clock, 'startedAt' | 'nextWake'>, startedAt?: number) {
  const now = await $.clock.now()
  const exists = (await read($, clocks)).some(x => clockKey(x) === clockKey(c))
  // Arming auto-merge on a PR this session already timed keeps the original start: the clock measures change-to-live.
  if (!exists) await update($, clocks, l => [...l, { ...c, startedAt: startedAt ?? now, nextWake: 0 }].slice(-20))
  if (!ticking) {
    ticking = true
    $.clock.every(POLL_MS, () => { void tick($) })
  }
}

async function file($: any, r: Report): Promise<string> {
  const now = await $.clock.now()
  const all = await read($, clocks)
  const first = all[0]
  const key = normalisePr(r.pr, first ? { owner: first.owner, repo: first.repo } : undefined)
  const clock = key ? all.find(c => clockKey(c) === key) : undefined
  const report: Report = { ...r, ...(key ? { pr: key } : {}) }
  const t = timing(report, clock, now)

  if (clock?.reportedTo) {
    return `${OWN} ${key} is already recorded as one occurrence on ${clock.reportedTo}; one PR is one occurrence, so nothing was added.`
  }
  const ticket = causeTicketFor(report)
  const body = occurrenceBody(report, t, now)
  const ok = await mcp($, JIRA, 'addCommentToJiraIssue', { cloudId: CLOUD_ID, issueIdOrKey: ticket, commentBody: body, contentFormat: 'markdown' })
  if (ok === undefined) {
    return `${OWN} Jira did not take the occurrence. Read ${ticket}'s newest comment, then add this as a comment on ${ticket} ` +
      `with addCommentToJiraIssue (cloudId ${CLOUD_ID}; never create a ticket for it):\n${body}`
  }
  if (clock) await update($, clocks, l => l.map(c => (clockKey(c) === clockKey(clock) ? { ...c, reportedTo: ticket } : c)))
  return `${OWN} recorded one occurrence on ${ticket} (https://b-b-m.atlassian.net/browse/${ticket}), the ticket that owns "${report.stage}". ` +
    'Tell the operator in one plain sentence what is stuck, why, and that it was recorded there.'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'report',
      description:
        `Record ONE slowness occurrence as a comment on the ticket that owns its cause (${Object.entries(CAUSE_TICKETS).map(([k, v]) => `${k}=${v}`).join(', ')}); never creates a ticket. ` +
        'Call it when this mod wakes you, when the operator runs /slow, or whenever a change of yours is taking far longer than it should. ' +
        'Measure first: stage and evidence come from check runs, merge-train status and workflow runs, not from memory.',
      inputSchema: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'What was being changed, in plain words (e.g. "record 7 product picks for the family-sofa article").' },
          stage: { type: 'string', enum: [...STAGES], description: 'Where most of the time went.' },
          cause: { type: 'string', description: 'Why, in one or two sentences.' },
          evidence: { type: 'string', description: 'Run ids, check names, queued/started times, minutes per stage.' },
          fix: { type: 'string', description: 'What would stop it recurring (and any ticket that already owns that fix).' },
          cause_ticket: { type: 'string', description: 'Optional: an existing ticket that owns this cause better than the default for the stage (e.g. LC-2076).' },
          pr: { type: 'string', description: 'owner/repo#N (or a PR URL) if a PR is involved; links the report to the mod\'s measured clock.' },
          started_at: { type: 'string', description: 'ISO time the change started, when no PR clock ran.' },
          waited_minutes: { type: 'number' },
          still_waiting: { type: 'boolean' },
        },
        required: ['subject', 'stage', 'cause', 'evidence', 'fix'],
      },
    })
    await $.command.register({ name: 'slow', description: `Something is taking too long: diagnose it and record the cause under ${EPIC}`, argumentHint: '[what is stuck]' })
    return started
  }).catch(($, e, next) => next(e))

  // e carries the tool's arguments flat (same as pr-ci-watch's watch_pr handler reads e.owner / e.pullNumber).
  on('tool.call', { tool: 'mcp__slowness-report__report' }, async ($, e: any) => {
    const fromOperator = await read($, operatorAsked)
    const r = readReport(e as Record<string, unknown>, fromOperator ? 'operator' : 'session')
    if (typeof r === 'string') return { result: r }
    const all = await read($, clocks)
    const woke = all.some(c => c.nextWake > 0 && r.pr && normalisePr(r.pr, { owner: c.owner, repo: c.repo }) === clockKey(c))
    const out = await file($, woke && !fromOperator ? { ...r, source: 'auto' } : r)
    if (fromOperator) await update($, operatorAsked, () => false)
    return { result: out }
  }).catch(() => ({ result: `${OWN} could not record the occurrence; add it yourself as a comment on the cause ticket (never a new ticket).` }))

  on('command.run', { command: 'slow' }, async ($, e) => {
    await update($, operatorAsked, () => true)
    const ask = operatorAsk(e.args)
    pendingWakes.push(ask)
    flush($)
    return { text: `${OWN} diagnosing what is slow; the cause will be recorded on its ticket under ${EPIC}.` }
  })

  // Clocks start where a change enters the pipeline: a new PR, or auto-merge armed on one.
  on('tool.call', { tool: /^mcp__.*__create_pull_request$/ }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const a = e as any
    const number = prNumberFrom(String((ran as any).text ?? JSON.stringify((ran as any).result ?? '')))
    if (!a.owner || !a.repo || number === undefined) return ran
    await start($, { owner: String(a.owner), repo: String(a.repo), number, server: String(a.tool).split('__')[1] ?? 'github' })
    return ran
  // Fail open: a bug here must never change the tool call's outcome.
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: /^mcp__.*__enable_pr_auto_merge$/ }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const a = e as any
    const number = Number(a.pullNumber)
    if (!a.owner || !a.repo || !Number.isInteger(number)) return ran
    const server = String(a.tool).split('__')[1] ?? 'github'
    // A PR opened elsewhere: its real start is its created_at, read once.
    let createdAt: number | undefined
    try {
      const v = JSON.parse((await mcp($, server, 'pull_request_read', { method: 'get', owner: a.owner, repo: a.repo, pullNumber: number })) ?? '')
      const t = Date.parse(v?.created_at)
      if (Number.isFinite(t)) createdAt = t
    } catch { /* unknown: start now */ }
    await start($, { owner: String(a.owner), repo: String(a.repo), number, server }, createdAt)
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const res = await next(e)
    flush($)
    return res
  })
}
