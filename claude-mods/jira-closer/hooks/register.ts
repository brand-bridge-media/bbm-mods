import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { PendingTicket } from '../types'

// Why this exists (LC-1729): on 2026-10-08 LC-1537 and LC-1551 were put in
// front of the operator as open work weeks after their code shipped. Measured that day:
// 34 of the 64 tickets with code merged since Sept 1 were still not Done.
// Closing a ticket was a manual step no session owned; sessions stop at merge.
// So the session that merges a PR now owns its ticket: it is told at merge time
// and held back ONCE at the end of the turn if it skipped it.
//
// Sibling: session-close nudges for a Jira comment at /close-out. This mod is
// the sharper one, tied to the merge itself and asking for Done-or-state.
// Tools are matched by suffix so the MCP server's name does not matter.

const KEY = /\b(LC|LCH|LCC|BBM)-\d+\b/gi
const IS_KEY = /^(LC|LCH|LCC|BBM)-\d+$/
const MERGE = /__(merge_pull_request|enable_pr_auto_merge)$/
// Arming auto-merge still makes this session the ticket's owner (the merge train merges later with
// no tool call to hook), but the PR is NOT merged yet: never ask for Done on it (LC-1884).
const QUEUE = /__enable_pr_auto_merge$/
const CREATE_PR = /__create_pull_request$/
// LC-2203: since the Mergify cutover (LCH-614, 2026-11-10) most PRs never see a merge or an auto-merge
// call. A session hands a finished PR over by marking it ready (or opening it ready); the router labels
// it `route:queue` + `queue` or `route:fast` + `merge-train`, and Mergify or the tick merges it with no
// tool call here. So those hand-offs count as QUEUED too: a ready PR, or a session adding a merge label.
const HANDOFF = /__(update_pull_request|issue_write|update_issue)$/
const MERGE_LABEL = /^(queue|merge-train)$/i
// LC-2118: the v1 Atlassian server (mcp__Atlassian__, removed 2027-03-01) names the comment write
// addCommentToJiraIssue; the v2 server (mcp__Atlassian_MCP__) names it addOrEditJiraIssueComment and carries
// other writes through the executeWrite runner {name, inputs}. Both count as touching the ticket.
const JIRA_TOUCH = /__(transitionJiraIssue|addCommentToJiraIssue|addOrEditJiraIssueComment|editJiraIssue|executeWrite)$/
const WATCHED = /^(mcp__[^_].*__(merge_pull_request|enable_pr_auto_merge|create_pull_request|update_pull_request|issue_write|update_issue|transitionJiraIssue|addCommentToJiraIssue|addOrEditJiraIssueComment|editJiraIssue)|mcp__Atlassian\w*__executeWrite)$/
const RUNNER_TOUCH = /^(transitionJiraIssue|addCommentToJiraIssue|addOrEditJiraIssueComment|editJiraIssue)$/

const pending = atom({ plugin: 'jira-closer', key: 'pending' } as const, [] as PendingTicket[])
const titles = atom({ plugin: 'jira-closer', key: 'titles' } as const, {} as Record<string, string>)

// Callout convention (claude-mods/README.md): prefix for the model, toast for the operator.
function say($: any, text: string): string {
  const msg = `[mod:jira-closer] ${text}`
  $.ui.toast(msg)
  return msg
}

function prNumber(e: Record<string, unknown>): unknown {
  return e.pullNumber ?? e.pull_number ?? e.issue_number ?? e.issueNumber
}

function prId(e: Record<string, unknown>, num?: unknown): string {
  return `${String(e.owner ?? '')}/${String(e.repo ?? '')}#${String(num ?? prNumber(e) ?? '')}`
}

/** How this call hands a PR to the merge queue or the tick, or undefined when it does not (LC-2203). */
function handoff(tool: string, e: Record<string, unknown>): string | undefined {
  if (!HANDOFF.test(tool)) return undefined
  if (/__update_pull_request$/.test(tool) && e.draft === false) return 'marked ready; the router queues it'
  const labels = Array.isArray(e.labels) ? e.labels.map(l => String((l as { name?: unknown })?.name ?? l)) : []
  const hit = labels.find(l => MERGE_LABEL.test(l.trim()))
  return hit ? `\`${hit.trim()}\` label added` : undefined
}

function keysIn(s: string): string[] {
  return [...new Set((s.match(KEY) ?? []).map(k => k.toUpperCase()))]
}

function textOf(v: unknown): string {
  try { return typeof v === 'string' ? v : JSON.stringify(v) } catch { return '' }
}

function closesLines(body: string): string {
  return body.split('\n').filter(l => /\b(closes|fixes|resolves)\b/i.test(l)).join(' ')
}

// LCH-794 (operator decision 2026-11-23): infrastructure breakage is a GitHub issue in
// brand-bridge-media/bbm-health-issues, not a Jira LCH ticket. A PR naming one (`bbm-health-issues#N`, its URL,
// or `Fixes brand-bridge-media/bbm-health-issues#N`) is closed out on GitHub, never through a Jira close.
const HEALTH = /\b(?:https?:\/\/github\.com\/brand-bridge-media\/bbm-health-issues\/issues\/|bbm-health-issues#)(\d{1,6})\b/gi

function healthRefs(s: string): string {
  return [...new Set([...s.matchAll(HEALTH)].map(m => `bbm-health-issues#${m[1]}`))].join(' ')
}

// The PR's own identity: title, head branch and Closes/Fixes/Resolves lines of
// the body. undefined when the text is not a PR object we recognise.
function prFields(text: string): string | undefined {
  try {
    const pr = JSON.parse(text) as { title?: unknown; head?: { ref?: unknown }; body?: unknown }
    if (typeof pr.title !== 'string') return undefined
    const closes = closesLines(String(pr.body ?? ''))
    return `${pr.title} ${String(pr.head?.ref ?? '')} ${closes} ${healthRefs(String(pr.body ?? ''))}`
  } catch { return undefined }
}

function waitingStatus($: any, list: PendingTicket[]): void {
  $.ui.status(list.length ? `jira-closer: ${list.map(p => p.key).join(', ')} awaiting update` : undefined)
}

export const register: Register = on => {
  on('tool.call', { tool: WATCHED }, async ($, ev, next) => {
    const e = ev as unknown as Record<string, unknown>
    const tool = String(e.tool)
    const ran = await next(ev)
    if (ran.deny !== undefined || ran.isError) return ran

    // Remember titles of PRs this session opens, so their merge needs no fetch.
    if (CREATE_PR.test(tool)) {
      const m = textOf(ran.result).match(/"number"\s*:\s*(\d+)|\/pull\/(\d+)/)
      const num = m?.[1] ?? m?.[2]
      const closes = closesLines(String(e.body ?? ''))
      if (num) await update($, titles, t => ({ ...t, [prId(e, num)]: `${String(e.title ?? '')} ${String(e.head ?? '')} ${closes} ${healthRefs(String(e.body ?? ''))}` }))
      return ran
    }

    const handedOff = handoff(tool, e)
    if (MERGE.test(tool) || handedOff) {
      const id = prId(e)
      const queued = QUEUE.test(tool) || handedOff !== undefined
      const how = handedOff ?? 'auto-merge armed'
      let source = (await read($, titles))[id] ?? String(e.commit_title ?? '')
      let unread = false
      if (keysIn(source).length === 0) {
        // A PR opened elsewhere: read its title, branch and Closes/Fixes lines
        // through the same server. Refs: lines are deliberately ignored.
        try {
          const server = tool.split('__')[1] ?? 'github'
          const r = await $.mcp.call(server, 'pull_request_read', {
            method: 'get', owner: e.owner, repo: e.repo, pullNumber: Number(prNumber(e)),
          })
          const text = (r.content ?? []).map(c => textOf((c as { text?: unknown }).text ?? c)).join(' ')
          const pr = prFields(text)
          if (r.isError || pr === undefined) unread = true
          else source = `${pr} ${healthRefs(source)}`
        } catch { unread = true }
      }
      const keys = keysIn(source)
      if (keys.length === 0 && unread) {
        // Could not examine the PR: say so rather than pass silently, and hold
        // the turn's end once until the session touches some Jira ticket.
        const key = `?${id}`
        await update($, pending, list => [...list.filter(p => p.key !== key), { key, pr: id, nagged: false, queued }])
        return {
          ...ran,
          context: [...(ran.context ?? []), say($, `could not read ${id}'s title to find its Jira ticket. ` +
            `Find the ticket it served and transition it to Done or post a state comment.`)],
        }
      }
      const health = healthRefs(source)
      const healthSay = health
        ? [say($, `${id} references ${health}: a GitHub issue in brand-bridge-media/bbm-health-issues, not a Jira ticket, ` +
            `so this project verifies and closes the GitHub issue (read it and its newest comment, check live state, then close it ` +
            `with the evidence${queued ? ' once the merge lands' : ''}); do not transition or comment on Jira for it.`)]
        : []
      if (keys.length === 0) return healthSay.length ? { ...ran, context: [...(ran.context ?? []), ...healthSay] } : ran

      await update($, pending, list => [
        ...list.filter(p => !keys.includes(p.key)),
        ...keys.map(key => ({ key, pr: id, nagged: false, queued })),
      ])
      waitingStatus($, await read($, pending))
      const ask = queued
        ? `${id} is QUEUED to merge (${how}), not merged, and references ${keys.join(', ')}. Before ` +
          `this turn ends, post a one-line state comment on each (PR ready and queued, what remains). ` +
          `Do not transition to Done until the merge lands: the queue can still evict the PR.`
        : `${id} references ${keys.join(', ')}. Before this turn ends, for each: read the ticket's ` +
          `NEWEST comment and its done-criteria, check live state, then either transition it to Done ` +
          `(this PR finished it) or post a one-line state comment (what shipped, what remains).`
      return { ...ran, context: [...(ran.context ?? []), say($, ask), ...healthSay] }
    }

    if (JIRA_TOUCH.test(tool)) {
      // The v2 runner nests the call: executeWrite {name, inputs: {issueIdOrKey}}. Only the ticket-touching
      // operations count; any other runner operation settles nothing.
      const inputs = (e.inputs ?? {}) as Record<string, unknown>
      const viaRunner = /__executeWrite$/.test(tool)
      if (viaRunner && !RUNNER_TOUCH.test(String(e.name ?? ''))) return ran
      const key = String((viaRunner ? inputs.issueIdOrKey : e.issueIdOrKey) ?? '').toUpperCase()
      // A touch on a real ticket also settles a PR whose ticket could not be
      // read; a touch naming no ticket settles nothing.
      if (!IS_KEY.test(key)) return ran
      await update($, pending, list => list.filter(p => p.key !== key && !p.key.startsWith('?')))
      waitingStatus($, await read($, pending))
    }
    return ran
  })

  // Once per ticket, so a ticket the session judges should stay as-is cannot
  // trap it in a loop: the second Stop always goes through.
  on('classic.Stop', async ($, e, next) => {
    const due = (await read($, pending)).filter(p => !p.nagged)
    if (due.length === 0) return next(e)
    await update($, pending, l => l.map(p => ({ ...p, nagged: true })))
    const list = (ps: PendingTicket[]) => ps.map(p => `${p.key} (${p.pr})`).join(', ')
    const merged = due.filter(p => !p.queued)
    const queued = due.filter(p => p.queued)
    const parts = [
      merged.length ? `merged PR(s) left these Jira tickets untouched: ${list(merged)}. Read each newest ` +
        `comment, then transition to Done or post a state comment.` : '',
      queued.length ? `PR(s) queued to merge (NOT merged yet) left these Jira tickets ` +
        `untouched: ${list(queued)}. Post a state comment on each; Done only after the merge lands.` : '',
    ]
    return { block: say($, parts.filter(Boolean).join(' ')) }
  })
}
