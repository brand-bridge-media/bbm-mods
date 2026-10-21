import type { Register } from 'claude-code'

import type { HookOut } from './py'
import { blockReason, contextOf, decisionOf, parseOut, resultText, runArgs, toastText, toolPayload } from './py'

// Why (LCH-531; LCH-104, LCH-530): Supabase exposure rules R1-R5 (table RLS, view security_invoker,
// SECURITY DEFINER revoke + search_path, grants to anon/authenticated, function search_path). Same
// rules as the PR gate (supabase/tools/supabase_rules.py, a byte-identical copy here). Only SQL tools
// carrying DDL or a grant, and migration-file writes, start the check.
const MIGRATION = /(^|[\\/])supabase[\\/]migrations[\\/][^\\/]+\.sql$/
const SQL_TOOL = /^mcp__.*__(execute_sql|apply_migration)$/

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
  on('classic.PreToolUse', { tool: /^(Write|Edit|MultiEdit|mcp__.*__(execute_sql|apply_migration))$/ }, async ($, e, next) => {
    const tool = String((e as any).tool ?? '')
    if (!SQL_TOOL.test(tool) && !MIGRATION.test(String((e as any).file_path ?? ''))) return next(e)
    // \b, not \s: `create/**/table` is still a CREATE TABLE (the Python lexer strips the comment).
    if (SQL_TOOL.test(tool) && !/\b(create|alter|grant|revoke)\b/i.test(String((e as any).query ?? ''))) return next(e)
    const v = preToolUse($, await runCheck($, 'supabase-guard.py', toolPayload(e as any)))
    if (!v) return next(e)
    if ('additionalContext' in v) {
      const ran = await next(e)
      return { ...ran, additionalContext: [...((ran as any).additionalContext ?? []), ...v.additionalContext] }
    }
    return v
  // Fail open: a bug in the mod must never stop a tool call (runCheck already fails open).
  }).catch(($, e, next) => next(e))
}
