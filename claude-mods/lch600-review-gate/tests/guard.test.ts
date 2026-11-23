import { test, expect } from 'claude-code/testing'

// The Python check (path list, evidence rules, diff reading) is tested by its own --selftest
// (claude-mods.yml runs it). These tests pin the mod's plumbing: which calls reach the check, which
// board reads are recorded for it (LC-2265), and how its verdict maps.

export function world(on: any, answer: { exitCode?: number; stdout?: string; throws?: boolean } = {},
  toolText = 'ok') {
  const runs: { argv: string[]; stdin: string }[] = []
  const toasts: string[] = []
  const reached: any[] = []
  on('process.run', (_$: any, e: any) => {
    runs.push({ argv: [...e.argv], stdin: String(e.init?.stdin ?? '') })
    if (answer.throws) throw new Error('spawn failed')
    return { value: { exitCode: answer.exitCode ?? 0, stdout: answer.stdout ?? '', stderr: '' } } as any
  })
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  on('tool.call', (_$: any, e: any) => { reached.push(e); return { result: toolText, text: toolText } as any })
  return { runs, toasts, reached }
}

const DENY = "{\"hookSpecificOutput\": {\"hookEventName\": \"PreToolUse\", \"permissionDecision\": \"deny\", \"permissionDecisionReason\": \"[mod:lch600-review-gate] review first\"}}"
const PR = { owner: 'brand-bridge-media', repo: 'bbm-infrastructure', head: 'lc1-x', base: 'main', title: 'LC-1 t', body: '' }

for (const tool of ['mcp__github__create_pull_request', 'mcp__GitHub_Custom__create_pull_request']) {
  test(`${tool}: a PR the check denies never reaches GitHub; the reason is toasted`, async ($: any, on: any) => {
    const w = world(on, { stdout: DENY })
    const r: any = await $.tool.call({ tool, ...PR })
    expect(String(r.deny ?? r.text)).toContain('[mod:lch600-review-gate] review first')
    expect(w.reached.length).toBe(0)
    expect(w.toasts[0]).toContain('[mod:lch600-review-gate]')
    expect(w.runs[0]!.argv.slice(0, 2)).toEqual(['python3', '-I'])
    expect(w.runs[0]!.argv[2]).toMatch(/hooks\/lch600-review-gate\.py$/)
    const sent = JSON.parse(w.runs[0]!.stdin)
    expect(sent.tool_name).toBe(tool)
    expect(sent.tool_input).toEqual(PR)
  })
}

for (const [label, answer] of [['silence', { stdout: '' }], ['a non-zero exit', { exitCode: 1, stdout: DENY }],
  ['junk output', { stdout: 'not json' }], ['a spawn failure', { throws: true }]] as const) {
  test(`${label} from the check lets the PR through (fail open)`, async ($: any, on: any) => {
    const w = world(on, answer as any)
    const r: any = await $.tool.call({ tool: 'mcp__github__create_pull_request', ...PR })
    expect(r.deny).toBeUndefined()
    expect(w.reached.length).toBe(1)
  })
}

test('other GitHub calls never start the check', async ($: any, on: any) => {
  const w = world(on, { stdout: DENY })
  const r: any = await $.tool.call({ tool: 'mcp__github__merge_pull_request', owner: 'o', repo: 'r', pullNumber: 1 })
  expect(r.deny).toBeUndefined()
  expect(w.runs.length).toBe(0)
})

const SQL = 'mcp__Supabase__execute_sql'
const ROW = '{"result": "<untrusted-data-x>[{\\"id\\": 7, \\"track\\": \\"ci-speed\\", \\"status\\": \\"closed\\"}]</untrusted-data-x>"}'

test('a board read that shows a ci-speed row is handed to the check', async ($: any, on: any) => {
  const w = world(on, { stdout: '' }, ROW)
  await $.tool.call({ tool: SQL, project_id: 'p', query: 'select * from public.track_requests where id = 7' })
  await $.tool.call({ tool: 'mcp__github__create_pull_request', ...PR })
  const sent = JSON.parse(w.runs[0]!.stdin)
  expect(sent.transcript_rows.length).toBe(2)
  expect(sent.transcript_rows[0].message.content[0].name).toBe(SQL)
  expect(sent.transcript_rows[1].message.content[0].content).toContain('ci-speed')
})

test('the second Supabase connector is recorded too', async ($: any, on: any) => {
  const w = world(on, { stdout: '' }, ROW)
  await $.tool.call({ tool: 'mcp__Supabase_Muni__execute_sql', project_id: 'p', query: 'select * from public.track_requests where id = 7' })
  await $.tool.call({ tool: 'mcp__github__create_pull_request', ...PR })
  expect(JSON.parse(w.runs[0]!.stdin).transcript_rows.length).toBe(2)
})

test('a ci-speed row from a query not on track_requests is not recorded (review finding 3)', async ($: any, on: any) => {
  const w = world(on, { stdout: '' }, ROW)
  await $.tool.call({ tool: SQL, project_id: 'p', query: "select 7 as id, 'ci-speed' as track" })
  await $.tool.call({ tool: 'mcp__github__create_pull_request', ...PR })
  expect(JSON.parse(w.runs[0]!.stdin).transcript_rows.length).toBe(0)
})

test('a Jira skip through the executeWrite runner is recorded (review finding 2)', async ($: any, on: any) => {
  const w = world(on, { stdout: '' }, '{"id": "1"}')
  await $.tool.call({ tool: 'mcp__Atlassian_MCP__executeWrite', name: 'addCommentToJiraIssue', cloudId: 'c', inputs: { issueIdOrKey: 'LC-1', commentBody: 'Skipping LCH-600 review: incident hotfix' } })
  await $.tool.call({ tool: 'mcp__Atlassian_MCP__executeWrite', name: 'editJiraIssue', cloudId: 'c', inputs: { issueIdOrKey: 'LC-1' } })
  await $.tool.call({ tool: 'mcp__github__create_pull_request', ...PR })
  expect(JSON.parse(w.runs[0]!.stdin).transcript_rows.length).toBe(2)
})

test('a v2 Jira skip comment (addOrEditJiraIssueComment) is recorded; a v2 read is not (LC-2118)', async ($: any, on: any) => {
  const w = world(on, { stdout: '' }, '{"data":{"commentId":"1"}}')
  await $.tool.call({ tool: 'mcp__Atlassian_MCP__addOrEditJiraIssueComment', cloudId: 'c', issueIdOrKey: 'LC-1', commentBody: 'Skipping LCH-600 review: incident hotfix' })
  await $.tool.call({ tool: 'mcp__Atlassian_MCP__getJiraIssue', cloudId: 'c', issueIdOrKey: 'LC-5' })
  await $.tool.call({ tool: 'mcp__github__create_pull_request', ...PR })
  // the comment and the PR call itself are rows; the v2 read is not
  expect(JSON.parse(w.runs[0]!.stdin).transcript_rows.length).toBe(2)
})

test('a query result without a ci-speed row is not recorded',async ($: any, on: any) => {
  const w = world(on, { stdout: '' }, '{"result": "[{\\"id\\": 1}]"}')
  await $.tool.call({ tool: SQL, project_id: 'p', query: 'select 1' })
  await $.tool.call({ tool: 'mcp__github__create_pull_request', ...PR })
  expect(JSON.parse(w.runs[0]!.stdin).transcript_rows.length).toBe(0)
})

test('Jira calls are no longer recorded (LC-2265)', async ($: any, on: any) => {
  const w = world(on, { stdout: '' }, 'c1: [LCH-600 feedback] ci-speed fine')
  await $.tool.call({ tool: 'mcp__Atlassian__getJiraIssue', cloudId: 'c', issueIdOrKey: 'LC-5' })
  await $.tool.call({ tool: 'mcp__github__create_pull_request', ...PR })
  expect(JSON.parse(w.runs[0]!.stdin).transcript_rows.length).toBe(0)
})

const SHADOW = "{\"hookSpecificOutput\": {\"hookEventName\": \"PreToolUse\", \"additionalContext\": \"[mod:lch600-review-gate] SHADOW would-deny (x): review first\"}}"

test('shadow mode: the PR goes through with the note, and the note is toasted for the mod actions log', async ($: any, on: any) => {
  const w = world(on, { stdout: SHADOW })
  const r: any = await $.tool.call({ tool: 'mcp__github__create_pull_request', ...PR })
  expect(r.deny).toBeUndefined()
  expect(w.reached.length).toBe(1)
  expect(w.toasts[0]).toContain('[mod:lch600-review-gate] SHADOW would-deny')
})

function prWorld(on: any, pr: Record<string, unknown>, files: unknown, isError = false) {
  const calls: any[] = []
  on('mcp.call', (_$: any, e: any) => {
    calls.push(e)
    const body = e.args?.method === 'get_files' ? files : pr
    return { value: { isError, content: [{ type: 'text', text: JSON.stringify(body) }] } } as any
  })
  return calls
}

const UPDATE = { tool: 'mcp__github__update_pull_request', owner: 'o', repo: 'r', pullNumber: 7 }
const FILES = [{ filename: '.github/workflows/tests.yml', status: 'modified', patch: '-a\n+b' }]

test('leaving draft: the PR head, title, body and files are read and sent to the check', async ($: any, on: any) => {
  const w = world(on, { stdout: DENY })
  const calls = prWorld(on, { draft: true, head: { ref: 'lc1-x' }, title: 'LC-1 t', body: 'B' }, FILES)
  const r: any = await $.tool.call({ ...UPDATE, draft: false })
  expect(String(r.deny ?? r.text)).toContain('[mod:lch600-review-gate]')
  expect(w.reached.length).toBe(0)
  expect(calls.map((c: any) => c.args.method)).toEqual(['get', 'get_files'])
  const sent = JSON.parse(w.runs[0]!.stdin)
  expect(sent.tool_input).toMatchObject({ head: 'lc1-x', title: 'LC-1 t', body: 'B', pullNumber: 7 })
  expect(sent.pr_files).toEqual(FILES)
})

test('leaving draft with a new body: the new body is what gets checked', async ($: any, on: any) => {
  const w = world(on, { stdout: '' })
  prWorld(on, { draft: true, head: { ref: 'b' }, title: 'LC-1', body: 'old' }, FILES)
  await $.tool.call({ ...UPDATE, draft: false, body: 'LCH-600-Review: request 7 closed' })
  expect(JSON.parse(w.runs[0]!.stdin).tool_input.body).toBe('LCH-600-Review: request 7 closed')
})

for (const [label, call, pr, isError] of [
  ['an update that does not leave draft', { ...UPDATE, title: 'x' }, { draft: true }, false],
  ['a PR already ready', { ...UPDATE, draft: false }, { draft: false, head: { ref: 'b' } }, false],
  ['a PR read that fails', { ...UPDATE, draft: false }, { draft: true }, true],
] as const) {
  test(`${label} never starts the check`, async ($: any, on: any) => {
    const w = world(on, { stdout: DENY })
    prWorld(on, pr as any, FILES, isError as boolean)
    const r: any = await $.tool.call(call as any)
    expect(r.deny).toBeUndefined()
    expect(w.runs.length).toBe(0)
    expect(w.reached.length).toBe(1)
  })
}

// LC-2207: the record survives a container restart ($.state is lost; $.store is not). Since LC-2265 a fresh
// board read also restores it, so this is a convenience that must still never leak across sessions.
function store(on: any, sid: string, saved?: unknown) {
  const data: Record<string, unknown> = saved === undefined ? {} : { rows: saved }
  on('store.get', ((_$: any, e: any) => ({ value: data[e.key] })) as any)
  on('store.set', ((_$: any, e: any) => { data[e.key] = e.value; return { value: undefined } }) as any)
  on('session.id', (() => ({ value: sid })) as any)
  return data
}

test('recorded board reads are saved with the session id', async ($: any, on: any) => {
  const data = store(on, 'session_a')
  world(on, { stdout: '' }, ROW)
  await $.tool.call({ tool: SQL, project_id: 'p', query: 'select * from public.track_requests where id = 7' })
  const saved: any = data.rows
  expect(saved.sessionId).toBe('session_a')
  expect(saved.rows.length).toBe(2)
})

test('after a restart the saved record of the same session reaches the check', async ($: any, on: any) => {
  const row = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: SQL, input: {} }] } }
  store(on, 'session_a', { sessionId: 'session_a', rows: [row] })
  const w = world(on, { stdout: '' })
  await $.tool.call({ tool: 'mcp__github__create_pull_request', ...PR })
  expect(JSON.parse(w.runs[0]!.stdin).transcript_rows).toEqual([row])
})

test("another session's saved record is never used", async ($: any, on: any) => {
  store(on, 'session_b', { sessionId: 'session_a', rows: [{ type: 'assistant' }] })
  const w = world(on, { stdout: '' })
  await $.tool.call({ tool: 'mcp__github__create_pull_request', ...PR })
  expect(JSON.parse(w.runs[0]!.stdin).transcript_rows).toEqual([])
})

test('a store that cannot be read keeps the last good save (LCH-600 on LC-2242, item 2)', async ($: any, on: any) => {
  const old = { sessionId: 'session_a', rows: [{ type: 'assistant', message: { content: [] } }] }
  const data: Record<string, unknown> = { rows: old }
  on('store.get', (() => { throw new Error('store down') }) as any)
  on('store.set', ((_$: any, e: any) => { data[e.key] = e.value; return { value: undefined } }) as any)
  on('session.id', (() => ({ value: 'session_a' })) as any)
  world(on, { stdout: '' }, ROW)
  await $.tool.call({ tool: SQL, project_id: 'p', query: 'select * from public.track_requests where id = 7' })
  expect(data.rows).toEqual(old)
})

test('damaged saved rows are dropped, good ones kept (item 3)', async ($: any, on: any) => {
  const good = { type: 'assistant', message: { content: [] } }
  store(on, 'session_a', { sessionId: 'session_a', rows: [good, 'junk', { type: 'user' }, { message: { content: [] } }, null] })
  const w = world(on, { stdout: '' })
  await $.tool.call({ tool: 'mcp__github__create_pull_request', ...PR })
  expect(JSON.parse(w.runs[0]!.stdin).transcript_rows).toEqual([good])
})

// ---- LCH-744 plan stage ----------------------------------------------------------------------------------------

const SHADOW_PLAN = "{\"hookSpecificOutput\": {\"hookEventName\": \"PreToolUse\", \"additionalContext\": \"[mod:lch600-review-gate] SHADOW would-ask-plan (shadow mode): PLAN REVIEW\"}}"
const DENY_PLAN = "{\"hookSpecificOutput\": {\"hookEventName\": \"PreToolUse\", \"permissionDecision\": \"deny\", \"permissionDecisionReason\": \"[mod:lch600-review-gate] PLAN REVIEW\"}}"
const WF = '/home/claude/bbm-infrastructure/.github/workflows/deploy-workers.yml'

test('an ordinary edit never starts the plan check', async ($: any, on: any) => {
  const w = world(on, { stdout: DENY_PLAN })
  const r: any = await $.tool.call({ tool: 'Edit', file_path: '/w/repo/docs/a.md', old_string: 'a', new_string: 'b' })
  expect(r.deny).toBeUndefined()
  expect(w.runs.length).toBe(0)
})

test('a gated edit the plan check denies is not made; the reason is toasted', async ($: any, on: any) => {
  const w = world(on, { stdout: DENY_PLAN })
  const r: any = await $.tool.call({ tool: 'Edit', file_path: WF, old_string: 'a', new_string: 'b' })
  expect(String(r.deny ?? r.text)).toContain('PLAN REVIEW')
  expect(w.reached.length).toBe(0)
  expect(w.runs[0]!.argv[2]).toMatch(/hooks\/plan_stage\.py$/)
  const sent = JSON.parse(w.runs[0]!.stdin)
  expect(sent.tool_name).toBe('Edit')
  expect(sent.told).toBe(false)
})

test('shadow: the note is toasted once, then the check is told', async ($: any, on: any) => {
  const w = world(on, { stdout: SHADOW_PLAN })
  await $.tool.call({ tool: 'Write', file_path: WF, content: 'x' })
  await $.tool.call({ tool: 'Write', file_path: WF, content: 'y' })
  expect(w.reached.length).toBe(2)
  expect(w.toasts.filter(t => t.includes('SHADOW would-ask-plan')).length).toBe(2)
  expect(JSON.parse(w.runs[1]!.stdin).told).toBe(true)
})

test('a plan check failure lets the edit through (fail open)', async ($: any, on: any) => {
  const w = world(on, { throws: true })
  const r: any = await $.tool.call({ tool: 'Edit', file_path: WF, old_string: 'a', new_string: 'b' })
  expect(r.deny).toBeUndefined()
  expect(w.reached.length).toBe(1)
})

test('the plan post and the read of the answer are recorded for the check; other SQL is not', async ($: any, on: any) => {
  const w = world(on, { stdout: '' }, '[{"ask_track": {"id": 9}}]')
  await $.tool.call({ tool: 'mcp__Supabase__execute_sql', project_id: 'p', query: 'select 1' })
  await $.tool.call({ tool: 'mcp__Supabase__execute_sql', project_id: 'p',
    query: "select public.ask_track('ci-speed', 'speed-review', 'PLAN: LC-1: x', 's', 'LC-1');" })
  await $.tool.call({ tool: 'mcp__Supabase__execute_sql', project_id: 'p',
    query: "select kind, payload from public.v_track_request_messages where request_id = 9" })
  await $.tool.call({ tool: 'Edit', file_path: WF, old_string: 'a', new_string: 'b' })
  const rows = JSON.parse(w.runs[0]!.stdin).transcript_rows
  expect(rows.length).toBe(4)
  expect(JSON.stringify(rows)).toContain('v_track_request_messages')
  expect(JSON.stringify(rows)).toContain("ask_track('ci-speed'")
  expect(JSON.stringify(rows)).not.toContain('select 1')
})
