import { test, expect } from 'claude-code/testing'

import { world, JIRA, DIAG, TICKET_TRIGGER } from './fixture'

// LC-1711 callout convention: what the mod adds is prefixed `[mod:where-we-stand]` in the text the model reads
// AND toasted for the operator. An untriggered call carries neither.

test('the injected card is prefixed and a toast names the mod', async ($: any, on: any) => {
  const w = world(on, { trigger: TICKET_TRIGGER })
  const r: any = await $.tool.call(JIRA)
  expect(r.context[0]).toMatch(/^\[mod:where-we-stand\] /)
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toMatch(/^\[mod:where-we-stand\] card for LC-1345: /)
})

test('an untriggered call carries neither', async ($: any, on: any) => {
  const w = world(on)
  const r: any = await $.tool.call(DIAG)
  expect(r.context).toBeUndefined()
  expect(w.toasts).toHaveLength(0)
})
