import { test, expect } from 'claude-code/testing'

import { labelNames, labelsAfter, pickOpenPr, tierFromReceipt } from '../hooks/logic'
import { world, bash } from './fixture'

// LCH-615 Phase 0: after a push, put the diff's risk tier on the open PR as a label. Labelling is not a
// gate: nothing here may deny a push or slow the 180 s preflight, and every miss is silent.

const RECEIPT = (label: string) => `RESULT=PASS label=${label} files=3 why=the highest-tier changed file decides\n`
const PR = (labels?: unknown) => ({ number: 2301, state: 'open', head: { ref: 'lc1846-x' }, body: 'b', labels })
const writes = (w: ReturnType<typeof world>) => w.mcpCalls.filter(c => c.tool === 'issue_write')

test('a pushed branch with an open PR gets the tier label, keeping the PR\'s other labels', async ($, on) => {
  const w = world(on, { exit: 0, hasTierScript: true, tierOut: RECEIPT('tier:T1-strict'), prs: [PR([{ name: 'bug' }, { name: 'tier:T0' }])] })
  const r: any = await $.tool.call(bash('git push'))
  expect(r.deny).toBeUndefined()
  expect(writes(w).length).toBe(1)
  expect(writes(w)[0]!.args).toEqual({ method: 'update', owner: 'brand-bridge-media', repo: 'bbm-infrastructure', issue_number: 2301, labels: ['bug', 'tier:T1-strict'] })
  expect(r.context.join('\n')).toContain('PR #2301 labelled tier:T1-strict')
})

test('the tier is computed from the diff against origin/main, in its own 20 s box', async ($, on) => {
  const w = world(on, { exit: 0, hasTierScript: true, tierOut: RECEIPT('tier:T1'), prs: [PR([])] })
  await $.tool.call(bash('git push'))
  expect(w.tierRuns.length).toBe(1)
  expect(w.tierRuns[0]!.timeoutMs).toBe(20_000)
  expect(w.tierRuns[0]!.argv[2]).toContain('diff --name-only --no-renames origin/main...HEAD')
  expect(w.preflightRuns[0]!.timeoutMs).toBe(180_000) // the preflight box is unchanged
})

test('a PR that already carries the right label is not written to', async ($, on) => {
  const w = world(on, { exit: 0, hasTierScript: true, tierOut: RECEIPT('tier:T2'), prs: [PR([{ name: 'tier:T2' }])] })
  const r: any = await $.tool.call(bash('git push'))
  expect(writes(w).length).toBe(0)
  expect(r.context.join('\n')).toContain('already carries tier:T2')
})

test('a list answer without labels reads them with pull_request_read before writing', async ($, on) => {
  const w = world(on, { exit: 0, hasTierScript: true, tierOut: RECEIPT('tier:T0'), prs: [PR(undefined)], prGet: { number: 2301, body: 'b', labels: [{ name: 'ci:priority' }] } })
  await $.tool.call(bash('git push'))
  expect(writes(w)[0]!.args.labels).toEqual(['ci:priority', 'tier:T0'])
})

const silent = (name: string, opts: Record<string, unknown>) =>
  test(`${name}: no label write, push untouched, nothing said about tiers`, async ($, on) => {
    const w = world(on, { exit: 0, prs: [PR([])], ...opts })
    const r: any = await $.tool.call(bash('git push'))
    expect(r.deny).toBeUndefined()
    expect(writes(w).length).toBe(0)
    expect((r.context ?? []).join('\n')).not.toContain('tier:')
  })
silent('a repo without tier_label.py', { hasTierScript: false, tierOut: RECEIPT('tier:T1') })
silent('NOT CHECKED receipt', { hasTierScript: true, tierOut: 'RESULT=NOT CHECKED label= files=0 why=no changed files were read\n' })
silent('the script fails', { hasTierScript: true, tierExit: 1, tierOut: RECEIPT('tier:T1') })
silent('an unknown label in the receipt', { hasTierScript: true, tierOut: RECEIPT('tier:T9') })
silent('no open PR yet (the CI labeller covers it)', { hasTierScript: true, tierOut: RECEIPT('tier:T1'), prs: [] })
silent('no origin remote', { hasTierScript: true, tierOut: RECEIPT('tier:T1'), remote: null })
silent('a detached HEAD', { hasTierScript: true, tierOut: RECEIPT('tier:T1'), branch: 'HEAD', prs: [PR([])] })
silent('unreadable labels (writing could drop the real ones)', { hasTierScript: true, tierOut: RECEIPT('tier:T1'), prs: [PR(undefined)], prGet: { number: 2301, labels: 'junk' } })

test('issue_write reports an error: the write was tried once, the push is untouched, no false "labelled" note', async ($, on) => {
  const w = world(on, { exit: 0, hasTierScript: true, tierOut: RECEIPT('tier:T1'), prs: [PR([])], writeError: true })
  const r: any = await $.tool.call(bash('git push'))
  expect(r.deny).toBeUndefined()
  expect(writes(w).length).toBe(1)
  expect((r.context ?? []).join('\n')).not.toContain('labelled')
})

test('a push that failed is not labelled', async ($, on) => {
  const w = world(on, { exit: 0, engineError: true, hasTierScript: true, tierOut: RECEIPT('tier:T1'), prs: [PR([])] })
  await $.tool.call(bash('git push'))
  expect(w.tierRuns.length).toBe(0)
})

test('a blocked push (preflight failed) is not labelled', async ($, on) => {
  const w = world(on, { exit: 1, output: 'FAIL         schema-drift\n', hasTierScript: true, tierOut: RECEIPT('tier:T1'), prs: [PR([])] })
  const r: any = await $.tool.call(bash('git push'))
  expect(r.deny).toBeDefined()
  expect(w.tierRuns.length).toBe(0)
})

test('PREFLIGHT_SKIP=1 still labels (labelling is not a check)', async ($, on) => {
  const w = world(on, { exit: 1, hasTierScript: true, tierOut: RECEIPT('tier:T1'), prs: [PR([])] })
  await $.tool.call(bash('PREFLIGHT_SKIP=1 git push'))
  expect(writes(w).length).toBe(1)
})

test('a connector that throws is skipped and the next name is tried', async ($, on) => {
  const w = world(on, { exit: 0, hasTierScript: true, tierOut: RECEIPT('tier:T1'), prs: [PR([])], failServers: ['github'] })
  await $.tool.call(bash('git push'))
  expect(writes(w).map(c => c.server)).toEqual(['GitHub_Custom'])
})

test('tierFromReceipt: only a PASS line with a known label counts', async () => {
  expect(tierFromReceipt(RECEIPT('tier:T0'))).toBe('tier:T0')
  expect(tierFromReceipt(RECEIPT('tier:T1-strict'))).toBe('tier:T1-strict')
  expect(tierFromReceipt('noise\n' + RECEIPT('tier:T2'))).toBe('tier:T2')
  expect(tierFromReceipt('RESULT=NOT CHECKED label= files=0 why=x')).toBeUndefined()
  expect(tierFromReceipt(RECEIPT('tier:T3'))).toBeUndefined()
  expect(tierFromReceipt(RECEIPT('T1'))).toBeUndefined()
  expect(tierFromReceipt('')).toBeUndefined()
})

test('labelsAfter: replace stale tier labels, keep the rest, write nothing when already right', async () => {
  expect(labelsAfter([], 'tier:T1')).toEqual(['tier:T1'])
  expect(labelsAfter(['bug'], 'tier:T1')).toEqual(['bug', 'tier:T1'])
  expect(labelsAfter(['tier:T0', 'bug'], 'tier:T2')).toEqual(['bug', 'tier:T2'])
  expect(labelsAfter(['tier:T0', 'tier:T1'], 'tier:T1')).toEqual(['tier:T1']) // two tier labels: drop the stale one
  expect(labelsAfter(['bug', 'tier:T1'], 'tier:T1')).toBeUndefined()
  expect(labelsAfter(['tiers', 'tier'], 'tier:T1')).toEqual(['tiers', 'tier', 'tier:T1']) // lookalikes are not tier labels
})

test('labelNames: objects or strings; junk is undefined, never a partial list', async () => {
  expect(labelNames([{ name: 'a' }, 'b'])).toEqual(['a', 'b'])
  expect(labelNames([])).toEqual([])
  expect(labelNames(undefined)).toBeUndefined()
  expect(labelNames('x')).toBeUndefined()
  expect(labelNames([{ name: 'a' }, { id: 3 }])).toBeUndefined()
  expect(labelNames([{ name: '' }])).toBeUndefined()
  expect(pickOpenPr(JSON.stringify([PR([{ name: 'bug' }])]), 'lc1846-x')?.labels).toEqual(['bug'])
})
