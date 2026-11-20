import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { claimOf, finishes, inputOf, judge, OWN, READ_ONLY, roominateTool } from './logic'
import type { Order } from '../types'

// Why (LC-2296): see ./logic.ts. This file records the order a claim returns (and drops it when the order is
// finished), then asks ./logic.ts about every Roominate call.
// Kept in $.state only: a container restart forgets the claim, so the generating calls are refused until the
// task claims again. That is the safe direction; the task is short and one order per run.

const order = atom({ plugin: 'roominate-order-guard', key: 'order' } as const, null as Order | null)

function toast($: any, text: string): void {
  try { $.ui.toast(text.split('\n')[0]!.slice(0, 200)) } catch { /* a toast never changes a verdict */ }
}

function textOf(ran: { text?: unknown; result?: unknown }): string {
  if (typeof ran.text === 'string') return ran.text
  try { return JSON.stringify(ran.result ?? '') } catch { return '' }
}

export const register: Register = on => {
  // Record a claim of a pick_images order, and close it when the session finishes the order.
  on('tool.call', { tool: /^mcp__Supabase\w*__execute_sql$/ }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const tool = String((e as any).tool ?? '')
    const sql = String((e as any).query ?? '')
    if (finishes(tool, sql)) {
      await update($, order, () => null)
      return ran
    }
    const claimed = claimOf(tool, sql, textOf(ran))
    if (claimed) await update($, order, () => claimed)
    return ran
  // Recording never changes the SQL call's outcome. A missed claim only means a later refusal (the safe side).
  }).catch(($, e, next) => next(e))

  on('classic.PreToolUse', { tool: /^mcp__.*roominate.*__/i }, async ($, e, next) => {
    const name = roominateTool(String((e as any).tool ?? ''))
    if (name === undefined) return next(e)
    const held = (await read($, order)) ?? undefined
    const v = judge(name, inputOf(e as any), held)
    if (!v.allow) {
      toast($, v.reason)
      return { deny: v.reason }
    }
    // Count the spend before the call: a failed generation may still be charged, so it stays counted.
    if (v.cost > 0 && held) await update($, order, o => (o ? { ...o, spent: o.spent + v.cost } : o))
    return next(e)
  // STRICT (operator decision 2026-11-19): unlike most mods this one fails CLOSED. A bug refuses the image
  // call with a visible reason rather than letting tokens be spent off the order path.
  }).catch(($, e, next) => {
    const name = roominateTool(String((e as any).tool ?? ''))
    if (name === undefined || READ_ONLY.has(name)) return next(e)
    const reason = `${OWN} REFUSED: the guard could not evaluate \`${name}\`, so it was not run (fails closed). ` +
      `Read-only Roominate tools are unaffected; report this to the Tools & Services track (LC-2141).`
    return { deny: reason }
  })
}
