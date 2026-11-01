import { test, expect } from 'claude-code/testing'

import { bashNumericStart, bashStartsRefresh, DENY, DENY_NUMERIC, mcpStartsRefresh, numericStart, workflowIsRefresh } from '../hooks/logic'

test('a GitHub MCP start of refresh-run.yml is refused; other workflows and other methods pass', () => {
  expect(mcpStartsRefresh({ method: 'run_workflow', owner: 'brand-bridge-media', repo: 'bbm-refresh-agent', workflow_id: 'refresh-run.yml', ref: 'main' })).toBe(true)
  expect(mcpStartsRefresh({ method: 'run_workflow', workflow_id: ' refresh-run.yaml ' })).toBe(true)
  expect(mcpStartsRefresh({ method: 'run_workflow', workflow_id: '.github/workflows/refresh-run.yml' })).toBe(true)
  expect(mcpStartsRefresh({ method: 'run_workflow', workflow_id: 'run-golive-watch.yml' })).toBe(false)
  expect(mcpStartsRefresh({ method: 'run_workflow', workflow_id: 'my-refresh-run.yml' })).toBe(false)
  expect(mcpStartsRefresh({ method: 'cancel_workflow_run', run_id: 1 })).toBe(false)
  expect(mcpStartsRefresh({ method: 'rerun_workflow_run', run_id: 1 })).toBe(false)
  expect(mcpStartsRefresh({ method: 'cancel_workflow_run', workflow_id: 'refresh-run.yml', run_id: 1 })).toBe(false)
  expect(mcpStartsRefresh({})).toBe(false)
  expect(mcpStartsRefresh({ method: 'run_workflow', workflow_id: 'Refresh-Run.yml' })).toBe(true)
  // An unreadable workflow_id shape is refused, not coerced (#2429 review finding 2).
  expect(mcpStartsRefresh({ method: 'run_workflow', workflow_id: { name: 'refresh-run.yml' } })).toBe(true)
  expect(mcpStartsRefresh({ method: 'run_workflow' })).toBe(false)
})

test('shell starts of refresh-run.yml are refused; reads and other workflows pass', () => {
  expect(bashStartsRefresh('gh workflow run refresh-run.yml -f run_id=abc')).toBe(true)
  expect(bashStartsRefresh('cd x && gh workflow run --repo brand-bridge-media/bbm-refresh-agent refresh-run.yml')).toBe(true)
  expect(bashStartsRefresh("gh api -X POST repos/o/r/actions/workflows/refresh-run.yml/dispatches -f ref=main")).toBe(true)
  expect(bashStartsRefresh("curl -X POST https://api.github.com/repos/o/r/actions/workflows/refresh-run.yml/dispatches")).toBe(true)
  expect(bashStartsRefresh('gh workflow run Refresh-Run.YML')).toBe(true)
  expect(bashStartsRefresh('gh api -X POST repos/o/r/actions/workflows/REFRESH-RUN.yml/dispatches')).toBe(true)
  expect(bashStartsRefresh('gh run list --workflow refresh-run.yml')).toBe(false)
  expect(bashStartsRefresh('cat .github/workflows/refresh-run.yml')).toBe(false)
  expect(bashStartsRefresh('gh workflow run ci.yml')).toBe(false)
  expect(bashStartsRefresh('grep refresh-run.yml README.md; gh workflow run ci.yml')).toBe(false)
  // refresh-run.yml as an input VALUE is not a refresh start (#2429 review finding 1).
  expect(bashStartsRefresh('gh workflow run ci.yml -f msg=refresh-run.yml')).toBe(false)
  expect(bashStartsRefresh('gh workflow run -R o/r -r main refresh-run.yml -f a=1')).toBe(true)
  expect(bashStartsRefresh("gh workflow run 'refresh-run.yml'")).toBe(true)
  // Hidden in a quoted sub-shell, backgrounded, piped or substituted: still a start (#2429 review).
  expect(bashStartsRefresh("bash -c 'gh workflow run refresh-run.yml'")).toBe(true)
  expect(bashStartsRefresh('sh -c "gh workflow run refresh-run.yml -f a=1"')).toBe(true)
  expect(bashStartsRefresh('true & gh workflow run refresh-run.yml')).toBe(true)
  expect(bashStartsRefresh('echo $(gh workflow run refresh-run.yml)')).toBe(true)
  expect(bashStartsRefresh('/usr/bin/gh workflow run refresh-run.yml')).toBe(true)
  expect(bashStartsRefresh("bash -c 'gh workflow run 123'")).toBe(false)
  expect(bashNumericStart("bash -c 'gh workflow run 123'")).toBe(true)
  // --json takes no value (inputs come on stdin): the operand after it is still the workflow.
  expect(bashStartsRefresh('echo {} | gh workflow run --json refresh-run.yml')).toBe(true)
})

test('the refusal names the mod, the decision and the bridge', () => {
  expect(DENY).toMatch(/^\[mod:refresh-start-path-guard\]/)
  expect(DENY).toContain('LC-1902')
  expect(DENY).toContain('github-dispatch')
  expect(DENY).toContain('dispatch-watch')
})

test('end to end: the MCP and Bash starts are denied before they run; a re-run passes through', async ($: any, on: any) => {
  const ran: string[] = []
  on('tool.call', (_$: any, e: any) => { ran.push(e.tool); return { result: { content: [{ type: 'text', text: 'ok' }] } } })
  const a: any = await $.tool.call({ tool: 'mcp__github__actions_run_trigger', method: 'run_workflow', owner: 'o', repo: 'r', workflow_id: 'refresh-run.yml', ref: 'main' })
  expect(String(a.deny ?? '')).toContain('[mod:refresh-start-path-guard]')
  const b: any = await $.tool.call({ tool: 'Bash', command: 'gh workflow run refresh-run.yml' })
  expect(String(b.deny ?? '')).toContain('github-dispatch')
  expect(ran).toEqual([])
  const c: any = await $.tool.call({ tool: 'mcp__github__actions_run_trigger', method: 'rerun_failed_jobs', owner: 'o', repo: 'r', run_id: 5 })
  expect(c.deny).toBeUndefined()
  expect(ran).toEqual(['mcp__github__actions_run_trigger'])
})

test('numeric workflow ids are recognised; a lookup decides (CI reviewer, #2429 finding 3)', () => {
  expect(numericStart({ method: 'run_workflow', workflow_id: '123456' })).toBe('123456')
  expect(numericStart({ method: 'run_workflow', workflow_id: 'ci.yml' })).toBeNull()
  expect(numericStart({ method: 'cancel_workflow_run', workflow_id: '123' })).toBeNull()
  expect(workflowIsRefresh(JSON.stringify({ id: 1, path: '.github/workflows/refresh-run.yml' }))).toBe(true)
  expect(workflowIsRefresh(JSON.stringify({ id: 2, path: '.github/workflows/ci.yml' }))).toBe(false)
  expect(workflowIsRefresh('nope')).toBeNull()
  expect(bashNumericStart('gh workflow run 123456')).toBe(true)
  expect(bashNumericStart('gh workflow run --repo o/r 123456 -f x=1')).toBe(true)
  expect(bashNumericStart('gh api -X POST repos/o/r/actions/workflows/123456/dispatches')).toBe(true)
  expect(bashNumericStart('gh workflow run ci.yml')).toBe(false)
  expect(bashNumericStart('gh run view 123456')).toBe(false)
  expect(bashNumericStart('gh workflow run ci.yml -f n=123')).toBe(false)
  expect(DENY_NUMERIC).toMatch(/^\[mod:refresh-start-path-guard\]/)
})

function lookup(on: any, reply: () => any) {
  on('mcp.call', () => ({ value: reply() }) as any)
  on('tool.call', () => ({ result: { content: [{ type: 'text', text: 'ok' }] } }))
}
const NUM = { tool: 'mcp__github__actions_run_trigger', method: 'run_workflow', owner: 'o', repo: 'r', workflow_id: '777', ref: 'main' }

test('end to end: a numeric id that resolves to refresh-run.yml is denied', async ($: any, on: any) => {
  lookup(on, () => ({ content: [{ type: 'text', text: JSON.stringify({ path: '.github/workflows/refresh-run.yml' }) }] }))
  expect(String((await $.tool.call(NUM)).deny ?? '')).toContain('github-dispatch bridge (LC-1902')
})

test('end to end: a numeric id for another workflow passes; an unreadable lookup is denied with "use the file name"', async ($: any, on: any) => {
  let reply: any = { content: [{ type: 'text', text: JSON.stringify({ path: '.github/workflows/ci.yml' }) }] }
  lookup(on, () => reply)
  expect((await $.tool.call(NUM)).deny).toBeUndefined()
  reply = { isError: true, content: [] }
  expect(String((await $.tool.call(NUM)).deny ?? '')).toContain('file name')
})

test('end to end: a shell start by numeric id is denied with "use the file name"', async ($: any, on: any) => {
  lookup(on, () => ({ isError: true, content: [] }))
  expect(String((await $.tool.call({ tool: 'Bash', command: 'gh workflow run 777' })).deny ?? '')).toContain('file name')
  expect((await $.tool.call({ tool: 'Bash', command: 'gh workflow run ci.yml' })).deny).toBeUndefined()
})
