import type { Register } from 'claude-code'

import type { HookOut } from './py'
import { blockReason, contextOf, decisionOf, parseOut, resultText, runArgs, toastText, toolPayload } from './py'

// Why (LC-1883): on 2026-10-21 Ahrefs flagged a 3 MB JPEG hero that a session set straight from the
// generator. An oversized image is caught BEFORE it is loaded into Webflow: CMS item writes and the
// asset upload tool are checked by HEAD (fallback ranged GET) for size and type. Logic and tests:
// ./image-weight-guard.py (selftest, stubbed probes, no network).
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

// Deny and ask are toasted for Stan; a warning is not.
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
  on('classic.PreToolUse', { tool: /^mcp__.*__(data_cms_tool|asset_tool)$/ }, async ($, e, next) =>
    preToolUse($, await runCheck($, 'image-weight-guard.py', toolPayload(e as any))) ?? next(e),
  // Fail open: a bug in the mod must never stop a tool call or a turn (runCheck already fails open).
  ).catch(($, e, next) => next(e))
}
