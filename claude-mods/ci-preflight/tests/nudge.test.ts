import { test, expect } from 'claude-code/testing'

import { nudgeFor, remember, NUDGE_WINDOW_MS } from '../hooks/logic'
import { world, bash, MIN } from './fixture'

test('nudgeFor: inside the window warns, at or past it does not, unknown previous does not', async () => {
  expect(nudgeFor(1000, 1000 + 9 * MIN)).toMatch(/batch fixes into ONE push/)
  expect(nudgeFor(1000, 1000 + NUDGE_WINDOW_MS)).toBeUndefined()
  expect(nudgeFor(1000, 1000 + 11 * MIN)).toBeUndefined()
  expect(nudgeFor(undefined, 5)).toBeUndefined()
  expect(nudgeFor(5000, 1000)).toBeUndefined() // clock went backwards: no claim
})

test('remember drops entries over an hour old and caps the map at 50', async () => {
  const old = { a: 0 }
  expect(Object.keys(remember(old, 'b', 3_700_000))).toEqual(['b'])
  const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, 1000 + i]))
  expect(Object.keys(remember(many, 'new', 2000)).length).toBe(50)
})

test('a second push to the same branch within 10 minutes is warned; the first is not', async ($, on) => {
  const w = world(on, { branch: 'lc1846-x' })
  const first: any = await $.tool.call(bash('git push -u origin lc1846-x'))
  expect(JSON.stringify(first.context)).not.toContain('batch fixes')
  await w.clock.advance(4 * MIN)
  const second: any = await $.tool.call(bash('git push'))
  expect(second.deny).toBeUndefined()
  expect(second.context.join('\n')).toMatch(/\[mod:ci-preflight\] second push to this branch within 10 minutes: batch fixes/)
  expect(w.toasts.some(t => t.includes('batch fixes'))).toBe(true)
})

test('after the window, or on another branch, no warning', async ($, on) => {
  const w = world(on, { branch: 'b1' })
  await $.tool.call(bash('git push origin b1'))
  await w.clock.advance(11 * MIN)
  const late: any = await $.tool.call(bash('git push origin b1'))
  expect(JSON.stringify(late.context)).not.toContain('batch fixes')
  const other: any = await $.tool.call(bash('git push origin b2'))
  expect(JSON.stringify(other.context)).not.toContain('batch fixes')
})

test('a push that failed is not remembered', async ($, on) => {
  const w = world(on, { engineError: true })
  await $.tool.call(bash('git push origin b1'))
  await w.clock.advance(1 * MIN)
  const again: any = await $.tool.call(bash('git push origin b1'))
  expect(JSON.stringify(again.context)).not.toContain('batch fixes')
})

test('a blocked push is not remembered', async ($, on) => {
  const w = world(on, { exit: 1, output: 'FAIL x\npreflight: 0 passed, 1 failed, 0 not checked' })
  await $.tool.call(bash('git push origin b9'))
  await w.clock.advance(1 * MIN)
  const again: any = await $.tool.call(bash('git push origin b9'))
  expect(again.deny).toBeDefined() // still blocked, never a nudge
  expect(again.context).toBeUndefined()
})
