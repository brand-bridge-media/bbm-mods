import { test, expect } from 'claude-code/testing'

import { giveUp, MAX_SEND_FAILS, MAX_WATCH_MS } from '../hooks/logic'

// LCH-543: a watch whose request ids cannot be read must not re-send forever.
const Z = Date.parse('2026-11-25T12:00:00Z')
const w = { workflow: 'refresh-run.yml', startedAt: Z }

test('a fresh watch carries on', () => {
  expect(giveUp(w, Z + 60_000)).toBe(null)
  expect(giveUp({ ...w, sendFails: MAX_SEND_FAILS - 1 }, Z + 60_000)).toBe(null)
})

test('repeated unreadable sends end the watch', () => {
  expect(giveUp({ ...w, sendFails: MAX_SEND_FAILS }, Z + 60_000)).toContain('stopped watching')
})

test('an old watch ends whatever the replies say', () => {
  expect(giveUp(w, Z + MAX_WATCH_MS - 1)).toBe(null)
  expect(giveUp(w, Z + MAX_WATCH_MS)).toContain('6 h')
})
