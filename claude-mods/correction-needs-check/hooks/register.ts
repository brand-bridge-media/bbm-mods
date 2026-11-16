import type { Register } from 'claude-code'

import type { HookOut } from './py'
import { decisionOf, parseOut, runArgs, toolPayload } from './py'

// Why (LC-2151): a correction written only as prose (a memory, a CLAUDE.md "Why this rule exists" block, a skill
// paragraph) gets missed, and the same lesson is re-learned. The rule is "every correction ends as a check, or says why
// none can"; this asks for that at the moment the correction is written down. Advisory by construction, like
// oversized-file-nudge: only a note can come back, the write always runs, and a failure here changes nothing.
// Cheap prefilters keep the Python check off ordinary calls; ./correction-needs-check.py decides.
const MEMORY_INSERT = /insert\s+into\s+(public\.)?knowledge_memories/i
const MAYBE_FILE = /(^|[\\/])(CLAUDE\.md|SKILL\.md)$|[\\/]memory[\\/].+\.md$/

async function runCheck($: any, script: string, payload: unknown): Promise<HookOut | undefined> {
  try {
    const { argv, init } = runArgs($.plugin.root, script, payload)
    return parseOut(await $.process.run(argv, init))
  } catch {
    return undefined
  }
}

async function nudge($: any, e: any, next: any) {
  const d = decisionOf(await runCheck($, 'correction-needs-check.py', toolPayload(e)))
  // Anything but a note is ignored, so this mod can never deny or ask. The call runs first; the note rides along.
  if (!d || !('additionalContext' in d)) return next(e)
  const ran = await next(e)
  return { ...ran, additionalContext: [...((ran as any).additionalContext ?? []), ...d.additionalContext] }
}

export const register: Register = on => {
  on('classic.PreToolUse', { tool: /^(Write|Edit|MultiEdit)$/ }, async ($, e, next) =>
    MAYBE_FILE.test(String((e as any).file_path ?? '')) ? nudge($, e, next) : next(e),
  // Fail open: a bug in the mod must never stop a tool call or a turn.
  ).catch(($, e, next) => next(e))
  on('classic.PreToolUse', { tool: /^mcp__.*__execute_sql$/ }, async ($, e, next) =>
    MEMORY_INSERT.test(String((e as any).query ?? '')) ? nudge($, e, next) : next(e),
  ).catch(($, e, next) => next(e))
}
