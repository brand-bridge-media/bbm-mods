import { test, expect } from 'claude-code/testing'

import { world, bash } from './fixture'

const FAILING = 'preflight: 5 changed\nFAIL         schema-drift (3 column(s) judged)\n    | FAIL: github_workflow_runs.workflow_id: missing reader and writer reference(s)\npreflight: 0 passed, 1 failed, 0 not checked'

test('exit 1 denies the push, shows the failing lines and the bypass; nothing reaches the engine', async ($, on) => {
  const w = world(on, { exit: 1, output: FAILING })
  const r: any = await $.tool.call(bash('git push -u origin lc1846-x'))
  expect(r.deny).toMatch(/^\[mod:ci-preflight\] push blocked/)
  expect(r.deny).toContain('github_workflow_runs.workflow_id')
  expect(r.deny).toContain('PREFLIGHT_SKIP=1')
  expect(w.reached.length).toBe(0)
  expect(w.preflightRuns.length).toBe(1)
  expect(w.preflightRuns[0]!.argv.slice(0, 2)).toEqual(['bash', '/work/repo/scripts/ci/preflight.sh'])
  expect(w.preflightRuns[0]!.timeoutMs).toBe(180_000)
})

test('exit 0 allows the push with a quiet one-line note and no toast', async ($, on) => {
  const w = world(on, { exit: 0 })
  const r: any = await $.tool.call(bash('git push'))
  expect(r.deny).toBeUndefined()
  expect(w.reached.length).toBe(1)
  expect(r.context.length).toBe(1)
  expect(r.context[0]).toMatch(/^\[mod:ci-preflight\] preflight passed/)
  expect(w.toasts.length).toBe(0)
})

test('exit 2 allows and lists the NOT CHECKED items', async ($, on) => {
  const w = world(on, { exit: 2, output: 'PASS  x\nNOT CHECKED  portal tsc: no node_modules in operations-portal\npreflight: 1 passed, 0 failed, 1 not checked' })
  const r: any = await $.tool.call(bash('git push'))
  expect(r.deny).toBeUndefined()
  expect(w.reached.length).toBe(1)
  expect(r.context.join('\n')).toContain('NOT CHECKED portal tsc')
  expect(r.context.join('\n')).toContain('not a pass')
  expect(w.toasts.length).toBe(1)
})

test('a timeout allows with a NOT CHECKED warning (never blocks on our own slowness)', async ($, on) => {
  // The rejection's wording is not a contract: 180 s of elapsed mock time with a generic message is a timeout.
  const w = world(on, { throwMsg: 'killed', hangMs: 180_000 })
  const r: any = await $.tool.call(bash('git push'))
  expect(r.deny).toBeUndefined()
  expect(w.reached.length).toBe(1)
  expect(r.context.join('\n')).toMatch(/timed out after 180s: NOT CHECKED/)
})

test('a crash of the script itself (rejection, odd exit code) allows with a warning', async ($, on) => {
  const a = world(on, { throwMsg: 'spawn bash ENOENT' })
  const r1: any = await $.tool.call(bash('git push'))
  expect(r1.deny).toBeUndefined()
  expect(r1.context.join('\n')).toContain('could not run')
  expect(a.reached.length).toBe(1)
})

test('an exit code the script does not define (127) is NOT CHECKED, not a block', async ($, on) => {
  world(on, { exit: 127 })
  const r: any = await $.tool.call(bash('git push'))
  expect(r.deny).toBeUndefined()
  expect(r.context.join('\n')).toContain('exited 127')
})

test('PREFLIGHT_SKIP=1 bypasses the run, lets the push through, and says so', async ($, on) => {
  const w = world(on, { exit: 1, output: FAILING })
  const r: any = await $.tool.call(bash('PREFLIGHT_SKIP=1 git push'))
  expect(r.deny).toBeUndefined()
  expect(w.preflightRuns.length).toBe(0)
  expect(w.reached.length).toBe(1)
  expect(r.context.join('\n')).toContain('bypassed')
  expect(w.toasts.length).toBe(1)
})

test('non-pushes and ignored pushes never run preflight', async ($, on) => {
  const w = world(on, { exit: 1, output: FAILING })
  for (const c of ['git status', 'echo "git push"', 'git push --dry-run', 'git push --delete origin b', 'git push origin :b']) {
    const r: any = await $.tool.call(bash(c))
    expect(r.deny).toBeUndefined()
  }
  expect(w.preflightRuns.length).toBe(0)
  expect(w.reached.length).toBe(5)
})

test('git -C <dir> push resolves the repo from that dir', async ($, on) => {
  const w = world(on, { exit: 1, output: FAILING, top: '/other/repo' })
  const r: any = await $.tool.call(bash('git -C /other/repo/sub push'))
  expect(r.deny).toBeDefined()
  expect(w.gitCalls[0]).toEqual(['git', '-C', '/other/repo/sub', 'rev-parse', '--show-toplevel'])
  expect(w.preflightRuns[0]!.argv[1]).toBe('/other/repo/scripts/ci/preflight.sh')
  expect(w.preflightRuns[0]!.cwd).toBe('/other/repo')
})

test('a repo without scripts/ci/preflight.sh, or no repo at all, is left alone silently', async ($, on) => {
  const w = world(on, { hasScript: false, exit: 1 })
  const r: any = await $.tool.call(bash('git push'))
  expect(r.deny).toBeUndefined()
  expect(r.context).toBeUndefined()
  expect(w.preflightRuns.length).toBe(0)
})

test('an unresolvable directory is NOT CHECKED with a warning', async ($, on) => {
  const w = world(on, { exit: 1 })
  const r: any = await $.tool.call(bash('git -C "$REPO" push'))
  expect(r.deny).toBeUndefined()
  expect(w.preflightRuns.length).toBe(0)
  expect(r.context.join('\n')).toContain('could not work out which directory')
})
