// refresh-start-path-guard (LC-1975, fix 1). One job: a refresh run starts through ONE path.
//
// Why: operator decision 2026-10-22 (LC-1902, memory 2ed9fb95): refresh runs have one start path, the
// github-dispatch bridge. dispatch-watch watches exactly that path, including its "finished in under
// 2 minutes = did nothing" warning. On 2026-10-31 the LC-1935 child started refresh-run.yml directly
// through the GitHub MCP; nothing watched it, its test run finished in a minute and the session sat
// idle about 3 hours, then the real run finished in 44 s having done nothing and nobody noticed.
// A rule a session has to remember failed; this refuses the other routes instead.

export const WORKFLOW_RE = /(^|[\s/'"=])refresh-run\.ya?ml\b/i

export const DENY =
  '[mod:refresh-start-path-guard] refresh-run.yml starts only through the github-dispatch bridge (LC-1902, ' +
  'operator decision 2026-10-22), so dispatch-watch follows the run and warns if it finishes in under 2 minutes. ' +
  'Start it with execute_sql: net.http_post to /functions/v1/github-dispatch?secret= plus the Vault ' +
  "edge_function_shared_secret read in the same statement, body {\"workflow\":\"refresh-run.yml\",\"inputs\":{...}}. " +
  'Exact call: the header of bbm-infrastructure/supabase/functions/github-dispatch/index.ts. ' +
  'Re-running or cancelling an existing run is not blocked.'

/**
 * Shell segments with quotes removed, split on every separator (&&, ||, ;, &, |, newline, and $( ` ).
 * Removing quotes first makes `bash -c 'gh workflow run x'` and `eval "..."` read as plain words (#2429 review):
 * a guard should over-match a quoted string, never miss a start hidden in one.
 */
export function segments(command: string): string[] {
  return command.replace(/['"]/g, ' ').split(/&&|\|\||[;&|\n`]|\$\(|\)/).map(p => p.trim()).filter(Boolean)
}

/** True when a GitHub MCP actions_run_trigger call STARTS refresh-run.yml. */
export function mcpStartsRefresh(args: Record<string, unknown>): boolean {
  if (String(args.method ?? '') !== 'run_workflow') return false
  // Anything but a string or number is not a workflow id we can read: refuse rather than guess (#2429 review).
  if (typeof args.workflow_id !== 'string' && typeof args.workflow_id !== 'number') return args.workflow_id !== undefined
  return /^refresh-run\.ya?ml$/i.test(String(args.workflow_id).trim().replace(/^.*\//, ''))
}

// gh flags that take a value; the workflow is the first operand that is not a flag or a flag's value.
const GH_VALUE_FLAGS = new Set(['-R', '--repo', '-r', '--ref', '-f', '--raw-field', '-F', '--field'])

/** The workflow operand of `gh workflow run ...` in one shell segment, or undefined. */
export function ghWorkflowOperand(segment: string): string | undefined {
  const w = segment.replace(/['"]/g, ' ').split(/\s+/).filter(Boolean)
  const i = w.findIndex((t, k) => /(^|\/)gh$/.test(t) && w[k + 1] === 'workflow' && w[k + 2] === 'run')
  if (i < 0) return undefined
  for (let k = i + 3; k < w.length; k++) {
    const t = w[k]!
    if (GH_VALUE_FLAGS.has(t)) { k++; continue }
    if (t.startsWith('-')) continue
    return t
  }
  return undefined
}

export const DENY_NUMERIC =
  '[mod:refresh-start-path-guard] This starts a workflow by its numeric id, and the guard could not confirm it is not ' +
  'refresh-run.yml (which may only start through the github-dispatch bridge, LC-1902). Start it by its file name instead.'

/** A numeric workflow id on a run_workflow call (it could be refresh-run.yml under another name). */
export function numericStart(args: Record<string, unknown>): string | null {
  if (String(args.method ?? '') !== 'run_workflow') return null
  const id = String(args.workflow_id ?? '').trim()
  return /^\d+$/.test(id) ? id : null
}

/** Whether a get_workflow reply names refresh-run.yml: true / false, or null when unreadable. */
export function workflowIsRefresh(text: string): boolean | null {
  try {
    const v = JSON.parse(text)
    if (typeof v?.path !== 'string') return null
    return /(^|\/)refresh-run\.ya?ml$/i.test(v.path)
  } catch { return null }
}

/** A shell start by numeric workflow id: `gh workflow run 123`, or a POST to .../workflows/123/dispatches. */
export function bashNumericStart(command: string): boolean {
  return segments(command).some(part =>
    /^\d+$/.test(ghWorkflowOperand(part) ?? '') || /actions\/workflows\/\d+\/dispatches/.test(part))
}

/** True when a shell command starts refresh-run.yml outside the bridge (gh CLI, REST dispatches). */
export function bashStartsRefresh(command: string): boolean {
  for (const p of segments(command)) {
    if (!WORKFLOW_RE.test(p)) continue
    // gh workflow run refresh-run.yml / gh workflow run --repo x refresh-run.yml (the operand, not an input value)
    const op = ghWorkflowOperand(p)
    if (op !== undefined && /^refresh-run\.ya?ml$/i.test(op.replace(/^.*\//, ''))) return true
    // POST .../actions/workflows/refresh-run.yml/dispatches (gh api, curl, wget, python one-liners)
    if (/actions\/workflows\/refresh-run\.ya?ml\/dispatches/i.test(p)) return true
  }
  return false
}
