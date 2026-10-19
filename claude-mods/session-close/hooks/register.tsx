import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Ledger } from '../types'
import { MOD_TOOLS, OWN_MOD, modActionsIn, withModActions } from './modlog'

// Session close-out: the daily ritual that used to drive the end-of-session
// INGEST was retired 2026-10-06 (knowledge-system SKILL.md:43), so nothing
// asks a session "did you finish properly?" any more. This mod learns what the
// session touched from tool calls it actually observed, and on /close-out (or a
// turn that sounds like wrapping up) lists the obligations still unmet.
// It is a nudge: it never denies a call, never calls a model ($0), and never
// touches Stan's two gates (live-site publish, irreversible money/data).

const KEY = 'session-close:ledger'
// A quiet stretch of turns after which an unmet obligation is worth repeating.
const NUDGE_EVERY_TURNS = 6
// "Non-trivial work" for the INGEST obligation: this many work signals.
const NONTRIVIAL = 2

const blank = (): Ledger => ({
  turns: 0, lastNudgeTurn: 0, served: [], commented: [], webflowWrites: 0, prsMerged: 0,
  commits: 0, prsOpened: 0, ingests: 0, runs: {}, published: false,
  cannibScheduled: false, gscScheduled: false, passA: false, passB: false, modActions: [], lastModListTurn: 0,
  fleetOpen: [], fleetLoaded: false,
})

const ledger = atom({ plugin: 'session-close', key: 'ledger' } as const, blank())

type Unmet = { id: string; text: string; rule: string }

// ---------------------------------------------------------------------------
// Mod actions (LC-1711). Every bbm mod that denies, asks, blocks or changes something starts its
// message with `[mod:<name>]` and fires a toast with the same text. `$.store` is private to one
// plugin, so no shared log is possible; instead this mod reads the prefix off what it can SEE:
// the result or deny text of every tool call that reaches its hook, and every toast any plugin
// fires. Business analogy: not a shared logbook, a clerk who notes every stamped form that crosses
// the desk. A mod action it never sees (a hook order that denies beneath it, a toast-less path) is
// not listed; the list is a floor, not a census.
// ---------------------------------------------------------------------------

const modActionsLine = (l: Ledger): string =>
  (l.modActions ?? []).length === 0
    ? 'Mod actions this session: none seen'
    : `Mod actions this session: ${(l.modActions ?? []).map(a => `[${a}]`).join(' ')}`

// ---------------------------------------------------------------------------
// Detection. Everything below is a pure function of (tool name, input, result
// text) so the same logic is easy to reason about; the hooks only call it.
// ---------------------------------------------------------------------------

// MCP tools are `mcp__<server>__<tool>` and the server is an opaque id here,
// so match on the tool name alone.
const shortName = (tool: string): string => tool.split('__').pop() ?? tool
const blobOf = (v: unknown): string => {
  try { return JSON.stringify(v ?? '') } catch { return '' }
}
const JIRA_KEY = /\b(LC|BBM|LCH|LCC)-?(\d{1,5})\b/i
const keyIn = (s: unknown): string | undefined => {
  const m = JIRA_KEY.exec(String(s ?? ''))
  return m ? `${m[1].toUpperCase()}-${m[2]}` : undefined
}
const add = (list: string[], k: string | undefined): string[] =>
  k && !list.includes(k) ? [...list, k] : list

const WEBFLOW_TOOL = /^(data_[a-z_]+_tool|asset_tool|designer_tool)$/
// `publish(?!ed)`: a read like list_published_items is not a write or a publish.
const WEBFLOW_WRITE = /create|update|delete|publish(?!ed)|set_|bulk|add_/i
const SCHEDULE_TOOLS = new Set(['send_later', 'create_trigger', 'update_trigger', 'CronCreate', 'ScheduleWakeup'])
// SQL with comments and string literals blanked (single-quoted, with '' escapes,
// and $tag$...$tag$), so text inside them can never pass for a statement target.
// An unterminated literal runs to the end: unscannable text earns no credit.
function codeOf(q: string, keepLiterals = false): string {
  let out = ''
  let i = 0
  while (i < q.length) {
    const c = q[i]
    if (c === '-' && q[i + 1] === '-') {
      const nl = q.indexOf('\n', i)
      i = nl < 0 ? q.length : nl
    } else if (c === '/' && q[i + 1] === '*') {
      const end = q.indexOf('*/', i + 2)
      i = end < 0 ? q.length : end + 2
      out += ' '
    } else if (c === "'") {
      let j = i + 1
      for (; j < q.length; j++) {
        if (q[j] === "'" && q[j + 1] === "'") j++
        else if (q[j] === "'") break
      }
      // keepLiterals keeps a TERMINATED literal's text (a status value lives in
      // one) but never an unterminated one.
      out += keepLiterals && j < q.length ? q.slice(i, j + 1) : "''"
      i = j + 1
    } else if (c === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(q.slice(i))
      if (m) {
        const end = q.indexOf(m[0], i + m[0].length)
        out += keepLiterals && end >= 0 ? q.slice(i, end + m[0].length) : "''"
        i = end < 0 ? q.length : end + m[0].length
      } else {
        out += c
        i++
      }
    } else {
      out += c
      i++
    }
  }
  return out
}
const UUID_ONCE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

// What a scheduled-text covers. listicle-refresh Stage 7.5 check 5
// (SKILL.md:511): "schedule (a) a +2-3 week cannibalization re-check and (b)
// the 30/60/90 GSC checkpoint ... Jira or scheduled task, never chat."
const COVERS_CANNIB = /cannibal|\+\s*[24]\s*(?:-\s*\d\s*)?(?:wk|week)|\b[24]\s*(?:-\s*\d\s*)?(?:wk|weeks?)\b/i
// A bare "checkpoint" is not enough ("security checkpoint reminder" is not GSC).
const COVERS_GSC = /30\s*[\/,\-–]\s*60\s*[\/,\-–]\s*90|\bgsc\b/i

const actionNames = (i: any): string[] => {
  const list = Array.isArray(i?.actions) ? i.actions : i?.actions ? [i.actions] : []
  const names: string[] = []
  for (const a of list) {
    if (typeof a === 'string') names.push(a)
    else if (a && typeof a === 'object') names.push(...Object.keys(a))
  }
  if (typeof i?.action === 'string') names.push(i.action)
  return names
}
const hasTiming = (i: any): boolean =>
  ['delay_minutes', 'at', 'run_once_at', 'cron_expression', 'delaySeconds', 'cron', 'recurring']
    .some(k => i?.[k] !== undefined && i?.[k] !== null && i?.[k] !== '')

function observe(l: Ledger, tool: string, input: any, resultText: string): Ledger {
  const name = shortName(tool)
  const blob = blobOf(input)
  const next: Ledger = { ...l, runs: { ...l.runs } }

  // Jira: a comment on a ticket (session-handoff SKILL.md:189 treats tickets
  // moved in the session as the thread's record; Stan's rule is do -> verify
  // -> update ticket).
  if (name === 'addCommentToJiraIssue') {
    const k = keyIn(input?.issueIdOrKey)
    next.commented = add(next.commented, k)
    const body = String(input?.commentBody ?? '')
    // Pass A/B verdicts are recorded on the refresh ticket
    // (listicle-refresh SKILL.md:515 Pass A, :547 Pass B).
    // Only an anchored "Pass A: PASS|BLOCK" verdict, and only on a ticket this
    // session actually worked, so unrelated prose or another ticket cannot
    // satisfy it. The receipt-script path below stays the primary signal.
    if (k && l.served.includes(k)) {
      if (/\bpass\s*a\s*[:\-–]\s*(pass|block)\b/i.test(body)) next.passA = true
      if (/\bpass\s*b\s*[:\-–]\s*(pass|block)\b/i.test(body)) next.passB = true
    }
    if (/next due/i.test(body)) schedule(next, body)
  }
  if (name === 'transitionJiraIssue' || name === 'editJiraIssue') {
    next.served = add(next.served, keyIn(input?.issueIdOrKey))
    // Jira "next due" write counts as a scheduling write.
    if (/next due|duedate|due date/i.test(blob)) schedule(next, blob)
  }
  if (name === 'createJiraIssue' && /duedate|due date|next due/i.test(blob)) schedule(next, blob)

  // Scheduled-task / send_later / create_trigger: the only places a re-check
  // may live ("never chat").
  // A real schedule write carries a timing argument; a bare call with prose
  // alone is not a scheduled re-check.
  if (SCHEDULE_TOOLS.has(name) && hasTiming(input)) schedule(next, blob)

  // knowledge-system SKILL.md:154 -- INGEST is an INSERT INTO
  // public.knowledge_memories; session-handoff SKILL.md:281 "Run the inserts directly."
  if (name === 'execute_sql') {
    const q = String(input?.query ?? '')
    if (/\binsert\s+into\s+(?:public\.)?knowledge_memories\b/i.test(codeOf(q))) next.ingests += 1
    if (/\brefresh_runs\b/i.test(codeOf(q))) observeRun(next, q, resultText)
  }

  // Webflow writes and publish. The publish click is Stan's gate: this only
  // *records* that one happened.
  if (WEBFLOW_TOOL.test(name)) {
    // Match action NAMES (the keys of each `actions` entry, or an `action`
    // string), never the serialized payload: an id like "my_publish_test"
    // must not read as a publish.
    const act = actionNames(input).join(' ')
    if (WEBFLOW_WRITE.test(act)) {
      next.webflowWrites += 1
      if (/publish(?!ed)/i.test(act) && !/unpublish/i.test(act)) next.published = true
    }
  }

  if (name === 'merge_pull_request') next.prsMerged += 1
  if (name === 'create_pull_request') {
    next.prsOpened += 1
    next.served = add(next.served, keyIn(input?.title) ?? keyIn(input?.head))
  }

  if (tool === 'Bash') {
    const cmd = String(input?.command ?? '')
    if (/\bgit\s+commit\b/.test(cmd)) {
      next.commits += 1
      // Commit convention (CLAUDE.md §5): the Jira key leads the first line.
      next.served = add(next.served, keyIn(cmd))
    }
    if (/\bgit\s+(?:checkout\s+-b|switch\s+-c|branch)\b/.test(cmd)) next.served = add(next.served, keyIn(cmd))
    // listicle-refresh SKILL.md:167/:173 -- the Pass A / Pass B gates write receipts.
    // Flag order is free: both tokens on the same article_audit.py invocation.
    if (/article_audit\.py/.test(cmd) && /--write-receipt\b/.test(cmd)) {
      if (/--pass[\s=]+a\b/.test(cmd)) next.passA = true
      if (/--pass[\s=]+b\b/.test(cmd)) next.passB = true
    }
  }
  return next
}

// Prose that says NOT to schedule must not earn credit for scheduling.
const NEGATED = /\b(?:do not|don't|dont|no need to|never|skip|without|not)\b[^.\n]{0,40}\b(?:schedul\w*|gsc|cannibal\w*|checkpoint\w*|re-?check\w*)/i
function schedule(l: Ledger, text: string): void {
  if (NEGATED.test(text)) return
  if (COVERS_CANNIB.test(text)) l.cannibScheduled = true
  if (COVERS_GSC.test(text)) l.gscScheduled = true
}

// refresh_runs: listicle-refresh SKILL.md:543 -- "A run left `in_progress`
// after publish corrupts the next session's resume". A write sets the state to
// the status it names; a read counts as in_progress only if the rows that came
// back say so. The last observation wins.
function observeRun(l: Ledger, q: string, resultText: string): void {
  // Only a statement whose TARGET is refresh_runs may move run state; mentioning
  // the table in a subquery of another table's write, or a look-alike name,
  // must not. Pass A/B are deliberately NOT read from SQL: a verdict inside a
  // literal cannot be told from prose, so only the receipt script and an
  // anchored Jira comment count (see observe()).
  const code = codeOf(q)
  const writesRuns = /\b(?:insert\s+into|update)\s+(?:public\.)?refresh_runs\b/i.test(code)
  // A read counts only when refresh_runs is the statement's FIRST `from` target,
  // so a subquery inside another table's SELECT cannot move run state.
  const readsRuns = !writesRuns && /^(?:(?!\bfrom\b)[\s\S])*\bfrom\s+(?:public\.)?refresh_runs\b/i.test(code)
  if (!writesRuns && !readsRuns) return
  const OPEN = /^(in_progress|queued|running)$/i
  const DONE = /^(done|complete|completed|closed|failed|abandoned|skipped)$/i
  const classify = (v: string): 'in_progress' | 'closed' | undefined =>
    OPEN.test(v) ? 'in_progress' : DONE.test(v) ? 'closed' : undefined
  const ids = (code.match(UUID) ?? []).concat(codeOf(q, true).match(UUID) ?? [])
  const queryIds = [...new Set(ids.map(i => i.toLowerCase()))]
  if (writesRuns) {
    // Only an UPDATE's explicit `status = '...'`, read from the query with
    // comments removed (a commented-out assignment must not count). An INSERT
    // or any other shape changes nothing; the next read of the row settles it.
    if (!/\bupdate\b/i.test(code)) return
    const m = /\bstatus\s*=\s*'(\w+)'/i.exec(codeOf(q, true))
    const state = m ? classify(m[1]) : undefined
    if (state) for (const id of queryIds.length ? queryIds : ['(unspecified run)']) l.runs[id] = state
    return
  }
  // Read: pair each id with its own status from the result rows. Rows with no
  // id of their own apply only when the query named exactly one run.
  const rows = resultText.match(/\{[^{}]*\}/g) ?? []
  for (const row of rows) {
    const st = /"status"\s*:\s*"(\w+)"/i.exec(row)
    const state = st ? classify(st[1]) : undefined
    if (!state) continue
    const rid = UUID_ONCE.exec(row)
    if (rid) l.runs[rid[0].toLowerCase()] = state
    else if (queryIds.length === 1) l.runs[queryIds[0]] = state
  }
}

// ---------------------------------------------------------------------------
// Obligations. Each carries the skill line it comes from so the checklist
// answers "says who?" without opening a skill.
// ---------------------------------------------------------------------------

function unmet(l: Ledger): Unmet[] {
  const out: Unmet[] = []
  const work = l.webflowWrites + l.prsMerged + l.commits + l.prsOpened

  if (work >= NONTRIVIAL && l.ingests === 0) {
    out.push({
      id: 'ingest',
      text: `Knowledge INGEST: ${work} work signals this session, no INSERT into knowledge_memories`,
      rule: 'knowledge-system SKILL.md:52 (after non-trivial work) + :154',
    })
  }
  for (const k of l.served) {
    if (!l.commented.includes(k)) {
      out.push({
        id: `jira:${k}`,
        text: `Jira: no comment on ${k}, which this session worked on`,
        rule: 'session-handoff SKILL.md:189 (tickets moved this session are the record); do -> verify -> update ticket',
      })
    }
  }
  for (const [id, state] of Object.entries(l.runs)) {
    if (state === 'in_progress') {
      out.push({
        id: `run:${id}`,
        text: `refresh_runs ${id} last seen in_progress; close it (done) or record why not`,
        rule: 'listicle-refresh SKILL.md:543 (a run left in_progress corrupts the next resume)',
      })
    }
  }
  // Standing ruling (Stan, 2026-10-15): Claude closes or archives the sessions it spins up.
  // Only a fleet-tracker that answered can raise this; "not loaded" is not "no children".
  if (l.fleetLoaded && (l.fleetOpen ?? []).length > 0) {
    out.push({
      id: 'fleet',
      text: `Fleet: ${l.fleetOpen.length} child session(s) still open: ${l.fleetOpen.join('; ')}. ` +
        'Close each out: mcp__fleet-tracker__untrack archives a finished one (COMPLETED / REVIEW_READY); one still working ' +
        'cannot be archived yet, so wait for it, or untrack with keep_reason if it stays open on purpose',
      rule: 'Stan 2026-10-15 (LC-1835): Claude is responsible for the sessions it spins up and closes or archives them',
    })
  }
  if (l.published) {
    if (!l.cannibScheduled) {
      out.push({
        id: 'cannib',
        text: 'Refresh reached publish: +2/+4-week cannibalization re-check not scheduled (accepted: send_later / create_trigger / CronCreate with a time, or a Jira next-due/duedate write, whose text names cannibalization or +2/+4 weeks)',
        rule: 'listicle-refresh SKILL.md:511 (Jira or scheduled task, never chat); campaign-plan SKILL.md:138',
      })
    }
    if (!l.gscScheduled) {
      out.push({
        id: 'gsc',
        text: 'Refresh reached publish: 30/60/90 GSC checkpoints not scheduled (accepted: send_later / create_trigger / CronCreate with a time, or a Jira next-due/duedate write, whose text names GSC or 30/60/90)',
        rule: 'listicle-refresh SKILL.md:511',
      })
    }
    if (!l.passA) {
      out.push({
        id: 'passA',
        text: 'Refresh reached publish: no Pass A verdict recorded (receipt script or an anchored Jira verdict comment)',
        rule: 'listicle-refresh SKILL.md:515 (Pass A recorded in selection_provenance)',
      })
    }
    if (!l.passB) {
      out.push({
        id: 'passB',
        text: 'Refresh reached publish: no Pass B verdict recorded (receipt script or an anchored Jira verdict comment; needed before the run closes)',
        rule: 'listicle-refresh SKILL.md:547 (no verdict, no close)',
      })
    }
  }
  return out
}

function checklist(l: Ledger): string {
  const list = unmet(l)
  const seen =
    `Seen: ${l.served.length} ticket(s), ${l.commented.length} commented, ${Object.keys(l.runs).length} run(s), ` +
    `${l.webflowWrites} Webflow write(s), ${l.prsMerged} merged PR(s), ${l.ingests} ingest(s)${l.published ? ', published' : ''}, ` +
    (l.fleetLoaded ? `${(l.fleetOpen ?? []).length} open fleet child(ren)` : 'fleet children NOT CHECKED (fleet-tracker not loaded)')
  if (list.length === 0) return `Close-out: nothing unmet. ${seen}\n${modActionsLine(l)}`
  return [
    `Close-out: ${list.length} unmet`,
    ...list.map(u => `  [ ] ${u.text}\n      rule: ${u.rule}`),
    seen,
    modActionsLine(l),
    'Nudge only: nothing is blocked. Reads of the live site, Jira and Supabase never count as meeting an obligation, only the writes above do.',
  ].join('\n')
}

// ---------------------------------------------------------------------------

// Take a saved ledger field by field, keeping only values of the right type, so
// a partial or foreign object cannot suppress an obligation.
function rehydrate(saved: any): Ledger {
  const out: any = blank()
  if (!saved || typeof saved !== 'object') return out
  for (const k of Object.keys(out)) {
    const v = saved[k]
    if (Array.isArray(out[k])) out[k] = Array.isArray(v) ? v.filter((x: unknown) => typeof x === 'string') : out[k]
    else if (typeof out[k] === 'object') {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        out[k] = Object.fromEntries(Object.entries(v).filter(([, st]) => st === 'in_progress' || st === 'closed'))
      }
    } else if (typeof v === typeof out[k]) out[k] = v
  }
  return out
}

// Top-level so the engine can follow `$` into it.
// The ledger is saved WITH the id of the session it belongs to, so a fresh
// session (new id, e.g. after /clear) never inherits another session's unmet
// obligations; a restart or hot reload of the same session keeps its own.
async function mutate($: any, fn: (l: Ledger) => Ledger) {
  await update($, ledger, fn)
  await $.store.set(KEY, { ...(await read($, ledger)), sessionId: await sessionIdOf($) })
}

// '' when the id cannot be read; an empty id never matches on restore.
async function sessionIdOf($: any): Promise<string> {
  try {
    return String((await $.session.id()) ?? '')
  } catch {
    return ''
  }
}

// Child sessions still open in fleet-tracker (LC-1835). session-close cannot import another plugin, so it
// asks through the tool surface: fleet-tracker's `open_children` answers `Open fleet children: N` then one
// `- ` line per session. ANY failure (no such tool because fleet-tracker is not loaded, a deny, an error,
// a reply without that header) is "not loaded / not checked", recorded as fleetLoaded=false so it can
// never read as zero children.
const FLEET_TOOL = 'mcp__fleet-tracker__open_children'
function parseFleet(out: any): string[] | null {
  if (!out || out.deny || out.isError) return null
  const text = typeof out.text === 'string' ? out.text : typeof out.result === 'string' ? out.result : ''
  // The list, not just the header, must be complete: a header claiming N with any other
  // number of entries is unreadable, i.e. NOT CHECKED, never "0 open" (CI review, PR #1816).
  const head = text.match(/^\s*Open fleet children:\s*(\d+)\s*$/m)
  if (!head) return null
  const items = [...text.matchAll(/^- (.+)$/gm)].map(m => m[1].trim())
  return items.length === Number(head[1]) ? items : null
}
async function refreshFleet($: any): Promise<void> {
  let open: string[] | null = null
  try {
    open = parseFleet(await $.tool.call({ tool: FLEET_TOOL } as any))
  } catch {
    open = null
  }
  await mutate($, l => ({ ...l, fleetOpen: open ?? [], fleetLoaded: open !== null }))
}

// A nudge mod must never be the reason a tool call, a turn or a redraw fails:
// every hook body runs its own work inside this and then reaches next(e).
function logFailure($: any, where: string, err: unknown): void {
  try {
    $.ui.log(`session-close: ${where} failed (ignored): ${String(err).slice(0, 200)}`, { to: 'debug' })
  } catch {
    // Logging is best effort too.
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      // $.state is the session's, $.store outlives it. Restore only a ledger
      // saved by THIS session (same id); anything else is another session's.
      const saved = (await $.store.get(KEY)) as (Ledger & { sessionId?: string }) | undefined
      const sid = await sessionIdOf($)
      if (saved && sid !== '' && saved.sessionId === sid && (await read($, ledger)).turns === 0) {
        await update($, ledger, () => rehydrate(saved))
      }
      await $.command.register({ name: 'close-out', description: 'List the close-out obligations still unmet' })
    } catch (err) {
      logFailure($, 'session.start', err)
    }
    return next(e)
  })

  // Observer only: runs the call, then learns from it. A failed call proves
  // nothing was written, so it is not counted. Whatever observing does, the
  // tool's own result goes back untouched.
  on('tool.call', async ($, e: any, next) => {
    const out: any = await next(e)
    // A mod's deny / block / result text carries `[mod:<name>]`: note it even when the call was refused,
    // because a refusal is exactly the action worth listing.
    try {
      const speaks = MOD_TOOLS.test(String(e.tool))
      const found = modActionsIn([
        out?.deny,
        ...(speaks ? [out?.text, out?.result] : []),
        ...(Array.isArray(out?.context) ? out.context : [out?.context]),
      ])
      if (found.length) await mutate($, l => withModActions(l, found))
    } catch (err) {
      logFailure($, 'tool.call mod actions', err)
    }
    if (out?.deny || out?.isError) return out
    try {
      const text = typeof out?.text === 'string' ? out.text : blobOf(out?.result)
      // The engine spreads a tool's arguments beside `tool`; also accept a nested
      // `input` object so a differently-shaped event under-reports nothing.
      const args = e.input && typeof e.input === 'object' ? { ...e, ...e.input } : e
      // A result whose FIRST line reads as an error is not a confirmed write
      // (a later line that merely starts with "error" is ordinary output).
      if (/^\s*(?:error|failed|permission denied)\b/i.test(text)) return out
      await mutate($, l => observe(l, e.tool, args, text))
    } catch (err) {
      logFailure($, 'tool.call', err)
    }
    return out
  })

  // Every mod action fires a toast carrying the same `[mod:<name>]` text, including the ones that
  // never travel in a tool result (a pin, a /draft-done verdict). Observer only: the toast goes on.
  on('ui.toast', async ($, e: any, next) => {
    try {
      const found = modActionsIn([e.text])
      if (found.length) await mutate($, l => withModActions(l, found))
    } catch (err) {
      logFailure($, 'ui.toast', err)
    }
    return next(e)
  })

  on('command.run', { command: 'close-out' }, async $ => {
    try {
      await refreshFleet($).catch(err => logFailure($, 'fleet read', err))
      return { text: checklist(await read($, ledger)) }
    } catch (err) {
      logFailure($, 'command.run', err)
      return { text: `Close-out: could not read the ledger (${String(err).slice(0, 120)}).` }
    }
  })

  // One-line nudge, only when something is unmet, only after the session
  // touched something, and only on a wrap-up-sounding answer or after a long
  // stretch of quiet turns. Never a block.
  on('turn.complete', async ($, e: any, next) => {
    if (e.agentId) return next(e)
    try {
      await mutate($, l => ({ ...l, turns: l.turns + 1 }))
      await refreshFleet($).catch(err => logFailure($, 'fleet read', err))
      const l = await read($, ledger)
      const list = unmet(l)
      const wrap = /\b(done|merged|shipped|wrapp?(?:ing|ed)(?: it)? up|all set|closing|handoff|READY:|NEEDS STAN:)/i.test(String(e.answer ?? ''))
      if (list.length === 0) {
        $.ui.status(undefined)
        // Nothing unmet, but a wrap-up turn still lists what the mods did this session.
        if (wrap && (l.modActions ?? []).length > 0 && (l.lastModListTurn ?? 0) !== l.turns) {
          $.ui.toast(`[mod:${OWN_MOD}] ${modActionsLine(l)}`)
          await mutate($, x => ({ ...x, lastModListTurn: x.turns }))
        }
      } else if (wrap || l.turns - l.lastNudgeTurn >= NUDGE_EVERY_TURNS) {
        $.ui.status(`close-out: ${list.length} unmet (${list.map(u => u.id.split(':')[0]).join(', ')}) /close-out`)
        if (wrap) $.ui.toast(`[mod:${OWN_MOD}] ${list.length} close-out item(s) unmet: /close-out. ${modActionsLine(l)}`)
        await mutate($, x => ({ ...x, lastNudgeTurn: x.turns }))
      }
    } catch (err) {
      logFailure($, 'turn.complete', err)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    try {
      const l = await read($, ledger)
      const list = unmet(l)
      if (e.props.hasSurvey || list.length === 0 || l.lastNudgeTurn === 0) return next(e)
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box>
          <Text color="warning" wrap="truncate-end">
            Close-out: {list.length} unmet, /close-out to see them
          </Text>
        </Box>
      )
    } catch (err) {
      logFailure($, 'ui.render', err)
      return next(e)
    }
  })
}
