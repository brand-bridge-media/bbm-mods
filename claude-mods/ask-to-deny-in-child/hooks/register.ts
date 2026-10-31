import type { Register } from 'claude-code'

import { answerFor, denyText, signalOf, type Signal } from './logic'

// Why (LC-1968): see ./logic.ts. One get_session per registration; a readable answer is cached, an
// unreadable one is retried and the prompt is left alone (reason on the debug log).
const SERVER = 'claude-code-remote'

export const register: Register = on => {
  let cached: Signal | undefined
  on('classic.PermissionRequest', async ($, e, next) => {
    let sig = cached
    if (!sig) {
      try {
        sig = signalOf(await $.mcp.call(SERVER, 'get_session', {}))
      } catch (err) {
        sig = { kind: 'unreadable', reason: `get_session call failed: ${String(err).slice(0, 80)}` }
      }
      if (sig.kind !== 'unreadable') cached = sig
    }
    if (sig.kind === 'unreadable') {
      try { $.ui.log(`ask-to-deny-in-child: left the prompt alone, signal unreadable (${sig.reason})`, { to: 'debug' }) } catch { /* never changes a verdict */ }
      return next(e)
    }
    const a = answerFor(sig, e)
    if (a === undefined) return next(e)
    try { $.ui.toast(denyText(e)) } catch { /* never changes a verdict */ }
    return a as any
  // Fail open: a bug here must never stop a prompt reaching a person.
  }).catch(($, e, next) => next(e))
}
