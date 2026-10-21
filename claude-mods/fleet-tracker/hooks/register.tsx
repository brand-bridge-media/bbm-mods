import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { FleetRow } from '../types'
import {
  childIdOf, CLOSABLE_BUCKETS, closeoutLine, decideCloseout, decideStall, decideWaitingReminder, decideWake, ESCALATE_MS, humanWrap, newestActivity, NEEDS_STAN,
  NUDGE_TEXT, STALL_MS, ticketOf, WAITING_BUCKETS, waitingLine, withChildTools,
} from './logic'

// Fleet tracker: one line per cloud session the orchestrator spins up.
// Why it exists: a child session's report back to its parent is not reliable
// (it only happens if the child chooses to send one), so the orchestrator has
// to poll. This mod does the polling on a timer, draws the
// result, and wakes the orchestrator only when a row changes into a state that
// needs a decision, so nobody has to remember to look.

// Callout convention (LC-1711): every message that changes something (a row added, flagged or removed,
// the wake-up turn's text) starts with `[mod:fleet-tracker]` (that text reaches the model in the tool
// result or the queued turn) and fires a toast naming the mod and the reason. The dashboard itself
// is informational and needs no toast; a routine wake-up turn is prefixed but not toasted (a toast
// per REVIEW_READY would be noise; the ones that need the operator already toast through `say`). A plain
// note is routine bookkeeping: prefixed for the model, silent for the operator. Only a needs_you flag toasts.
const MOD = 'fleet-tracker'
function say($: any, reason: string, toast = true): string {
  const text = `[mod:${MOD}] ${reason}`
  try {
    if (toast) $.ui.toast(text.length > 160 ? `${text.slice(0, 157)}...` : text)
  } catch { /* a toast must never be the reason a tool call fails */ }
  return text
}

const PANE = 'fleet'
const SERVER = 'claude-code-remote'
const POLL_MS = 90_000
const STORE_KEY = 'rows'

// Buckets that mean "a human has to do something" (the operator gets flagged).

const lastWoken = new Map<string, string>()
// Stall state per session, the source of truth while the module lives. Two polls can
// overlap (timer + track/status) and each saves its own copy of the rows, so a nudge is
// claimed here synchronously, between the decision and the first await: the second
// poll to decide sees the claim and never sends a duplicate (caught by stall.test.ts).
// After a reload the map is empty and falls back to the row's saved fields.
const stallOf = new Map<string, { nudgedAt: number; escalated: boolean }>()
// Close-out reminder claims (LC-1835), same reason as stallOf: the episode (bucket @ entry time)
// whose one reminder has been claimed, set synchronously so two overlapping polls cannot both send it.
const closeoutClaim = new Map<string, string>()
// Waiting-reminder claims (LC-1881), same reason: episode (bucket @ entry time) -> when its last
// reminder was claimed, set synchronously so two overlapping polls cannot both send it.
const waitClaim = new Map<string, { episode: string; at: number }>()

const rows = atom({ plugin: 'fleet-tracker', key: 'rows' } as const, [] as FleetRow[])

const shortBucket = (raw: unknown): string =>
  String(raw ?? 'UNKNOWN').replace('SESSION_STATUS_BUCKET_', '')

const textOf = (res: { content: readonly unknown[] }): string =>
  res.content
    .map(b => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
    .join('')

const ago = (iso: string, now: number): string => {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '?'
  const m = Math.max(0, Math.round((now - t) / 60_000))
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`
}

// Every change to the list is ONE functional update on the current value, never
// read-then-write: a read followed by an await and a write lost whatever another
// handler wrote in between. Measured on v1 (2026-10-15): a `note` was wiped by the
// poll `track` had queued, because that poll saved the list it read before the note.
async function mutate($: any, fn: (cur: FleetRow[]) => FleetRow[]): Promise<FleetRow[]> {
  let out: FleetRow[] = []
  await update($, rows, (cur: FleetRow[]) => (out = fn(cur)))
  await $.store.set(STORE_KEY, out)
  return out
}

// One poll: refresh every row from get_session, then react to transitions.
async function poll($: any): Promise<FleetRow[]> {
  const before: FleetRow[] = await read($, rows)
  if (before.length === 0) return before
  const now = await $.clock.now()
  const wakes: string[] = []
  const stanToasts: string[] = []

  const after = await Promise.all(
    before.map(async (row): Promise<FleetRow> => {
      try {
        const res = await $.mcp.call(SERVER, 'get_session', { session_id: row.sessionId })
        if (res.isError) throw new Error(textOf(res).slice(0, 120))
        const raw = textOf(res)
        // The server wraps its JSON in an <other-session> tag; take the outermost object.
        const start = raw.indexOf('{'), end = raw.lastIndexOf('}')
        if (start < 0 || end <= start) throw new Error(`no JSON in reply: ${raw.slice(0, 80)}`)
        const ccr = JSON.parse(raw.slice(start, end + 1)).ccr ?? {}
        // post_turn_summary is the session's own read of its last turn; a
        // pending needs_action means it waits on a decision even when the
        // bucket still says COMPLETED.
        const pts = ccr.post_turn_summary ?? ccr.external_metadata?.post_turn_summary ?? {}
        const needsAction = String(pts.needs_action ?? '')
        const bucket =
          needsAction || pts.status_category === 'need_input' ? 'NEEDS_INPUT' : shortBucket(ccr.status_bucket)
        const fresh: FleetRow = {
          ...row,
          bucket,
          status: String(ccr.session_status ?? '').replace('SESSION_STATUS_', ''),
          needsAction,
          statusDetail: String(pts.status_detail ?? ''),
          summary: needsAction || String(pts.status_detail || pts.recent_action || ccr.task_summary || ''),
          costUsd: Number(ccr.external_metadata?.usage?.cost_usd ?? row.costUsd ?? 0),
          updatedAt: String(ccr.updated_at ?? row.updatedAt),
          checkedAt: now,
          error: '',
          // A manual needs-you note sticks until cleared; a bucket flag tracks the bucket.
          needsYou: NEEDS_STAN.has(bucket) || (row.needsYou && row.note !== ''),
        }
        const { wake, holdPrevBucket } = decideWake(lastWoken, row.sessionId, row.bucket, bucket, fresh.summary)
        if (holdPrevBucket) fresh.bucket = row.bucket
        if (wake) {
          const entry = `${row.ticket} (${row.label}) ${row.bucket || 'NEW'} -> ${bucket}: ${fresh.summary}`
          wakes.push(
            WAITING_BUCKETS.has(bucket) ? humanWrap(entry, row.sessionId, needsAction, fresh.statusDetail ?? '') : entry,
          )
        }
        if (fresh.needsYou && !row.needsYou) stanToasts.push(`${row.ticket} needs you: ${bucket}`)

        // Close-out clock (LC-1835). bucketSince moves only when the stored bucket changes
        // (a held, suppressed entry is not a change); a row saved before this field existed
        // starts its clock at its first poll. One reminder per bucket episode.
        if (fresh.bucket !== row.bucket || !row.bucketSince) {
          fresh.bucketSince = now
          if (fresh.bucket !== row.bucket) delete fresh.closeoutWokeAt
        }
        const episode = `${fresh.bucket}@${fresh.bucketSince}`
        const claimed = closeoutClaim.get(row.sessionId) === episode || !!fresh.closeoutWokeAt
        if (decideCloseout(fresh.bucket, fresh.bucketSince ?? 0, now, claimed)) {
          closeoutClaim.set(row.sessionId, episode)
          fresh.closeoutWokeAt = now
          wakes.push(closeoutLine(row.ticket, row.label, fresh.bucket, fresh.bucketSince ?? now, now))
        }

        // Waiting clock (LC-1881): a child that waits on a human is reminded every
        // WAITING_REMIND_MS until its bucket changes. UNKNOWN (a bad poll) leaves the clock alone;
        // any other bucket change restarts it.
        if (fresh.bucket !== 'UNKNOWN') {
          if (!WAITING_BUCKETS.has(fresh.bucket)) {
            delete fresh.waitBucket
            delete fresh.waitSince
            delete fresh.waitRemindedAt
          } else if (fresh.waitBucket !== fresh.bucket || !fresh.waitSince) {
            fresh.waitBucket = fresh.bucket
            fresh.waitSince = now
            delete fresh.waitRemindedAt
          }
        }
        const waitEpisode = `${fresh.waitBucket}@${fresh.waitSince}`
        const claim = waitClaim.get(row.sessionId)
        const remindedAt = Math.max(claim?.episode === waitEpisode ? claim.at : 0, fresh.waitRemindedAt ?? 0)
        if (decideWaitingReminder(fresh.bucket, fresh.waitSince ?? 0, remindedAt, now)) {
          waitClaim.set(row.sessionId, { episode: waitEpisode, at: now })
          fresh.waitRemindedAt = now
          wakes.push(
            waitingLine(row.ticket, row.label, row.sessionId, fresh.bucket, now - (fresh.waitSince ?? now), needsAction, fresh.statusDetail ?? ''),
          )
        }

        // Stall check (LC-1834). Only fetch the transcript when the turn-level
        // updated_at is itself stale: a healthy fleet costs no extra calls.
        const prior = stallOf.get(row.sessionId) ?? { nudgedAt: row.nudgedAt ?? 0, escalated: row.stallEscalated ?? false }
        let lastMs: number | null = Date.parse(fresh.updatedAt)
        if (Number.isNaN(lastMs)) lastMs = null
        // Once nudged, updated_at is not evidence: delivering our own nudge may bump it,
        // which would clear the stall and re-nudge every 15 min without ever escalating
        // (review finding 2). Only a transcript event that is not the nudge counts.
        if (prior.nudgedAt) lastMs = null
        if (bucket === 'WORKING' && (prior.nudgedAt || lastMs === null || now - lastMs >= STALL_MS)) {
          const ev = await $.mcp
            .call(SERVER, 'list_events', { session_id: row.sessionId, limit: 5 })
            .catch(() => null)
          const seen = !ev || ev.isError ? null : newestActivity(textOf(ev))
          // An unreadable transcript is unknown activity (decideStall decides what that means).
          lastMs = seen === null ? null : Math.max(seen, lastMs ?? 0)
        }
        if (lastMs !== null) fresh.lastActivity = new Date(lastMs).toISOString()
        const st = stallOf.get(row.sessionId) ?? prior
        const step = decideStall(bucket, lastMs, now, st.nudgedAt, st.escalated)
        const quietMin = lastMs === null ? 0 : Math.round((now - lastMs) / 60_000)
        if (step === 'clear') stallOf.set(row.sessionId, { nudgedAt: 0, escalated: false })
        else if (step === 'nudge') stallOf.set(row.sessionId, { nudgedAt: now, escalated: false })
        else if (step === 'escalate') stallOf.set(row.sessionId, { ...st, escalated: true })
        else stallOf.set(row.sessionId, st)
        if (step === 'nudge') {
          const sent = await $.mcp
            .call(SERVER, 'send_message', { session_id: row.sessionId, message: NUDGE_TEXT, priority: 'next' })
            .catch((err: unknown) => ({ isError: true, content: [{ type: 'text', text: String(err) }] }))
          if (sent.isError) {
            // No nudge delivered: the orchestrator hears now rather than in 10 minutes.
            stallOf.set(row.sessionId, { nudgedAt: now, escalated: true })
            wakes.push(`${row.ticket} (${row.label}) STALLED: no activity for ${quietMin}m and the nudge failed (${textOf(sent).slice(0, 80)})`)
            stanToasts.push(`${row.ticket} stalled ${quietMin}m; nudge failed`)
          } else {
            say($, `${row.ticket} quiet ${quietMin}m; nudged it to continue`, false)
          }
        } else if (step === 'escalate') {
          wakes.push(
            `${row.ticket} (${row.label}) STALLED: ${lastMs === null ? 'activity unreadable' : `no activity for ${quietMin}m`}; an automatic nudge ` +
              `${Math.round(ESCALATE_MS / 60_000)}m ago got no response. Inspect it (list_events), then interrupt/re-brief or archive.`,
          )
          stanToasts.push(`${row.ticket} stalled ${quietMin}m after a nudge`)
        }
        const final = stallOf.get(row.sessionId)!
        fresh.nudgedAt = final.nudgedAt
        fresh.stallEscalated = final.escalated
        return fresh
      } catch (err) {
        // A failed poll is evidence about the poll, not the session: show it, don't flag the operator.
        return { ...row, checkedAt: now, error: String(err).slice(0, 120) }
      }
    }),
  )

  // Merge, don't overwrite (review finding 4): the poll awaited the network, and a
  // track / untrack / note / auto-track may have changed the list meanwhile. Rows
  // removed meanwhile stay removed, rows added meanwhile are kept, and the fields a
  // person or the orchestrator owns come from the current list.
  const polled = new Map(after.map(r => [r.sessionId, r]))
  const merged = await mutate($, current =>
    current.map(cur => {
      const p = polled.get(cur.sessionId)
      if (!p) return cur
      return {
        ...p,
        ticket: cur.ticket,
        label: cur.label,
        note: cur.note,
        needsYou: NEEDS_STAN.has(p.bucket) || (cur.needsYou && cur.note !== ''),
      }
    }),
  )
  // A row untracked mid-poll must not keep stall state a later re-track would inherit.
  for (const id of [...stallOf.keys()]) if (!merged.some(r => r.sessionId === id)) stallOf.delete(id)
  for (const id of [...closeoutClaim.keys()]) if (!merged.some(r => r.sessionId === id)) closeoutClaim.delete(id)
  for (const id of [...waitClaim.keys()]) if (!merged.some(r => r.sessionId === id)) waitClaim.delete(id)
  for (const t of stanToasts) say($, t)
  pendingWakes.push(...wakes)
  flushWakes($)
  return merged
}

// A stalled row reads STALLED (nudged / escalated) instead of the server's WORKING.
const shown = (r: FleetRow): string =>
  r.stallEscalated ? 'STALLED' : r.nudgedAt ? 'NUDGED' : r.bucket || 'pending'

// This session's own id, so auto-track can never pick it out of a result. One
// get_session with no id (it describes the caller), cached for the module's life.
// Only a SUCCESSFUL lookup is cached: a failed one returns '' and is retried next time
// (PR #1808 review). With '' childIdOf demands exactly one candidate in the whole result.
let ownIdCache = ''
async function ownId($: any): Promise<string> {
  if (ownIdCache !== '') return ownIdCache
  try {
    const res = await $.mcp.call(SERVER, 'get_session', {})
    const raw = textOf(res)
    const start = raw.indexOf('{'), end = raw.lastIndexOf('}')
    if (res.isError || start < 0) return ''
    ownIdCache = String(JSON.parse(raw.slice(start, end + 1)).ccr?.id ?? '')
  } catch {
    return ''
  }
  return ownIdCache
}

// The session's own status, structured: true only on an explicit SESSION_STATUS_ARCHIVED.
// Anything unreadable is false, so the row is kept.
async function isArchived($: any, id: string): Promise<boolean> {
  try {
    const res = await $.mcp.call(SERVER, 'get_session', { session_id: id })
    if (res.isError) return false
    const raw = textOf(res)
    const start = raw.indexOf('{'), end = raw.lastIndexOf('}')
    if (start < 0 || end <= start) return false
    return JSON.parse(raw.slice(start, end + 1)).ccr?.session_status === 'SESSION_STATUS_ARCHIVED'
  } catch {
    return false
  }
}

function blankRow(sessionId: string, ticket: string, label: string): FleetRow {
  return {
    sessionId, ticket, label, bucket: '', status: '', summary: '', costUsd: 0,
    updatedAt: '', checkedAt: 0, note: '', needsYou: false, error: '',
  }
}

// Wakes waiting for a moment the host lets us queue a turn. A poll run from inside a
// tool call (track, status, an auto-tracked create_session) may not submit a prompt:
// the host refuses it, and before LC-1834 that wake was silently lost (stall.test.ts
// surfaced the refusal). A refused submit keeps its lines here; the next timer poll
// or the end of the orchestrator's turn delivers them.
const pendingWakes: string[] = []

function flushWakes($: any) {
  if (pendingWakes.length === 0) return
  const lines = pendingWakes.splice(0)
  // Queues a turn once the session is idle, so the orchestrator triages and,
  // if the operator is needed, tells them in chat.
  Promise.resolve()
    .then(() =>
      $.prompt.submit({
        text:
          '[mod:fleet-tracker] Session state changed:\n' +
          lines.map(w => `- ${w}`).join('\n') +
          '\nTriage each: inspect the session, act or relay. If it needs the operator, tell them in chat starting with the NEEDS YOU banner and set the note needs_you=true. Never use PushNotification.',
      }),
    )
    .catch(() => {
      pendingWakes.unshift(...lines)
    })
}

function render(list: FleetRow[], now: number): string {
  return list.length === 0
    ? 'No sessions tracked.'
    : list
        .map(
          r =>
            `${r.needsYou ? '!!' : '  '} ${r.ticket.padEnd(9)} ${shown(r).padEnd(12)} $${r.costUsd.toFixed(2)} ` +
            `${ago(r.updatedAt, now)}  ${r.label}${r.note ? ` | ${r.note}` : ''}${r.error ? ` | poll error: ${r.error}` : ''}`,
        )
        .join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Restore across a process restart: $.state is the session's, $.store
    // outlives it. Prefer whichever has rows.
    const saved = (await $.store.get(STORE_KEY)) as FleetRow[] | undefined
    if (saved?.length && (await read($, rows)).length === 0) {
      await update($, rows, () => saved)
    }

    await $.command.register({ name: 'fleet', description: 'Open the session fleet dashboard' })
    await $.tool.register({
      name: 'track',
      description:
        'Add (or relabel) a cloud session on the fleet dashboard. Call right after create_session.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          ticket: { type: 'string', description: 'Jira key the session serves' },
          label: { type: 'string', description: 'Few-word description of the work' },
        },
        required: ['session_id', 'ticket', 'label'],
      },
    })
    await $.tool.register({
      name: 'note',
      description:
        "Set a row's note. needs_you=true flags it as waiting on the operator (e.g. merge approval, a decision); false clears the flag.",
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          note: { type: 'string' },
          needs_you: { type: 'boolean' },
        },
        required: ['session_id', 'note'],
      },
    })
    await $.tool.register({
      name: 'untrack',
      description:
        'Close out a child session: ARCHIVES it (archive_session) and removes it from the fleet dashboard. ' +
        'Claude is responsible for the sessions it spins up and closes them when their work is merged or abandoned. ' +
        'Refused while the session is WORKING or NEEDS_INPUT (archiving loses unpushed work). ' +
        'If archiving fails the row stays and its note carries the error. ' +
        'Pass keep_reason to remove the row WITHOUT archiving (the session stays open on purpose); the reason is recorded in the result.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          keep_reason: {
            type: 'string',
            description: 'Why the session stays open. Omit to archive it; set to untrack it without archiving.',
          },
        },
        required: ['session_id'],
      },
    })
    await $.tool.register({
      name: 'open_children',
      description:
        'List the child sessions not yet closed out (still tracked), as text: a header line `Open fleet children: N` then one `- ` line per session. Read-only; session-close uses it.',
    })
    await $.tool.register({
      name: 'status',
      description: 'Return the fleet dashboard as text (forces a fresh poll first).',
    })

    // Poll on a timer that outlives any single dispatch; it is cancelled
    // automatically when the module reloads.
    $.clock.every(POLL_MS, () => {
      void poll($)
    })
    void poll($)
    void $.ui.open({ id: PANE, title: 'Fleet' })

    return next(e)
  })

  // Auto-track (LC-1834): every session this orchestrator creates lands on the
  // dashboard without a step to forget. An explicit `track` later relabels it.
  on('tool.call', { tool: 'mcp__claude-code-remote__create_session' }, async ($, e: any, next) => {
    // LC-1843: the child may report back without stalling on an unwatched permission prompt.
    const res: any = await next(withChildTools(e))
    try {
      if (res.isError || res.deny) return res
      const id = childIdOf(String(res.text ?? JSON.stringify(res.result ?? '')), await ownId($))
      if (!id) return res
      const ticket = ticketOf(e.title, e.prompt)
      const label = String(e.title || e.prompt || 'auto-tracked').replace(/\s+/g, ' ').slice(0, 60)
      let added = false
      await mutate($, cur => {
        if (cur.some(r => r.sessionId === id)) return cur
        added = true
        return [...cur, blankRow(id, ticket, label)]
      })
      if (!added) return res
      void poll($)
      const msg = say($, `Auto-tracking ${id} as ${ticket}; call mcp__fleet-tracker__track to relabel it.`)
      return { ...res, context: [...(res.context ?? []), msg] }
    } catch {
      return res // tracking must never cost the orchestrator its create_session result
    }
  }).catch(($, e, next) => next(e)) // replay-safe: never re-runs create_session, never refuses it

  on('tool.call', { tool: 'mcp__fleet-tracker__track' }, async ($, e: any) => {
    await mutate($, list => {
    const existing = list.find(r => r.sessionId === e.session_id)
    const row: FleetRow = {
      ...existing,
      sessionId: e.session_id,
      ticket: e.ticket,
      label: e.label,
      bucket: existing?.bucket ?? '',
      status: existing?.status ?? '',
      summary: existing?.summary ?? '',
      costUsd: existing?.costUsd ?? 0,
      updatedAt: existing?.updatedAt ?? '',
      checkedAt: 0,
      note: existing?.note ?? '',
      needsYou: existing?.needsYou ?? false,
      error: '',
    }
    return [...list.filter(r => r.sessionId !== e.session_id), row]
    })
    void poll($)
    return { result: say($, `Tracking ${e.session_id} as ${e.ticket}.`) }
  })

  on('tool.call', { tool: 'mcp__fleet-tracker__note' }, async ($, e: any) => {
    const flag = e.needs_you === true
    let found = false
    await mutate($, list =>
      list.map(r => {
        if (r.sessionId !== e.session_id) return r
        found = true
        return { ...r, note: e.note, needsYou: e.needs_you === undefined ? r.needsYou : flag }
      }),
    )
    if (!found) return { result: say($, `Not tracked: ${e.session_id}; the note was not saved.`) }
    return { result: say($, flag ? `Needs you: ${e.note}` : `Noted on ${e.session_id}.`, flag) }
  })

  on('tool.call', { tool: 'mcp__fleet-tracker__untrack' }, async ($, e: any) => {
    const id = String(e.session_id)
    const keep = typeof e.keep_reason === 'string' ? e.keep_reason.trim() : ''
    const drop = () => {
      lastWoken.delete(id)
      stallOf.delete(id)
      closeoutClaim.delete(id)
      waitClaim.delete(id)
      return mutate($, list => list.filter(r => r.sessionId !== id))
    }
    // Deliberately kept open: no archive, the reason goes in the result for the record.
    if (keep) {
      await drop()
      return { result: say($, `Untracked ${id} WITHOUT archiving; kept open because: ${keep}`) }
    }
    // Judge the bucket from a fresh poll, not a row up to 90 s old.
    const row = (await poll($)).find(r => r.sessionId === id)
    if (!row) return { result: say($, `Not tracked: ${id}; nothing archived. Archive it directly with archive_session if it is yours.`) }
    if (row.error) {
      return {
        result: say($, `Refused: could not read ${row.ticket}'s current state (${row.error}); archiving blind could destroy unpushed work. Not archived, still tracked. Retry, or pass keep_reason to untrack without archiving.`),
      }
    }
    if (!CLOSABLE_BUCKETS.has(row.bucket)) {
      return {
        result: say($, `Refused: ${row.ticket} is ${row.bucket || 'not yet polled'}; only a COMPLETED or REVIEW_READY session is archived (anything else may still hold unpushed work). Not archived, still tracked. Wait for it to finish, or pass keep_reason to untrack without archiving.`),
      }
    }
    const archived: { isError?: boolean } & { content: readonly unknown[] } = await $.mcp
      .call(SERVER, 'archive_session', { session_id: id })
      .catch((err: unknown) => ({ isError: true, content: [{ type: 'text', text: String(err) }] }))
    if (archived.isError) {
      const err = textOf(archived).slice(0, 200) || 'archive_session failed'
      // Never read meaning into error text (CI review, PR #1816). Archiving an archived
      // session succeeds outright (measured 2026-10-15), so an error is a real failure,
      // unless the session's OWN status now reads ARCHIVED (e.g. it was archived meanwhile).
      if (await isArchived($, id)) {
        await drop()
        return { result: say($, `${id} is archived (its status says so); untracked.`) }
      }
      // In `error`, not `note`: a failed archive must not clobber a person's note.
      await mutate($, list => list.map(r => (r.sessionId === id ? { ...r, error: `archive failed: ${err}` } : r)))
      return { result: say($, `Archive of ${id} failed, row kept: ${err}`) }
    }
    await drop()
    return { result: say($, `Archived and untracked ${id}.`) }
  })

  // Rows not yet closed out, for session-close's obligation. Read-only, so no callout prefix.
  on('tool.call', { tool: 'mcp__fleet-tracker__open_children' }, async $ => {
    const list: FleetRow[] = await read($, rows)
    return {
      result:
        `Open fleet children: ${list.length}` +
        list.map(r => `\n- ${r.ticket} (${r.label}) ${r.bucket || 'pending'} ${r.sessionId}`).join(''),
    }
  })

  on('tool.call', { tool: 'mcp__fleet-tracker__status' }, async $ => {
    const list = await poll($)
    return { result: render(list, await $.clock.now()) }
  })

  // Deliver wakes a tool-call poll could not submit, as soon as the turn ends.
  on('turn.complete', async ($, e, next) => {
    const res = await next(e)
    flushWakes($)
    return res
  })

  on('command.run', { command: 'fleet' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Fleet' })
    return { text: 'Fleet dashboard opened.' }
  })

  // The full dashboard.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list: FleetRow[] = await read($, rows)
    const now = await $.clock.now()
    if (list.length === 0) return <Text dimColor>No sessions tracked yet.</Text>
    return (
      <Box flexDirection="column">
        {list.map(r => (
          <Box flexDirection="column" key={r.sessionId}>
            <Text bold color={r.needsYou || r.stallEscalated ? 'error' : r.nudgedAt ? 'warning' : r.bucket === 'WORKING' ? 'suggestion' : 'text'} wrap="truncate-end">
              {r.needsYou ? 'NEEDS YOU  ' : ''}{r.ticket}  {shown(r)}  ${r.costUsd.toFixed(2)}  {ago(r.lastActivity || r.updatedAt, now)} ago
            </Text>
            <Text dimColor wrap="truncate-end">  {r.label}{r.summary ? ` — ${r.summary}` : ''}</Text>
            {r.note ? <Text color={r.needsYou ? 'warning' : 'subtle'} wrap="wrap">  {r.note}</Text> : null}
            {r.error ? <Text color="warning" wrap="truncate-end">  poll error: {r.error}</Text> : null}
          </Box>
        ))}
      </Box>
    )
  })

  // One-line band above the prompt so the fleet is visible without the pane.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list: FleetRow[] = await read($, rows)
    if (list.length === 0 || e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const count = (b: string) => list.filter(r => r.bucket === b).length
    const needs = list.filter(r => r.needsYou)
    return (
      <Box>
        <Text color={needs.length ? 'error' : 'subtle'}>
          Fleet: {count('WORKING')} working · {count('REVIEW_READY')} review · {count('COMPLETED')} done
          {list.some(r => r.stallEscalated) ? ` · STALLED: ${list.filter(r => r.stallEscalated).map(r => r.ticket).join(', ')}` : ''}
          {needs.length ? ` · NEEDS YOU: ${needs.map(r => r.ticket).join(', ')}` : ''}
        </Text>
      </Box>
    )
  })
}
