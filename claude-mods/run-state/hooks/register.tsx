import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { RunView } from '../types'
import {
  LIST_ACTIVE_SQL,
  PY_HELPER,
  REST_ACTIVE_QS,
  SQL_TOOL,
  UUID,
  bandText,
  decide,
  mayWriteRunState,
  pinClause,
  sameRun,
  receiptWritesInBash,
  receiptWritesInSql,
  restRowQs,
  restUrl,
  rowSql,
  rowsFromMcp,
  rowsFromRest,
  viewFromHelper,
  worst,
} from './logic'
import type { WriteTarget } from './logic'

// run-state (LC-1715, epic LC-1074). Two jobs on one source of truth:
//   1. a band above the prompt: run, stage, next READY section, Pass A age, missing receipts;
//   2. a guard that refuses a receipt write for a section the conductor has not marked READY,
//      and ASKS (never allows) when it cannot read the plan.
// Business analogy: the band is the job board on the wall; the guard is the foreman who will
// not let a worker sign off a job whose predecessor is not finished.
//
// Plan source: refresh_conductor.py cannot run live in a cloud session (no SUPABASE_* in the
// shell), so the mod reads the run row itself (Supabase MCP, else PostgREST when SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are set) and gives it to the conductor's own evaluate() (see PY_HELPER in logic.ts). Re-implementing the DAG would drift.

const REFRESH_MS = 120_000
const ALLOW = 'Allow this write'

const view = atom({ plugin: 'run-state', key: 'view' } as const, null as RunView | null)
const pin = atom({ plugin: 'run-state', key: 'pin' } as const, '')
const error = atom({ plugin: 'run-state', key: 'error' } as const, '')
const idleAt = atom({ plugin: 'run-state', key: 'idleAt' } as const, 0)

type Opts = { supabaseServer: string; projectId: string; conductorPath: string }

// One read, two ways in (LC-1711). A cloud build session has no Supabase MCP server, so the MCP is
// tried first (it is how the mod always worked) and PostgREST with SUPABASE_URL +
// SUPABASE_SERVICE_ROLE_KEY second, the way the bulk-operations tools read refresh_runs. Every path
// that fails is named in the error, because that text is what the "ask" shows a person: they can
// see what was tried instead of guessing. The key never appears in a message.
// `active`: this is the "which runs are active" list. Over PostgREST an empty answer cannot be told
// from a key that simply cannot see the table (row-level security answers [] , not an error), so it is
// a failed path there, never "no active run" (which would switch the guard off).
type Q = { sql: string; rest: string; active?: boolean }

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/^run-state: /, '')

async function viaMcp($: any, o: Opts, q: Q): Promise<unknown[]> {
  const res = await $.mcp.call(o.supabaseServer, 'execute_sql', { project_id: o.projectId, query: q.sql })
  if (res.isError) throw new Error('execute_sql returned an error')
  return rowsFromMcp(res.content)
}

async function viaRest($: any, q: Q): Promise<unknown[]> {
  const base = await $.env.get('SUPABASE_URL')
  const key = await $.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!base || !key) {
    throw new Error(`${[!base && 'SUPABASE_URL', !key && 'SUPABASE_SERVICE_ROLE_KEY'].filter(Boolean).join(' and ')} not set`)
  }
  const res = await $.http.fetch(restUrl(base, q.rest), {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const rows = rowsFromRest(res.text)
  if (q.active && rows.length === 0) {
    throw new Error('returned no active runs (an empty list cannot be told from a key that cannot see refresh_runs), so it is not trusted as "no active run"')
  }
  return rows
}

async function sql($: any, o: Opts, q: Q): Promise<unknown[]> {
  const tried: string[] = []
  try {
    return await viaMcp($, o, q)
  } catch (err) {
    tried.push(`Supabase MCP server "${o.supabaseServer}": ${msg(err)}`)
  }
  try {
    return await viaRest($, q)
  } catch (err) {
    tried.push(`PostgREST: ${msg(err)}`)
  }
  throw new Error(`no read path worked; tried ${tried.join('; ')}`)
}

// Reads one run's row and asks the conductor what is READY. `which` is a run id or slug; absent,
// it is the pin, else the only active run. Returns null when there is NO active run (and nothing
// was asked for); throws with a reason when any step fails, which callers turn into "ask".
async function loadView($: any, o: Opts, which?: string): Promise<RunView | null> {
  const wanted = which ?? (await read($, pin))
  let q: Q
  if (wanted) {
    const clause = pinClause(wanted)
    const rest = restRowQs(wanted)
    if (!clause || !rest) throw new Error(`"${wanted}" is not a run id or slug`)
    q = { sql: rowSql(clause), rest }
  } else {
    const active = (await sql($, o, { sql: LIST_ACTIVE_SQL, rest: REST_ACTIVE_QS, active: true })) as { id: string; article_slug: string }[]
    if (active.length === 0) return null
    if (active.length > 1) {
      throw new Error(`${active.length} active runs (${active.map(r => r.article_slug).join(', ')}); pin one with /run-state <slug>`)
    }
    // Same shape gate as a pin: an id that is not a UUID never reaches SQL.
    if (!UUID.test(String(active[0].id))) throw new Error('active run id is not a UUID')
    const id = String(active[0].id)
    q = { sql: rowSql(`id = '${id}'`), rest: restRowQs(id) as string }
  }
  const rows = await sql($, o, q)
  if (rows.length !== 1) throw new Error(`run not found for ${wanted || q.sql}`)
  const ran = await $.process.run(['python3', '-I', '-c', PY_HELPER, o.conductorPath], {
    stdin: JSON.stringify(rows[0]),
    timeoutMs: 30_000,
  })
  if (ran.exitCode !== 0) throw new Error(`conductor failed: ${String(ran.stderr).trim().slice(-200) || `exit ${ran.exitCode}`}`)
  return viewFromHelper(ran.stdout, await $.clock.now())
}

type Read = { v: RunView | null; idle: boolean }

// Never throws. Stores the view, or why there is none. `idle` = no active run: not an error, the
// guard is inert and the band is blank. A fresh idle result is reused for REFRESH_MS unless forced.
async function refresh($: any, o: Opts, force = false): Promise<Read> {
  try {
    const now = await $.clock.now()
    const stamp = await read($, idleAt)
    if (!force && stamp && now - stamp < REFRESH_MS && (await read($, pin)) === '') return { v: null, idle: true }
    const v = await loadView($, o)
    await update($, error, () => '')
    await update($, view, () => v)
    await update($, idleAt, () => (v ? 0 : now))
    return { v, idle: v === null }
  } catch (err) {
    await update($, error, () => (err instanceof Error ? err.message : String(err)))
    await update($, idleAt, () => 0)
    return { v: null, idle: false }
  }
}

// Callout convention (LC-1711): every deny / ask / changed-state message starts with `[mod:run-state]`
// (that text reaches the model in the tool result, so it can say who acted) and fires a toast naming
// the mod and the reason (so the operator sees it too). One helper keeps the two together.
const MOD = 'run-state'
function say($: any, reason: string): string {
  const text = `[mod:${MOD}] ${reason.replace(/^run-state: /, '')}`
  try {
    $.ui.toast(text.length > 160 ? `${text.slice(0, 157)}...` : text)
  } catch { /* a toast must never be the reason a guard fails */ }
  return text
}

export const register: Register = (on, options) => {
  const o = options as unknown as Opts
  let lastTry = 0

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'run-state',
      description: 'Pin the refresh run the band and guard follow: /run-state <slug|run_id|clear>',
    })
    void refresh($, o, true)
    return next(e)
  })

  on('command.run', { command: 'run-state' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'clear') {
      await update($, pin, () => '')
      say($, 'run pin cleared; the band and guard follow the only active run')
    } else if (arg !== '') {
      if (!pinClause(arg)) return { text: say($, `"${arg}" is not a run id or article slug; the pin is unchanged.`) }
      await update($, pin, () => arg)
      say($, `pinned to ${arg}; the band and receipt guard now follow it`)
    }
    const r = await refresh($, o, true)
    if (r.idle) return { text: 'run-state: no active refresh run.' }
    if (!r.v) return { text: `run-state: plan unreadable (${await read($, error)}). Receipt writes will ask.` }
    return { text: bandText(r.v, await $.clock.now()) }
  })

  // The guard, and the band's after-every-write refresh, in one hook so a write is judged against
  // a plan read just before it and the band is re-read just after it. Everything before next(e) is
  // inside one try (any surprise there refuses the write); the refresh after it is in its own, so
  // no error can send control back through next(e) and run a write twice. Hence no .catch here.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const command = tool === 'Bash' ? String((e as { command?: unknown }).command ?? '') : ''
    const query = SQL_TOOL.test(tool) ? String((e as { query?: unknown }).query ?? '') : ''
    const bashTargets = command ? receiptWritesInBash(command) : []
    const sqlSuspect = query !== '' && mayWriteRunState(tool, query)
    if (bashTargets.length === 0 && !sqlSuspect) return next(e)

    try {
      const def = await refresh($, o)
      // No active run: nothing to enforce, unless the write NAMES a run. A named run is judged
      // against its own plan below, so an empty active list never waves a named write through.
      if (def.idle) {
        const named = [...bashTargets, ...(sqlSuspect ? receiptWritesInSql(tool, query, []) : [])].some(t => t.run)
        if (!named) return next(e)
      }

      let concern: string | null = null
      if (!def.v && !def.idle) {
        // Fail closed: an unreadable plan means "a person decides", not "go ahead".
        concern = `run-state: cannot read the refresh plan (${await read($, error)}); confirm this receipt write.`
      } else {
        const targets: WriteTarget[] = [
          ...bashTargets,
          ...(sqlSuspect ? receiptWritesInSql(tool, query, def.v ? def.v.table.map(t => t.id) : []) : []),
        ]
        // A write that names a run is judged against THAT run's plan, not the pinned / only active one.
        const plans = new Map<string, RunView | null>()
        const decisions = []
        for (const t of targets) {
          if (def.idle && !t.run) continue // idle: only writes that name a run are gated
          let v: RunView | null = def.v
          if (t.run && (!v || !sameRun(v, t.run))) {
            if (!plans.has(t.run)) {
              try { plans.set(t.run, await loadView($, o, t.run)) } catch { plans.set(t.run, null) }
            }
            v = plans.get(t.run) ?? null
            if (!v) {
              concern = `run-state: cannot read the plan for run ${t.run} that this write names; confirm this receipt write.`
              continue
            }
          }
          decisions.push(decide(v as RunView, t))
        }
        const d = decisions.length ? worst(decisions) : null
        if (d?.action === 'deny') return { deny: say($, d.reason) }
        if (d?.action === 'ask' && concern === null) concern = d.reason
      }
      if (concern !== null) {
        // The engine's own question dialog. Dismissed, or nobody to ask (-p run): refuse.
        const asking = say($, concern)
        let choice = ''
        try {
          choice = await $.ui.ask(`${asking} Allow this write?`, [ALLOW, 'Refuse'])
        } catch {
          return { deny: `${asking} (no one answered; refused)` }
        }
        if (choice !== ALLOW) return { deny: `${asking} (refused)` }
      }
    } catch (err) {
      return { deny: say($, `guard failed (${err instanceof Error ? err.message : String(err)}); refused.`) }
    }

    const ran = await next(e)
    if (ran.deny === undefined) {
      try { await refresh($, o, true) } catch { /* the band stays as it was; the write already ran */ }
    }
    return ran
  })

  // Receipts also land from workflows and other sessions; keep the band honest between writes,
  // at most once per window (a persistent error or an idle result must not query every turn).
  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    if (now - lastTry >= REFRESH_MS) {
      lastTry = now
      void refresh($, o)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await read($, view)
    const why = await read($, error)
    if (e.props.hasSurvey || (!v && !why)) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        {v ? <Text dimColor>{bandText(v, await $.clock.now())}</Text> : null}
        {why ? <Text color="yellow">{v ? ' · ' : ''}plan unreadable ({why.length > 140 ? `${why.slice(0, 137)}...` : why}); receipt writes will ask</Text> : null}
      </Box>
    )
  }).catch(($, e, next) => next(e))
}
