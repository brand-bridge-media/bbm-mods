import { test, expect } from 'claude-code/testing'

import { decide, dequeueReason, MAX_STUCK_WAKES, parsePr, mergeFactsDue, parseTrainComment, parseTrainStatus, splitMergify, STUCK_MS, stuckReasons, watchKey } from '../hooks/logic'

// LC-1975 fix 2: an armed PR is watched until it merges, and a green one the queue leaves alone wakes the session.
const T0 = Date.parse('2026-11-01T00:00:00Z')
const MIN = 60_000
const SHA = 'bb7204e552accba3bd0f37379a4381cbf290281c'
const W = { owner: 'brand-bridge-media', repo: 'bbm-infrastructure', number: 2398, server: 'github', sha: SHA, startedAt: T0, armed: true }
const green = [{ name: 'lint', status: 'completed', conclusion: 'success' }]
const pr = (extra: Record<string, unknown> = {}) => ({ kind: 'pr' as const, state: 'open', merged: false, headSha: SHA, runs: green, ...extra })

test('armed and green: no "all passed" wake and no end; the merge clock starts', () => {
  const p1 = decide(W, pr(), T0 + 4 * MIN).patch
  const d = decide({ ...W, ...p1 }, pr(), T0 + 6 * MIN)
  expect(d.done).toBe(false)
  expect(d.wake).toBeUndefined()
  expect(d.patch?.greenAt).toBe(T0 + 6 * MIN)
  // Not armed: the old behaviour (wake, done) is unchanged.
  const u = decide({ ...W, armed: undefined, ...p1 }, pr(), T0 + 6 * MIN)
  expect(u.done).toBe(true)
  expect(u.wake).toContain('all 1 checks passed')
})

test('green and armed but not merged after 30 min: one wake naming why, then every 30 min, then it gives up', () => {
  const w = { ...W, greenAt: T0 }
  expect(decide(w, pr(), T0 + 29 * MIN)).toEqual({ done: false, patch: { errors: 0 } })
  const d1 = decide(w, pr({ merge: { mergeableState: 'dirty' } }), T0 + STUCK_MS)
  expect(d1.done).toBe(false)
  expect(d1.wake).toMatch(/^\[mod:pr-ci-watch\] brand-bridge-media\/bbm-infrastructure#2398 is armed for auto-merge and green on bb7204e, but not merged after 30 min: it conflicts with main/)
  expect(d1.patch?.stuckWakes).toBe(1)
  // No second wake until the next 30 minutes.
  expect(decide({ ...w, stuckWakes: 1 }, pr(), T0 + 45 * MIN).wake).toBeUndefined()
  const last = decide({ ...w, stuckWakes: MAX_STUCK_WAKES - 1 }, pr(), T0 + MAX_STUCK_WAKES * STUCK_MS)
  expect(last.done).toBe(true)
  expect(last.wake).toContain('NEEDS YOU')
})

test('the merge is reported, and a new head restarts CI watching instead of the merge clock', () => {
  const w = { ...W, greenAt: T0 }
  expect(decide(w, pr({ merged: true }), T0 + 5 * MIN).wake).toContain('merged')
  const pushed = decide(w, pr({ headSha: 'c0ffee0000000000000000000000000000000000' }), T0 + 40 * MIN)
  expect(pushed.done).toBe(false)
  expect(pushed.wake).toBeUndefined()
  expect(pushed.patch?.greenAt).toBeUndefined()
  expect('greenAt' in (pushed.patch ?? {})).toBe(true)
  expect(pushed.patch?.sha).toBe('c0ffee0000000000000000000000000000000000')
})

test('a check that fails on a re-run AFTER green leaves the merge path and wakes as a CI failure (CI reviewer, #2429 finding 1)', () => {
  const w = { ...W, greenAt: T0, stuckWakes: 0 }
  const bad = [{ name: 'lint', status: 'completed', conclusion: 'failure' }]
  const first = decide(w, pr({ runs: bad }), T0 + 5 * MIN)
  expect(first.done).toBe(false)
  const second = decide({ ...w, ...first.patch }, pr({ runs: bad }), T0 + 7 * MIN)
  expect(second.done).toBe(true)
  expect(second.wake).toContain('lint (failure)')
  expect(second.wake).toContain('Auto-merge is armed')
  // A re-run still in progress is CI again too, never a stuck-queue wake.
  expect(decide(w, pr({ runs: [{ name: 'lint', status: 'in_progress', conclusion: null }] }), T0 + STUCK_MS).wake).toBeUndefined()
})

test('a failing check on an armed PR wakes and says auto-merge cannot fire', () => {
  const bad = [{ name: 'independent-review', status: 'completed', conclusion: 'failure' }]
  const p1 = decide(W, pr({ runs: bad }), T0 + 4 * MIN).patch
  const d = decide({ ...W, ...p1 }, pr({ runs: bad }), T0 + 6 * MIN)
  expect(d.done).toBe(true)
  expect(d.wake).toContain('independent-review (failure)')
  expect(d.wake).toContain('Auto-merge is armed')
})

test('stuck reasons: eviction, conflict, draft, missing required result, comment, unknown', () => {
  expect(stuckReasons({ train: { state: 'failure', description: 'evicted at this commit' } })[0]).toContain('evicted it (merge-train failure: evicted at this commit)')
  expect(stuckReasons({ mergeableState: 'dirty' })[0]).toContain('conflicts with main')
  expect(stuckReasons({ mergeableState: 'draft' })[0]).toContain('draft')
  expect(stuckReasons({ mergeableState: 'blocked' })[0]).toContain('required check has no result')
  expect(stuckReasons({ mergeableState: 'blocked', trainComment: 'Evicted: lint failed' }).join(' ')).toContain('"Evicted: lint failed"')
  expect(stuckReasons(undefined)[0]).toContain('no reason visible')
})

test('train status and comment are read from MCP text; noise is ignored', () => {
  expect(parseTrainStatus(JSON.stringify({ statuses: [{ context: 'ci', state: 'success' }, { context: 'merge-train', state: 'FAILURE', description: 'conflict' }] })))
    .toEqual({ state: 'failure', description: 'conflict' })
  expect(parseTrainStatus(JSON.stringify({ statuses: [] }))).toBeUndefined()
  expect(parseTrainStatus('garbage')).toBeUndefined()
  const comments = [
    { body: 'unrelated', created_at: '2026-11-01T00:30:00Z' },
    { body: 'merge-train: evicted, conflicts with abc <!-- merge-train-state {"x":1} -->', created_at: '2026-11-01T00:10:00Z' },
    { body: 'merge-train: older', created_at: '2026-10-31T00:10:00Z' },
  ]
  expect(parseTrainComment(JSON.stringify(comments))).toBe('merge-train: evicted, conflicts with abc')
  expect(parseTrainComment('[]')).toBeUndefined()
})

test('merge facts are read only when a stuck wake is due; keys are stable', () => {
  expect(mergeFactsDue({ ...W, greenAt: T0 }, T0 + 10 * MIN)).toBe(false)
  expect(mergeFactsDue({ ...W, greenAt: T0 }, T0 + STUCK_MS)).toBe(true)
  expect(mergeFactsDue({ ...W, armed: undefined, greenAt: T0 }, T0 + STUCK_MS)).toBe(false)
  expect(watchKey(W)).toBe('pr:brand-bridge-media/bbm-infrastructure#2398')
})

function engine(on: any, prJson: () => any) {
  on('clock.now', () => ({ value: T0 }) as any)
  on('clock.every', () => ({ value: undefined }) as any)
  on('tool.call', { tool: /enable_pr_auto_merge$/ }, () => ({ result: { content: [{ type: 'text', text: 'ok' }] } }))
  on('mcp.call', (_$: any, e: any) => {
    const m = e.args?.method ?? e.arguments?.method ?? e.input?.method
    const text = m === 'get_check_runs' ? JSON.stringify({ check_runs: green }) : JSON.stringify(prJson())
    return { value: { content: [{ type: 'text', text }] } }
  })
}

test('end to end: enable_pr_auto_merge starts an armed watch that `watching` reports', async ($: any, on: any) => {
  engine(on, () => ({ state: 'open', merged: false, head: { sha: SHA } }))
  const r: any = await $.tool.call({ tool: 'mcp__github__enable_pr_auto_merge', owner: 'o', repo: 'r', pullNumber: 9 })
  expect(String(r.context ?? '')).toContain('until it merges')
  const w: any = await $.tool.call({ tool: 'mcp__pr-ci-watch__watching' })
  expect(JSON.parse(String(w.result))).toEqual({ active: ['pr:o/r#9'], finished: [] })
})

test('end to end: re-watching an armed PR (a push, watch_pr) keeps it armed', async ($: any, on: any) => {
  engine(on, () => ({ state: 'open', merged: false, head: { sha: SHA } }))
  await $.tool.call({ tool: 'mcp__github__enable_pr_auto_merge', owner: 'o', repo: 'r', pullNumber: 9 })
  const again: any = await $.tool.call({ tool: 'mcp__pr-ci-watch__watch_pr', owner: 'o', repo: 'r', pullNumber: 9 })
  expect(String(again.result)).toContain('until it merges')
  const other: any = await $.tool.call({ tool: 'mcp__pr-ci-watch__watch_pr', owner: 'o', repo: 'r', pullNumber: 10 })
  expect(String(other.result)).toContain('Watching CI on o/r#10')
})

test('unreadable check runs on an armed, green PR are a read error, never a throw or a stuck wake (#2429 review finding 3)', () => {
  const d = decide({ ...W, greenAt: T0 }, pr({ runs: undefined }), T0 + STUCK_MS)
  expect(d.done).toBe(false)
  expect(d.wake).toBeUndefined()
  expect(d.patch?.errors).toBe(1)
})

test('a re-run on an armed, green PR stops the merge clock; the next green restarts it (#2429 review)', () => {
  const w = { ...W, greenAt: T0, stuckWakes: 1 }
  const running = decide(w, pr({ runs: [{ name: 'lint', status: 'in_progress', conclusion: null }] }), T0 + 5 * MIN)
  expect('greenAt' in (running.patch ?? {})).toBe(true)
  expect(running.patch?.greenAt).toBeUndefined()
  expect(running.patch?.stuckWakes).toBe(0)
  const w2 = { ...w, ...running.patch }
  const g1 = decide(w2, pr(), T0 + 30 * MIN)
  const g2 = decide({ ...w2, ...g1.patch }, pr(), T0 + 32 * MIN)
  expect(g2.wake).toBeUndefined()
  expect(g2.patch?.greenAt).toBe(T0 + 32 * MIN)
})

test('LCH-614: Mergify own checks are queue state, not CI', () => {
  const r = (name: string, status: string, conclusion: string | null) => ({ name, status, conclusion })
  // queued: protections is neutral by design, the queue check is still in progress: neither may stop the PR reading green.
  const queued = splitMergify([r('lint', 'completed', 'success'), r('Mergify Merge Protections', 'completed', 'neutral'), r('Mergify Merge Queue', 'in_progress', null)])
  expect(queued.ci.map(x => x.name)).toEqual(['lint'])
  expect(queued.queue).toEqual({ state: 'queued' })
  // merged: a successful queue check is also not CI.
  expect(splitMergify([r('Mergify Merge Queue', 'completed', 'success')]).ci).toEqual([])
  // dequeued: the failed queue check is reported as queue state (dequeueReason wakes once); it is not also a CI failure.
  const dropped = splitMergify([r('lint', 'completed', 'success'), r('Mergify Merge Queue', 'completed', 'failure')])
  expect(dropped.ci.map(x => x.name)).toEqual(['lint'])
  expect(dropped.queue).toEqual({ state: 'failure' })
  // no Mergify checks at all (tier 0): untouched.
  expect(splitMergify([r('lint', 'completed', 'success')])).toEqual({ ci: [r('lint', 'completed', 'success')] })
})

test('LCH-614: stuck reasons name the queue, a dequeue, and the missing label', () => {
  expect(stuckReasons({ queue: { state: 'failure' } })[0]).toContain('merge queue dropped it')
  expect(stuckReasons({ queue: { state: 'queued' } }).join(' ')).toContain('it is in the merge queue')
  expect(stuckReasons({ mergeableState: 'blocked' }).join(' ')).toContain('`queue` label')
  expect(stuckReasons({ mergeableState: 'blocked', queue: { state: 'queued' } }).join(' ')).not.toContain('required check has no result')
  expect(parseTrainComment(JSON.stringify([{ body: '<!--- x --> Dequeued: the batch failed', created_at: '2026-11-10T00:00:00Z' }]))).toBe('Dequeued: the batch failed')
})

test('LCH-614: a stale dequeue never outlives a re-queue, and a failing Protections rule stays visible', () => {
  const r = (name: string, status: string, conclusion: string | null) => ({ name, status, conclusion })
  const requeued = splitMergify([r('Mergify Merge Queue', 'completed', 'failure'), r('Mergify Merge Queue', 'in_progress', null), r('lint', 'completed', 'success')])
  expect(requeued.ci.map(x => x.name)).toEqual(['lint'])
  expect(requeued.queue).toEqual({ state: 'queued' })
  expect(splitMergify([r('Mergify Merge Protections', 'completed', 'failure')]).ci.map(x => `${x.name}:${x.conclusion}`)).toEqual(['Mergify Merge Protections:failure'])
  expect(splitMergify([r('Mergify Merge Protections', 'completed', 'success')]).ci).toEqual([])
})

test('LCH-614: with no live queue run, the NEWEST finished one decides, whatever the list order', () => {
  const r = (conclusion: string, completedAt: number) => ({ name: 'Mergify Merge Queue', status: 'completed', conclusion, completedAt })
  for (const runs of [[r('failure', 1), r('success', 2)], [r('success', 2), r('failure', 1)]]) {
    const s = splitMergify(runs)
    expect(s.queue).toEqual({ state: 'success' })
    expect(s.ci).toEqual([])
  }
  const bad = splitMergify([r('success', 1), r('failure', 2)])
  expect(bad.queue).toEqual({ state: 'failure' })
  expect(bad.ci.length).toBe(0) // the dequeue is queue state, reported by dequeueReason
})

// LCH-614 (LCH-645): twice in the week of 2026-11-09 a session was not woken when Mergify dequeued its PR.
const DQ = { ...W, greenAt: T0 + 5 * MIN }
test('LCH-614: the dequeued label wakes once, naming Mergify, and keeps watching', () => {
  const d = decide(DQ, pr({ labels: ['queue', 'dequeued'] }), T0 + 20 * MIN)
  expect(d.done).toBe(false)
  expect(d.wake).toMatch(/^\[mod:pr-ci-watch\] brand-bridge-media\/bbm-infrastructure#2398: Mergify dequeued: dequeued label on bb7204e/)
  expect(d.wake).toContain('MERGE-QUEUE.md')
  expect(d.patch?.dequeueSig).toBe(`${SHA}|dequeued label`)
  expect('greenAt' in (d.patch ?? {}) && d.patch?.greenAt === undefined).toBe(true)
  // The same dequeue on the next tick is not announced again.
  const again = decide({ ...DQ, ...d.patch }, pr({ labels: ['queue', 'dequeued'] }), T0 + 22 * MIN)
  expect(again.wake).toBeUndefined()
})

test('LCH-614: a failed Mergify Merge Queue check is the same single wake, not also a CI failure', () => {
  const runs = splitMergify([{ name: 'lint', status: 'completed', conclusion: 'success' }, { name: 'Mergify Merge Queue', status: 'completed', conclusion: 'action_required' }])
  const d = decide(DQ, pr({ runs: runs.ci, queue: runs.queue }), T0 + 20 * MIN)
  expect(d.wake).toContain('Mergify dequeued: Mergify Merge Queue action_required')
  // After that wake the PR reads green again (the queue check is not CI) and no CI-failure wake follows.
  const next = decide({ ...DQ, ...d.patch }, pr({ runs: runs.ci, queue: runs.queue }), T0 + 22 * MIN)
  expect(next.wake).toBeUndefined()
  expect(next.done).toBe(false)
  // Both signals together are named together.
  expect(dequeueReason({ queue: { state: 'failure' }, labels: ['dequeued'] })).toBe('Mergify Merge Queue failure + dequeued label')
})

test('LCH-614: a re-queued PR, a merged PR, an old head and a PR never queued stay quiet', () => {
  // A live queue run beats a lingering label (the PR was re-queued).
  expect(dequeueReason({ queue: { state: 'queued' }, labels: ['dequeued'] })).toBeUndefined()
  expect(dequeueReason({ queue: { state: 'success' }, labels: [] })).toBeUndefined()
  expect(dequeueReason({ labels: ['queue'] })).toBeUndefined()
  expect(dequeueReason({ queue: { state: 'neutral' } })).toBeUndefined()
  // Reviewer finding (#3180): an unfamiliar finished non-success conclusion is still a drop.
  expect(dequeueReason({ queue: { state: 'stale' } })).toBe('Mergify Merge Queue stale')
  expect(dequeueReason({ queue: { state: 'unknown' } })).toBe('Mergify Merge Queue unknown')
  expect(decide(DQ, pr({ merged: true, labels: ['dequeued'] }), T0 + 20 * MIN).wake).toContain('merged')
  // Right after a push the PR can still show the old head: its queue state is not this push's.
  const w = { ...DQ, sha: 'c0ffee0000000000000000000000000000000000' }
  expect(decide(w, pr({ labels: ['dequeued'] }), T0 + 6 * MIN).wake).toBeUndefined()
  // A new dequeue on a new head wakes again.
  const d = decide({ ...DQ, dequeueSig: `old|dequeued label` }, pr({ labels: ['dequeued'] }), T0 + 20 * MIN)
  expect(d.wake).toContain('Mergify dequeued')
})

test('LCH-614: an UNARMED watch is told about a dequeue too', () => {
  const d = decide({ ...W, armed: undefined }, pr({ labels: ['dequeued'] }), T0 + 4 * MIN)
  expect(d.wake).toContain('Mergify dequeued')
})

test('LCH-614: parsePr reads labels as strings or objects, lower-cased', () => {
  const base = { state: 'open', head: { sha: SHA } }
  expect(parsePr(JSON.stringify({ ...base, labels: [{ name: 'Queue' }, 'Dequeued'] }))?.labels).toEqual(['queue', 'dequeued'])
  expect(parsePr(JSON.stringify(base))?.labels).toEqual([])
})

test('LCH-614: after a dequeue wake, no "stuck in the queue" wake follows while the PR is still dequeued (reviewer finding, #3180)', () => {
  const first = decide(DQ, pr({ labels: ['dequeued'] }), T0 + 20 * MIN)
  const w = { ...DQ, ...first.patch, greenAt: T0 }
  const later = decide(w, pr({ labels: ['dequeued'] }), T0 + 3 * STUCK_MS)
  expect(later.wake).toBeUndefined()
  expect(later.done).toBe(false)
  // Re-queued (live queue run): the normal merge clock applies again.
  expect(decide(w, pr({ labels: ['dequeued'], queue: { state: 'queued' }, merge: { mergeableState: 'dirty' } }), T0 + STUCK_MS).wake).toContain('not merged after')
})
