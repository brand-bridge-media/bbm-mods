// Which Jira writes are refused, and which calls count as reading a ticket's comments (LC-2118).
// Review by 2027-02-23: a ticket's title and status field go stale; LC-1345 was twice reported live
// from its title while its newest comment recorded it dormant since 2026-09-03 (LC-1496). Only the
// newest comment describes the STATE, so a write to a ticket needs a comment read first.
//
// Twin of .claude/hooks/jira-write-needs-read.py (regular repo sessions). claude.ai project threads
// load account mods, not repo hooks, so the rule lives here too. Same rule, v2 connector only: the
// v1 connector is removed from the account. On the v2 server getJiraIssue only COUNTS comments, so
// ONLY listJiraIssueComments is a comment read; getJiraIssue and a JQL search never count.

export const READ_TOOL = 'listjiraissuecomments'
export const WRITE_TOOLS = ['addoreditjiraissuecomment', 'editjiraissue', 'transitionjiraissue']
export const RUNNERS = ['executeread', 'executewrite', 'executedestructive']

/** Any Atlassian v2 tool; the leaf name decides. */
export const ATLASSIAN = /^mcp__Atlassian_MCP__\w+$/

const KEY_FIELDS = ['issueIdOrKey', 'issueKey', 'issue_key']

function leafOf(tool: string): string {
  return (tool.split('__').pop() ?? '').toLowerCase()
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** The call as the guard judges it: a runner call unwrapped to its operation name and inputs. */
function resolve(tool: string, input: Record<string, unknown>): { leaf: string; args: Record<string, unknown> } {
  const leaf = leafOf(tool)
  if (RUNNERS.includes(leaf) && typeof input.name === 'string' && isPlainObject(input.inputs)) {
    return { leaf: input.name.trim().toLowerCase(), args: input.inputs as Record<string, unknown> }
  }
  return { leaf, args: input }
}

/** The issue key a call targets, upper-cased so lc-1 and LC-1 are one ticket. */
export function issueKey(args: Record<string, unknown>): string | undefined {
  for (const f of KEY_FIELDS) {
    const v = args[f]
    if (typeof v === 'string' && v.trim() !== '') return v.trim().toUpperCase()
  }
  return undefined
}

/** The key this call counts as READING comments of, or undefined. */
export function readToRecord(tool: string, input: Record<string, unknown>): string | undefined {
  const { leaf, args } = resolve(tool, input)
  return leaf === READ_TOOL ? issueKey(args) : undefined
}

export function denyText(key: string, seen: string[]): string {
  return `[mod:jira-read-before-write] REFUSED: this session has not read ${key}'s comments, so it does not know ` +
    `the ticket's state, only its title, description and status field, which go stale (LC-1345 was twice reported live ` +
    `from its title while its newest comment recorded it dormant). Call this first, then retry:\n` +
    `  listJiraIssueComments(issueIdOrKey="${key}", orderBy="-created")\n` +
    `Read the NEWEST comment. getJiraIssue and a JQL search do not count as a comment read. ` +
    `Tickets whose comments this session has read: ${seen.length ? seen.join(', ') : 'none'}. (LC-2118)`
}

/** { deny } for a Jira write to a ticket with no recorded comment read, or undefined to allow silently. */
export function verdictFor(tool: string, input: Record<string, unknown>, reads: string[]): { deny: string } | undefined {
  // A runner naming a write whose inputs are missing or not a plain object cannot be keyed: refuse
  // it, never read the odd shape as permissive (independent review of #4424, findings 1 and 2).
  if (RUNNERS.includes(leafOf(tool)) && typeof input.name === 'string' &&
      WRITE_TOOLS.includes(input.name.trim().toLowerCase()) && !isPlainObject(input.inputs)) {
    return { deny: `[mod:jira-read-before-write] REFUSED: ${input.name.trim()} was sent without a readable ` +
      `inputs object, so the ticket it writes to cannot be checked against this session's comment reads. ` +
      `Resend with inputs={issueIdOrKey: "<KEY>", ...} after listJiraIssueComments(issueIdOrKey="<KEY>", ` +
      `orderBy="-created"). (LC-2118)` }
  }
  const { leaf, args } = resolve(tool, input)
  if (!WRITE_TOOLS.includes(leaf)) return undefined
  const key = issueKey(args)
  // A key field that is present but not a usable string (a number, an object, "") cannot be checked
  // against the reads: refuse it (independent re-review of #4424). Truly absent fields stay keyless.
  if (key === undefined && KEY_FIELDS.some((f) => args[f] !== undefined && args[f] !== null)) {
    return { deny: `[mod:jira-read-before-write] REFUSED: ${leaf} names its ticket in a form this guard cannot ` +
      `check (the issue key must be a non-empty string, e.g. issueIdOrKey="LC-1"). Resend with the key as a string ` +
      `after listJiraIssueComments(issueIdOrKey="<KEY>", orderBy="-created"). (LC-2118)` }
  }
  // A write naming no ticket fails on its own merits; not this guard's call.
  if (key === undefined || reads.includes(key)) return undefined
  return { deny: denyText(key, [...reads].sort()) }
}
