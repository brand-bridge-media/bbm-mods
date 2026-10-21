import type { Register } from 'claude-code'

import type { HookOut } from './py'
import { blockReason, contextOf, decisionOf, parseOut, resultText, runArgs, toastText, toolPayload } from './py'

// Why (LCH-528, LC-1683): a bulk write to a production table belongs in a data-changes/ package
// (dry-run counts on the PR, CI apply, ledger, rollback), not a session. A hook cannot count rows,
// so the write must bound itself by id in its own text. Logic and tests: ./bulk-write-guard.py.
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
  on('classic.PreToolUse', { tool: /^mcp__.*__execute_sql$/ }, async ($, e, next) =>
    preToolUse($, await runCheck($, 'bulk-write-guard.py', toolPayload(e as any))) ?? next(e),
  // Fail open: a bug in the mod must never stop a tool call or a turn (runCheck already fails open).
  ).catch(($, e, next) => next(e))
}
