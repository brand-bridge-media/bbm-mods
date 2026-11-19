import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Row } from '../types'
import type { HookOut } from './py'
import { blockReason, contextOf, decisionOf, parseOut, resultText, runArgs, toastText, toolPayload } from './py'

// Why (LC-2207, operator decision 2026-11-17): every change to how code is tested, merged or deployed is
// reviewed by LCH-600 (Deploy and CI speed) before a session opens its PR. The trigger is the files a PR
// changes, not the project the session runs in, so stray chats are covered too. Since LC-2265 (operator
// decision 2026-11-19) the review is a request on the cross-track request board (LC-2257), not a Jira comment
// exchange. A PreToolUse hook gets no transcript, so this mod records the calls its checks need and hands them
// over as transcript rows. A PR taken out of draft is checked too (the PR's head, title, body and files are read
// through the GitHub connector, so it works without a local clone). Logic, rules and selftest:
// ./lch600-review-gate.py, ./plan_stage.py, ./paths.json.
// What is kept (never other SQL or messages):
//  * PR stage: an execute_sql result that shows a ci-speed board row (the closed request the PR line names);
//  * plan stage (LCH-744): the call that posts a plan (execute_sql calling ask_track('ci-speed', ...), or a
//    PLAN: send_message to the desk), the read of the desk's answer (track_request_messages), and a Jira comment
//    write, for the urgent `Skipping LCH-600 review:` escape (the one Jira path LC-2265 kept).
const SQL = /^mcp__Supabase\w*__execute_sql$/
const SEND = /^mcp__claude-code-remote__send_message$/
const PLAN_POST = /ask_track\s*\(\s*'ci-speed'|PLAN:|track_request_messages/i
const BOARD_READ = /\btrack_requests\b/i
const COMMENT = /^mcp__Atlassian\w*__(addCommentToJiraIssue|addOrEditJiraIssueComment)$/
const RUNNER = /^mcp__Atlassian\w*__executeWrite$/
const RUNNER_COMMENT = /"name":"(addCommentToJiraIssue|addOrEditJiraIssueComment)"/
const RECORD_ANY = /^mcp__(Supabase\w*__execute_sql|claude-code-remote__send_message|Atlassian\w*__(addCommentToJiraIssue|addOrEditJiraIssueComment|executeWrite))$/
const EDIT = /^(Write|Edit|MultiEdit|NotebookEdit)$/
// A cheap pre-filter so ordinary edits never start Python: a path that could match ANY repo's gate list in
// paths.json. Over-matching is fine (plan_stage.py decides); a gate pattern outside this list would be missed,
// so the test pins every pattern in paths.json against it.
export const MAYBE_GATED = /(^|\/)(\.github\/|\.trunk\/|\.mergify\.yml$|scripts\/ci\/|scripts\/run_selftests\.sh$|scripts\/quality\/|infra\/|wrangler\.toml$|supabase\/(config\.toml|github_schedules\.json)$|\.claude\/settings\.json$|claude-mods\/|review_policy\.json$|REVIEWER-CHARTER\.md$|budget_gate\.py$)/
const MAX_ROWS = 200
const MAX_TEXT = 100_000
const rows = atom({ plugin: 'lch600-review-gate', key: 'rows' } as const, [] as Row[])
// Shadow mode notes the plan ask once per session, not on every edit.
const planTold = atom({ plugin: 'lch600-review-gate', key: 'planTold' } as const, false)
// LC-2207 (found opening PR #3849): $.state does not survive a container restart. The record is saved to
// $.store (which outlives $.state) with this session's id, and read back when the live list is empty. Since
// LC-2265 one fresh read of the board row also restores the PR-stage evidence.
const STORE_KEY = 'rows'

// '' when the id cannot be read; an empty id never matches a save.
async function sessionIdOf($: any): Promise<string> {
  try { return String((await $.session.id()) ?? '') } catch { return '' }
}

// The live record, or this session's saved one after a restart. `ok` is false when the store could not be read,
// so the writer keeps the last good save instead of overwriting it with a list that lost the request (LCH-600 on
// LC-2242, item 2). Only rows shaped like transcript rows come back: a damaged store must not loosen the gate,
// since the check fails open on bad input (item 3). One key holds one session's save, so two sessions sharing
// a store overwrite each other (item 1; same as pr-ci-watch): the cost is the old false would-deny, never a pass.
async function recorded($: any): Promise<{ list: Row[]; ok: boolean }> {
  const live = await read($, rows)
  if (live.length > 0) return { list: live, ok: true }
  try {
    const sessionId = await sessionIdOf($)
    const saved: any = sessionId ? await $.store.get(STORE_KEY) : undefined
    if (saved && saved.sessionId === sessionId && Array.isArray(saved.rows)) {
      return { list: saved.rows.filter((r: any) => !!r && typeof r === 'object' && typeof r.type === 'string'
        && !!r.message && typeof r.message === 'object') as Row[], ok: true }
    }
    return { list: live, ok: true }
  } catch {
    return { list: live, ok: false }
  }
}

async function persist($: any, list: Row[]): Promise<void> {
  try {
    const sessionId = await sessionIdOf($)
    if (sessionId) await $.store.set(STORE_KEY, { sessionId, rows: list })
  } catch { /* saving is a convenience: the live record still works */ }
}

// --- $ helpers. They live in this file because the plugin validator follows $ only into functions
// declared in the hook's own file (claude-code 2.1.292); ./py.ts stays pure.
async function runCheck($: any, script: string, payload: unknown): Promise<HookOut | undefined> {
  try {
    const { argv, init } = runArgs($.plugin.root, script, payload)
    return parseOut(await $.process.run(argv, init))
  } catch {
    return undefined
  }
}

function toast($: any, text: string): void {
  try { $.ui.toast(toastText(text)) } catch { /* a toast never changes a verdict */ }
}

// Deny and ask are toasted for the operator; a warning is not.
function preToolUse($: any, v: HookOut | undefined) {
  const d = decisionOf(v)
  if (d && 'deny' in d) toast($, d.deny)
  if (d && 'ask' in d) toast($, d.ask)
  return d
}

function blockOf($: any, v: HookOut | undefined): string | undefined {
  const r = blockReason(v)
  if (r) toast($, r)
  return r
}

function textOf(r: { content?: readonly unknown[] }): string {
  return (r?.content ?? []).map(c => String((c as { text?: unknown }).text ?? '')).join('')
}

/** The PR as it stands plus its changed files, for an update call that takes it out of draft. */
async function readPr($: any, server: string, e: any): Promise<Record<string, unknown> | undefined> {
  try {
    const where = { owner: e.owner, repo: e.repo, pullNumber: e.pullNumber }
    const g = await $.mcp.call(server, 'pull_request_read', { method: 'get', ...where })
    const f = await $.mcp.call(server, 'pull_request_read', { method: 'get_files', ...where, perPage: 100 })
    if (g.isError || f.isError) return undefined
    const pr = JSON.parse(textOf(g)) as { head?: { ref?: unknown }; title?: unknown; body?: unknown; draft?: unknown }
    const files = JSON.parse(textOf(f))
    if (pr?.draft !== true || !Array.isArray(files)) return undefined // only the draft -> ready move is gated
    return {
      head: String(pr?.head?.ref ?? ''), title: typeof e.title === 'string' ? e.title : String(pr.title ?? ''),
      body: typeof e.body === 'string' ? e.body : String(pr.body ?? ''), files,
    }
  } catch { return undefined }
}

// Shadow mode answers with a note, not a decision; toast it so session-close's mod actions log counts it.
function shadowToast($: any, v: HookOut | undefined): void {
  const c = contextOf(v)
  if (c && c.includes('SHADOW would-deny')) toast($, c)
}

export const register: Register = on => {
  on('tool.call', { tool: RECORD_ANY }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const { tool_name, tool_input } = toolPayload(e as any)
    const text = resultText(ran)
    // Keep only what the checks can use (see the list at the top).
    const input = JSON.stringify(tool_input)
    // A board row counts only from a query on track_requests, never from text that merely mentions ci-speed (review finding 3).
    const keep = (SQL.test(tool_name) && (BOARD_READ.test(input) || PLAN_POST.test(input)))
      || (SEND.test(tool_name) && PLAN_POST.test(input)) || COMMENT.test(tool_name)
      || (RUNNER.test(tool_name) && RUNNER_COMMENT.test(input))
    if (!keep) return ran
    const id = String((e as any).tool_use_id ?? '')
    const { list: base, ok } = await recorded($)
    const next_ = [...base,
      { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: tool_name, input: tool_input }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text.slice(0, MAX_TEXT) }] } },
    ].slice(-MAX_ROWS) as Row[]
    await update($, rows, () => next_)
    if (ok) await persist($, next_)
    return ran
  // A recording failure must never change the call's outcome.
  }).catch(($, e, next) => next(e))

  // LCH-744: no edit of a speed-sensitive file before the desk approves the plan (logic and selftest: ./plan_stage.py).
  on('classic.PreToolUse', { tool: EDIT }, async ($, e, next) => {
    const ev = e as any
    if (!MAYBE_GATED.test(String(ev.file_path ?? ev.notebook_path ?? ''))) return next(e)
    const told = await read($, planTold)
    const v = await runCheck($, 'plan_stage.py', { ...toolPayload(e as any), told, transcript_rows: (await recorded($)).list })
    const note = contextOf(v)
    if (note && note.includes('SHADOW would-ask-plan')) {
      toast($, note)
      await update($, planTold, () => true)
    }
    return preToolUse($, v) ?? next(e)
  // Fail open: a bug in the mod must never stop an edit.
  }).catch(($, e, next) => next(e))

  on('classic.PreToolUse', { tool: /^mcp__(github|GitHub_Custom)__create_pull_request$/ }, async ($, e, next) => {
    const v = await runCheck($, 'lch600-review-gate.py', { ...toolPayload(e as any), transcript_rows: (await recorded($)).list })
    shadowToast($, v)
    return preToolUse($, v) ?? next(e)
  // Fail open: a bug in the mod must never stop a tool call or a turn (runCheck already fails open).
  }).catch(($, e, next) => next(e))

  on('classic.PreToolUse', { tool: /^mcp__(github|GitHub_Custom)__update_pull_request$/ }, async ($, e, next) => {
    const ev = e as any
    if (ev.draft !== false) return next(e) // only leaving draft is a move toward live
    const server = String(ev.tool).split('__')[1] ?? 'github'
    const pr = await readPr($, server, ev)
    if (!pr) return next(e)
    const { tool_name, tool_input } = toolPayload(ev)
    const v = await runCheck($, 'lch600-review-gate.py', {
      tool_name, tool_input: { ...tool_input, head: pr.head, title: pr.title, body: pr.body },
      pr_files: pr.files, transcript_rows: (await recorded($)).list,
    })
    shadowToast($, v)
    return preToolUse($, v) ?? next(e)
  }).catch(($, e, next) => next(e))
}
