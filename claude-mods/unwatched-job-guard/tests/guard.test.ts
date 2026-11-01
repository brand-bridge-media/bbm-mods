import { test, expect } from 'claude-code/testing'

import { blockText, judge, jobOf, jobsOf, MAX_BLOCKS, parseWatching, signalOf } from '../hooks/logic'

const T0 = Date.parse('2026-11-01T00:00:00Z')
const FN = 'https://tlcbwwgfqnasmiipgmmd.supabase.co/functions/v1/github-dispatch'

test('starts are recognised with the key their watcher uses', () => {
  expect(jobOf({ tool: 'mcp__Supabase__execute_sql', query: `select net.http_post(url := '${FN}?secret=x', body := '{"workflow":"refresh-run.yml"}'::jsonb)` }, T0))
    .toMatchObject({ key: 'dispatch:refresh-run.yml', holder: 'dispatch-watch' })
  expect(jobOf({ tool: 'mcp__Supabase__execute_sql', query: `select net.http_post(url := '${FN}', body := '{"action":"status","workflow":"refresh-run.yml"}'::jsonb)` }, T0)).toBeNull()
  expect(jobOf({ tool: 'mcp__Supabase__execute_sql', query: 'select 1' }, T0)).toBeNull()
  expect(jobOf({ tool: 'mcp__github__actions_run_trigger', method: 'run_workflow', owner: 'O', repo: 'r', workflow_id: '.github/workflows/DB-test.yml' }, T0))
    .toMatchObject({ key: 'run:o/r:db-test.yml', holder: 'workflow-run-watch' })
  expect(jobOf({ tool: 'mcp__github__actions_run_trigger', method: 'rerun_failed_jobs', owner: 'o', repo: 'r', run_id: 41 }, T0))
    .toMatchObject({ key: 'run:o/r:41', holder: 'workflow-run-watch' })
  expect(jobOf({ tool: 'mcp__github__actions_run_trigger', method: 'cancel_workflow_run', owner: 'o', repo: 'r', run_id: 41 }, T0)).toBeNull()
  expect(jobOf({ tool: 'mcp__GitHub_Custom__enable_pr_auto_merge', owner: 'o', repo: 'r', pullNumber: 2398 }, T0))
    .toMatchObject({ key: 'pr:o/r#2398', holder: 'pr-ci-watch' })
  const sh = jobsOf({ tool: 'Bash', command: 'cd x && gh workflow run db-test.yml -f a=1' }, T0)
  expect(sh.map(j => j.key)).toEqual(['bash:gh workflow run db-test.yml -f a=1'])
  expect(sh[0]!.holder).toBeUndefined()
  // Every start in one command is recorded (CI reviewer, #2429 finding 2).
  expect(jobsOf({ tool: 'Bash', command: 'gh workflow run a.yml; gh workflow run b.yml' }, T0).map(j => j.key))
    .toEqual(['bash:gh workflow run a.yml', 'bash:gh workflow run b.yml'])
  expect(jobsOf({ tool: 'Bash', command: 'gh workflow run a.yml & gh workflow run b.yml' }, T0).map(j => j.key))
    .toEqual(['bash:gh workflow run a.yml', 'bash:gh workflow run b.yml'])
  expect(jobsOf({ tool: 'Bash', command: "bash -c 'gh workflow run c.yml'" }, T0).map(j => j.key)).toEqual(['bash:bash -c gh workflow run c.yml'])
  expect(jobsOf({ tool: 'Bash', command: 'gh pr merge 7 --auto --squash' }, T0)[0]?.key).toContain('gh pr merge')
  expect(jobsOf({ tool: 'Bash', command: 'gh run list; gh pr merge 7 --squash' }, T0)).toEqual([])
  expect(jobsOf({ tool: 'mcp__github__enable_pr_auto_merge', owner: 'o', repo: 'r', pullNumber: 1 }, T0).map(j => j.key)).toEqual(['pr:o/r#1'])
  expect(jobOf({ tool: 'Read', file_path: '/x' }, T0)).toBeNull()
})

const J = (key: string, holder?: any, extra = {}) => ({ key, holder, what: key, startedAt: T0, ...extra })

test('held jobs pass, finished ones drop, the rest are unwatched with a reason', () => {
  const jobs = [J('pr:o/r#1', 'pr-ci-watch'), J('pr:o/r#2', 'pr-ci-watch'), J('pr:o/r#3', 'pr-ci-watch'),
    J('run:o/r:x.yml', 'workflow-run-watch'), J('bash:gh workflow run y'), J('dispatch:a.yml', 'dispatch-watch', { checkIn: true })]
  const v = judge(jobs as any, { 'pr-ci-watch': { active: ['pr:o/r#1'], finished: ['pr:o/r#2'] }, 'workflow-run-watch': null })
  expect(v.finished).toEqual(['pr:o/r#2'])
  expect(v.unwatched.map(u => [u.job.key, u.why])).toEqual([
    ['pr:o/r#3', 'pr-ci-watch is not watching it'],
    ['run:o/r:x.yml', 'workflow-run-watch is not loaded or did not answer'],
    ['bash:gh workflow run y', 'no watcher mod follows a shell start'],
  ])
})

test('watching replies: JSON lists or unreadable', () => {
  expect(parseWatching({ result: '{"active":["a"],"finished":[]}' })).toEqual({ active: ['a'], finished: [] })
  expect(parseWatching({ text: '{"active":[],"finished":["b"]}' })).toEqual({ active: [], finished: ['b'] })
  for (const bad of [undefined, null, { deny: 'no' }, { isError: true }, { result: 'nope' }, { result: '{"error":"x"}' }]) expect(parseWatching(bad)).toBeNull()
})

test('the block names each job, the reason, the fix and the release key', () => {
  const t = blockText([{ job: J('pr:o/r#3', 'pr-ci-watch') as any, why: 'pr-ci-watch is not watching it' }])
  expect(t).toMatch(/^\[mod:unwatched-job-guard\] No human is watching this session/)
  expect(t).toContain('watch_pr with armed: true')
  expect(t).toContain('send_later')
  expect(t).toContain('job "pr:o/r#3"')
})

test('the session signal reads child / top / unreadable', () => {
  const r = (ccr: unknown) => ({ content: [{ type: 'text', text: JSON.stringify({ ccr }) }] })
  expect(signalOf(r({ id: 's', parent_session_id: 'p' })).kind).toBe('child')
  expect(signalOf(r({ id: 's' })).kind).toBe('top')
  expect(signalOf({ isError: true }).kind).toBe('unreadable')
  expect(signalOf(r({})).kind).toBe('unreadable')
})

// ---- end to end ----

const CHILD = { content: [{ type: 'text', text: JSON.stringify({ ccr: { id: 's1', parent_session_id: 'p1' } }) }] }
const TOP = { content: [{ type: 'text', text: JSON.stringify({ ccr: { id: 's1' } }) }] }

function world(on: any, session: any, watching: Record<string, string | undefined>) {
  const toasts: string[] = []
  on('clock.now', () => ({ value: T0 }) as any)
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  on('ui.log', () => ({ value: undefined }) as any)
  on('mcp.call', () => ({ value: session }) as any)
  on('tool.call', (_$: any, e: any) => {
    const m = String(e.tool).match(/^mcp__(.+)__watching$/)
    if (m) return watching[m[1]!] === undefined ? { isError: true, result: 'no such tool' } : { result: watching[m[1]!] }
    return { result: { content: [{ type: 'text', text: 'ok' }] } }
  })
  on('classic.Stop', () => ({}))
  return toasts
}

const ARM = { tool: 'mcp__github__enable_pr_auto_merge', owner: 'o', repo: 'r', pullNumber: 5 }

test('end to end: a child with an armed PR nobody watches is blocked, at most twice', async ($: any, on: any) => {
  world(on, CHILD, { 'pr-ci-watch': '{"active":[],"finished":[]}' })
  await $.tool.call(ARM)
  for (let i = 0; i < MAX_BLOCKS; i++) {
    const s: any = await $.classic.Stop({ stop_hook_active: i > 0 })
    expect(String(s.block ?? '')).toContain('o/r#5 armed for auto-merge')
  }
  const last: any = await $.classic.Stop({ stop_hook_active: true })
  expect(last.block).toBeUndefined()
})

test('end to end: held by the watcher passes; finished drops; release clears', async ($: any, on: any) => {
  const w: Record<string, string> = { 'pr-ci-watch': '{"active":["pr:o/r#5"],"finished":[]}' }
  world(on, CHILD, w)
  await $.tool.call(ARM)
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
  w['pr-ci-watch'] = '{"active":[],"finished":["pr:o/r#5"]}'
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
  // A shell start has no watcher: blocked until released.
  await $.tool.call({ tool: 'Bash', command: 'gh workflow run db.yml' })
  expect(String((await $.classic.Stop({ stop_hook_active: false })).block ?? '')).toContain('bash:gh workflow run db.yml')
  const rel: any = await $.tool.call({ tool: 'mcp__unwatched-job-guard__release', job: 'bash:gh workflow run db.yml', reason: 'run 9 finished green' })
  // Two starts in one command: releasing one still leaves the other blocking.
  await $.tool.call({ tool: 'Bash', command: 'gh workflow run a.yml; gh workflow run b.yml' })
  await $.tool.call({ tool: 'mcp__unwatched-job-guard__release', job: 'bash:gh workflow run a.yml', reason: 'done' })
  expect(String((await $.classic.Stop({ stop_hook_active: false })).block ?? '')).toContain('bash:gh workflow run b.yml')
  await $.tool.call({ tool: 'mcp__unwatched-job-guard__release', job: 'bash:gh workflow run b.yml', reason: 'done' })
  expect(String(rel.result)).toContain('released')
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
})

test('end to end: a check-in holds open jobs; a missing watcher mod counts as unwatched', async ($: any, on: any) => {
  world(on, CHILD, {})
  await $.tool.call(ARM)
  expect(String((await $.classic.Stop({ stop_hook_active: false })).block ?? '')).toContain('pr-ci-watch is not loaded')
  await $.tool.call({ tool: 'mcp__claude-code-remote__send_later', delay_minutes: 30, message: 'check #5' })
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
})

test('end to end: a top-level session is never blocked, only toasted', async ($: any, on: any) => {
  const toasts = world(on, TOP, { 'pr-ci-watch': '{"active":[],"finished":[]}' })
  await $.tool.call(ARM)
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
  expect(toasts.join(' ')).toContain('nothing will wake you for')
})

test('end to end: a failed start is not recorded', async ($: any, on: any) => {
  on('tool.call', { tool: /enable_pr_auto_merge$/ }, () => ({ isError: true, result: 'auto-merge not allowed' }))
  world(on, CHILD, {})
  await $.tool.call(ARM)
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
})
