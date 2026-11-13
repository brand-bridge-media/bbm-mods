import type { Register } from 'claude-code'

import type { HookOut } from './py'
import { blockReason, contextOf, decisionOf, parseOut, resultText, runArgs, toastText, toolPayload } from './py'

// Why (LC-2140): the operator decided on 2026-11-13 that every new LC ticket belongs to an epic;
// 369 had been filed without one, mostly by sessions through the Atlassian MCP connector. The
// matcher is by suffix so a renamed Atlassian server still matches; ./jira-epic-guard.py decides
// (project LC, issue type, parent) and reads the epic list from ./epics.json.
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
  on('classic.PreToolUse', { tool: /createJiraIssue$|^mcp__Atlassian\w*__executeWrite$/ }, async ($, e, next) =>
    preToolUse($, await runCheck($, 'jira-epic-guard.py', toolPayload(e as any))) ?? next(e),
  // Fail open: a bug in the mod must never stop a tool call or a turn (runCheck already fails open).
  ).catch(($, e, next) => next(e))
}
