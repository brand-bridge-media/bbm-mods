import type { Register } from 'claude-code'

import { CREATE_SESSION, verdictFor } from './logic'

// Why (LC-1917): see ./logic.ts. Same shape as spend-delete-ask: the engine's own permission prompt
// carries the ask (an unanswered ask refuses), and the text is toasted so the operator sees it too.
export const register: Register = on => {
  on('classic.PreToolUse', { tool: CREATE_SESSION }, async ($, e, next) => {
    const v = verdictFor((e as any) ?? {})
    if (v === undefined) return next(e)
    try { $.ui.toast('deny' in v ? v.deny : v.ask) } catch { /* a toast never changes a verdict */ }
    return v
  // Fail open: a bug here must never stop a tool call.
  }).catch(($, e, next) => next(e))
}
