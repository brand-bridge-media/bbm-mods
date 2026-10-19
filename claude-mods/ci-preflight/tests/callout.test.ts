import { test, expect } from 'claude-code/testing'

import { world, bash, runs, UPDATE } from './fixture'

// LC-1711 callout convention: a deny or changed state carries [mod:ci-preflight] in the text the model
// reads AND fires a toast; a plain pass carries the prefix but no toast.

test('a push deny is prefixed and toasted', async ($, on) => {
  const w = world(on, { exit: 1, output: 'FAIL x\npreflight: 0 passed, 1 failed, 0 not checked' })
  const r: any = await $.tool.call(bash('git push'))
  expect(r.deny.startsWith('[mod:ci-preflight] ')).toBe(true)
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0]!.startsWith('[mod:ci-preflight] ')).toBe(true)
})

test('an update-branch deny is prefixed and toasted', async ($, on) => {
  const w = world(on, { checks: runs(['x', 'completed', 'failure']) })
  const r: any = await $.tool.call(UPDATE())
  expect(r.deny.startsWith('[mod:ci-preflight] ')).toBe(true)
  expect(w.toasts.length).toBe(1)
})

test('a pass is prefixed but silent; an unrelated Bash call carries neither', async ($, on) => {
  const w = world(on, { exit: 0 })
  const r: any = await $.tool.call(bash('git push'))
  expect(r.context[0].startsWith('[mod:ci-preflight] ')).toBe(true)
  const q: any = await $.tool.call(bash('ls'))
  expect(q.context).toBeUndefined()
  expect(w.toasts.length).toBe(0)
})
