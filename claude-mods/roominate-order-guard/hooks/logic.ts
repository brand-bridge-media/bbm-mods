// Why (LC-2296, operator decision 2026-11-19: strict): Roominate images are made only by a queued image order
// (LC-2279: a `pick_images` order in Supabase, worked by the "Roominate image orders" scheduled task). On
// 2026-11-19 a session (LC-2293) made 4 images with direct connector calls and so skipped the order's token
// ceiling, the cost/balance statement and the same-product check (40 tokens). A rule in a skill did not stop
// it; this mod does. Pure decisions live here; ./register.ts only records the claim and asks these functions.

export const OWN = '[mod:roominate-order-guard]'

/** Roominate tools that never spend tokens or change an image. Everything else on the server is gated. */
export const READ_ONLY = new Set([
  'get_token_balance', 'list_library', 'list_products', 'list_spaces', 'list_styles', 'get_image',
  'check_video', 'find_store_product',
  // Free catalogue intake (no tokens, no image made); the order task needs it for a missing product.
  'create_product',
])

/** The one image tool the order task uses (TASK_PROMPT.md step 4b). Every other writer is refused outright. */
export const ORDER_TOOL = 'create_from_product'

/** Tokens per image by resolution (roominate-product-imagery §8). An omitted resolution is charged as 2K. */
export const COST: Record<string, number> = { '1K': 5, '2K': 10, '4K': 15 }

import type { Order } from '../types'
export type { Order }

/** The Roominate tool's short name, or undefined when the call is not on a Roominate server. */
export function roominateTool(tool: string): string | undefined {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (!m || !/roominate/i.test(m[1]!)) return undefined
  return m[2]!
}

const SQL_TOOL = /^mcp__Supabase\w*__execute_sql$/
// The WHOLE statement must be the call (LC-2296 review finding 1): a comment, a string or a second statement that merely
// mentions claim_refresh_order('pick_images' must not open an order. Same for the finish.
const CLAIM = /^\s*select\s+\*\s+from\s+(?:public\.)?claim_refresh_order\s*\(\s*'pick_images'\s*,\s*'[\w-]*'\s*\)\s*;?\s*$/i
const FINISH = /^\s*select\s+(?:public\.)?finish_refresh_order\s*\(\s*'[0-9a-f-]{36}'\s*,\s*'[0-9a-f-]{36}'\s*,[^;]*\)\s*;?\s*$/i
// The result comes back as JSON text, often with its quotes escaped once or twice; tolerate the backslashes.
const Q = String.raw`\\*"`
const ORDER_ID = new RegExp(`${Q}order_id${Q}\\s*:\\s*${Q}([0-9a-f-]{36})`, 'i')
const CLAIM_ID = new RegExp(`${Q}claim_id${Q}\\s*:\\s*${Q}([0-9a-f-]{36})`, 'i')
const CEILING = new RegExp(`${Q}limits${Q}\\s*:\\s*\\{[^}]*?${Q}tokens${Q}\\s*:\\s*(\\d+)`, 'i')

/** The order a successful claim returned, or undefined (not a claim, or the queue was empty). */
export function claimOf(tool: string, sql: string, resultText: string): Order | undefined {
  if (!SQL_TOOL.test(tool) || !CLAIM.test(sql)) return undefined
  const orderId = ORDER_ID.exec(resultText)?.[1]
  const claimId = CLAIM_ID.exec(resultText)?.[1]
  if (!orderId || !claimId) return undefined
  const c = CEILING.exec(resultText)?.[1]
  return { orderId, claimId, ceiling: c === undefined ? null : Number(c), spent: 0 }
}

/** True when the call finishes an order (the claim then closes, so nothing more can be generated). */
export function finishes(tool: string, sql: string): boolean {
  return SQL_TOOL.test(tool) && FINISH.test(sql)
}

/** Tokens the call will cost. An unknown resolution is charged at the highest price, so it can never slip under. */
export function costOf(input: Record<string, unknown>): number {
  const r = String(input.resolution ?? '2K').toUpperCase()
  return COST[r] ?? Math.max(...Object.values(COST))
}

export type Verdict = { allow: true; cost: number } | { allow: false; reason: string }

/** The tool's arguments from a hook event: a nested input object if the event carries one, else its own keys. */
export function inputOf(e: Record<string, unknown>): Record<string, unknown> {
  for (const k of ['tool_input', 'input', 'arguments']) {
    const v = e[k]
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  }
  return e
}

/** The decision for one Roominate call, given the order this session holds (if any). */
export function judge(name: string, input: Record<string, unknown>, order: Order | undefined): Verdict {
  if (READ_ONLY.has(name)) return { allow: true, cost: 0 }
  const how = 'Place a `pick_images` order instead (scripts/roominate-image-orders/README.md, step 1, with the operator\'s ' +
    'token ceiling in approval.limits.tokens); the "Roominate image orders" task makes the images, checks them and reports.'
  if (name !== ORDER_TOOL) {
    return { allow: false, reason: `${OWN} REFUSED: \`${name}\` is never used for our images. Roominate images come only ` +
      `from a queued image order, and the order task makes them with \`${ORDER_TOOL}\` alone (operator decision ` +
      `2026-11-19, LC-2296). ${how}` }
  }
  if (!order) {
    return { allow: false, reason: `${OWN} REFUSED: no queued image order is claimed in this session, so \`${name}\` ` +
      `would spend Roominate tokens outside the order path (no ceiling, no cost check, no same-product check). ` +
      `Operator decision 2026-11-19 (LC-2296): images only through queued orders. ${how}` }
  }
  if (order.ceiling === null || !Number.isFinite(order.ceiling)) {
    return { allow: false, reason: `${OWN} REFUSED: order ${order.orderId} has no token ceiling ` +
      `(payload.approval.limits.tokens). Finish it blocked; the operator's ceiling is required.` }
  }
  const cost = costOf(input)
  if (order.spent + cost > order.ceiling) {
    return { allow: false, reason: `${OWN} REFUSED: this image costs ${cost} tokens and order ${order.orderId} has ` +
      `${order.ceiling - order.spent} of its ${order.ceiling}-token ceiling left (${order.spent} spent). Report the ` +
      `remaining lines not_checked with reason "token ceiling reached" and finish the order.` }
  }
  return { allow: true, cost }
}
