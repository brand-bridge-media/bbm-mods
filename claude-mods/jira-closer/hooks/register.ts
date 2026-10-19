import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { PendingTicket } from '../types'

// Why this exists (LC-1729): on 2026-10-08 LC-1537 and LC-1551 were put in
// front of Stan as open work weeks after their code shipped. Measured that day:
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
const CREATE_PR = /__create_pull_request$/
const JIRA_TOUCH = /__(transitionJiraIssue|addCommentToJiraIssue|editJiraIssue)$/
const WATCHED = /^mcp__[^_].*__(merge_pull_request|enable_pr_auto_merge|create_pull_request|transitionJiraIssue|addCommentToJiraIssue|editJiraIssue)$/

const pending = atom({ plugin: 'jira-closer', key: 'pending' } as const, [] as PendingTicket[])
const titles = atom({ plugin: 'jira-closer', key: 'titles' } as const, {} as Record<string, string>)

// Callout convention (claude-mods/README.md): prefix for the model, toast for Stan.
function say($: any, text: string): string {
  const msg = `[mod:jira-closer] ${text}`
  $.ui.toast(msg)
  return msg
}

function prId(e: Record<string, unknown>, num?: unknown): string {
  return `${String(e.owner ?? '')}/${String(e.repo ?? '')}#${String(num ?? e.pullNumber ?? e.pull_number ?? '')}`
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

// The PR's own identity: title, head branch and Closes/Fixes/Resolves lines of
// the body. undefined when the text is not a PR object we recognise.
function prFields(text: string): string | undefined {
  try {
    const pr = JSON.parse(text) as { title?: unknown; head?: { ref?: unknown }; body?: unknown }
    if (typeof pr.title !== 'string') return undefined
    const closes = closesLines(String(pr.body ?? ''))
    return `${pr.title} ${String(pr.head?.ref ?? '')} ${closes}`
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
      if (num) await update($, titles, t => ({ ...t, [prId(e, num)]: `${String(e.title ?? '')} ${String(e.head ?? '')} ${closes}` }))
      return ran
    }

    if (MERGE.test(tool)) {
      const id = prId(e)
      let source = (await read($, titles))[id] ?? String(e.commit_title ?? '')
      let unread = false
      if (keysIn(source).length === 0) {
        // A PR opened elsewhere: read its title, branch and Closes/Fixes lines
        // through the same server. Refs: lines are deliberately ignored.
        try {
          const server = tool.split('__')[1] ?? 'github'
          const r = await $.mcp.call(server, 'pull_request_read', {
            method: 'get', owner: e.owner, repo: e.repo, pullNumber: e.pullNumber,
          })
          const text = (r.content ?? []).map(c => textOf((c as { text?: unknown }).text ?? c)).join(' ')
          const pr = prFields(text)
          if (r.isError || pr === undefined) unread = true
          else source = pr
        } catch { unread = true }
      }
      const keys = keysIn(source)
      if (keys.length === 0 && unread) {
        // Could not examine the PR: say so rather than pass silently, and hold
        // the turn's end once until the session touches some Jira ticket.
        const key = `?${id}`
        await update($, pending, list => [...list.filter(p => p.key !== key), { key, pr: id, nagged: false }])
        return {
          ...ran,
          context: [...(ran.context ?? []), say($, `could not read ${id}'s title to find its Jira ticket. ` +
            `Find the ticket it served and transition it to Done or post a state comment.`)],
        }
      }
      if (keys.length === 0) return ran

      await update($, pending, list => [
        ...list.filter(p => !keys.includes(p.key)),
        ...keys.map(key => ({ key, pr: id, nagged: false })),
      ])
      waitingStatus($, await read($, pending))
      return {
        ...ran,
        context: [
          ...(ran.context ?? []),
          say($, `${id} references ${keys.join(', ')}. Before this turn ends, for each: read the ticket's ` +
            `NEWEST comment and its done-criteria, check live state, then either transition it to Done ` +
            `(this PR finished it) or post a one-line state comment (what shipped, what remains).`),
        ],
      }
    }

    if (JIRA_TOUCH.test(tool)) {
      const key = String(e.issueIdOrKey ?? '').toUpperCase()
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
    return {
      block: say($, `merged PR(s) left these Jira tickets untouched: ` +
        due.map(p => `${p.key} (${p.pr})`).join(', ') +
        `. Read each newest comment, then transition to Done or post a state comment.`),
    }
  })
}
