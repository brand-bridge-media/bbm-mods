import { test, expect } from 'claude-code/testing'

import { world, runs, UPDATE } from './fixture'

const GREEN = runs(['a', 'completed', 'success'], ['b', 'completed', 'skipped'], ['c', 'completed', 'neutral'])

test('all checks green: the update goes through, with no callout', async ($, on) => {
  const w = world(on, { checks: GREEN })
  const r: any = await $.tool.call(UPDATE())
  expect(r.deny).toBeUndefined()
  expect(r.context).toBeUndefined()
  expect(w.reached.length).toBe(1)
  expect(w.toasts.length).toBe(0)
  expect(w.mcpCalls[0]).toMatchObject({ server: 'github', tool: 'pull_request_read', args: { method: 'get_check_runs', owner: 'o', repo: 'r', pullNumber: 7 } })
})

test('a failing check denies and cites CLAUDE.md section 5', async ($, on) => {
  const w = world(on, { checks: runs(['a', 'completed', 'success'], ['schema-drift-check', 'completed', 'failure']) })
  const r: any = await $.tool.call(UPDATE())
  expect(r.deny).toMatch(/^\[mod:ci-preflight\] update-branch refused: 1 check\(s\) failing/)
  expect(r.deny).toContain('schema-drift-check')
  expect(r.deny).toContain('CLAUDE.md section 5')
  expect(r.deny).toContain('~19-check')
  expect(w.reached.length).toBe(0)
  expect(w.toasts.length).toBe(1)
})

for (const status of ['queued', 'in_progress']) {
  test(`a ${status} check denies`, async ($, on) => {
    const w = world(on, { checks: runs(['a', 'completed', 'success'], ['slow', status, null]) })
    const r: any = await $.tool.call(UPDATE())
    expect(r.deny).toMatch(/still queued\/in progress \(slow\)/)
    expect(w.reached.length).toBe(0)
  })
}

test('timed_out and cancelled count as failing', async ($, on) => {
  world(on, { checks: runs(['t', 'completed', 'timed_out'], ['c', 'completed', 'cancelled']) })
  const r: any = await $.tool.call(UPDATE())
  expect(r.deny).toContain('2 check(s) failing')
})

const UNREADABLE: [string, any, string][] = [
  ['MCP error', { checksError: true }, 'NOT CHECKED, update allowed'],
  ['MCP throws', { checksThrow: true }, 'NOT CHECKED, update allowed'],
  ['not JSON', { checks: 'not json' }, 'NOT CHECKED, update allowed'],
  ['wrong object', { checks: { nope: 1 } }, 'NOT CHECKED, update allowed'],
  ['bad run entry', { checks: [{ name: 1 }] }, 'NOT CHECKED, update allowed'],
  ['zero runs yet', { checks: runs() }, 'no check runs yet'],
]
for (const [label, w0, expected] of UNREADABLE) {
  test(`unreadable check runs (${label}) fail OPEN with a warning`, async ($, on) => {
    const w = world(on, w0)
    const r: any = await $.tool.call(UPDATE())
    expect(r.deny).toBeUndefined()
    expect(w.reached.length).toBe(1)
    expect(r.context.join('\n')).toContain(expected)
  })
}

test('the same guard covers the GitHub_Custom server and reads through it', async ($, on) => {
  const w = world(on, { checks: runs(['x', 'completed', 'failure']) })
  const r: any = await $.tool.call(UPDATE('mcp__GitHub_Custom__update_pull_request_branch'))
  expect(r.deny).toBeDefined()
  expect(w.mcpCalls[0]!.server).toBe('GitHub_Custom')
})

test('a bare array of runs is read too', async ($, on) => {
  world(on, { checks: [{ name: 'x', status: 'completed', conclusion: 'failure' }] })
  const r: any = await $.tool.call(UPDATE())
  expect(r.deny).toBeDefined()
})

// CI review on #1842: a completed run with no conclusion, or one outside the known
// green/red sets, must never read as green.
for (const conclusion of [null, 'some_new_state']) {
  test(`a completed check with conclusion ${conclusion} is not treated as green`, async ($, on) => {
    const w = world(on, { checks: runs(['a', 'completed', 'success'], ['odd', 'completed', conclusion as any]) })
    const r: any = await $.tool.call(UPDATE())
    expect(r.deny).toMatch(/odd/)
    expect(w.reached.length).toBe(0)
  })
}
