import type { Register } from 'claude-code'

import { askFor } from './logic'

// Why (LCH-528): money-moving and destructive tools were a sentence in the operator's preferences. This
// puts the call in front of them through the engine's own permission prompt. The list is ./logic.ts.
export const register: Register = on => {
  on('classic.PreToolUse', { tool: /^mcp__/ }, async ($, e, next) => {
    const ask = askFor(String((e as any).tool ?? ''))
    if (ask === undefined) return next(e)
    try { $.ui.toast(ask) } catch { /* a toast never changes the ask */ }
    return { ask }
  // Fail open: a bug here must never stop a tool call.
  }).catch(($, e, next) => next(e))
}
