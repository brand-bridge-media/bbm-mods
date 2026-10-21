import type { Register } from 'claude-code'

import type { HookOut } from './py'
import { blockReason, contextOf, decisionOf, parseOut, resultText, runArgs, toastText, toolPayload } from './py'

// Why (LCH-528, operator hard rail: no browser-as-me): a session acting in the operator's logged-in
// browser acts with every account open in it and leaves no audit trail. The matcher is a cheap superset;
// ./no-browser-as-me.py decides (server segment, any casing).
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

export const register: Register = on => {
  on('classic.PreToolUse', { tool: /^Skill$|^mcp__.*(chrome|computer)/i }, async ($, e, next) =>
    preToolUse($, await runCheck($, 'no-browser-as-me.py', toolPayload(e as any))) ?? next(e),
  // Fail open: a bug in the mod must never stop a tool call or a turn (runCheck already fails open).
  ).catch(($, e, next) => next(e))
}
