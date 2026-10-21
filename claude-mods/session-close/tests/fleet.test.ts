import { test, expect, mock } from 'claude-code/testing'

// LC-1835: Claude closes out the child sessions it spins up (the operator, 2026-10-15), so /close-out lists the
// ones fleet-tracker still has open. session-close reads them through fleet-tracker's open_children
// tool; fleet-tracker is another plugin, so these tests stand in for it with a tool.call handler.
// When it is not loaded the call fails, and that must read as "not checked", never "zero children".

const OPEN_TOOL = 'mcp__fleet-tracker__open_children'
const closeOut = async ($: any): Promise<string> =>
  JSON.stringify(await $.command.run({ command: 'close-out', args: '' } as any))

function fleetTracker(on: any, reply: () => unknown) {
  mock.store(on)
  on('tool.call', { tool: OPEN_TOOL }, () => reply() as any)
}

test('open fleet children are an unmet close-out obligation', async ($, on) => {
  fleetTracker(on, () => ({
    result: 'Open fleet children: 2\n- LC-9 (build x) COMPLETED session_a\n- LC-8 (fix y) WORKING session_b',
  }))
  const out = await closeOut($)
  expect(out).toContain('Close-out: 1 unmet')
  expect(out).toContain('Fleet: 2 child session(s) still open')
  expect(out).toContain('LC-9 (build x) COMPLETED session_a')
  expect(out).toContain('LC-8 (fix y) WORKING session_b')
  expect(out).toContain('keep_reason')
  expect(out).toContain('LC-1835')
})

test('the obligation is met when fleet-tracker reports no open children', async ($, on) => {
  fleetTracker(on, () => ({ result: 'Open fleet children: 0' }))
  const out = await closeOut($)
  expect(out).not.toContain('Fleet:')
  expect(out).toContain('nothing unmet')
  expect(out).toContain('0 open fleet child')
})

test('the list is re-read each time: closing the children clears the obligation', async ($, on) => {
  let text = 'Open fleet children: 1\n- LC-9 (build x) COMPLETED session_a'
  fleetTracker(on, () => ({ result: text }))
  expect(await closeOut($)).toContain('Fleet: 1 child session(s)')
  text = 'Open fleet children: 0'
  expect(await closeOut($)).not.toContain('Fleet:')
})

test('without fleet-tracker loaded the call fails: close-out still works and says NOT CHECKED', async ($, on) => {
  mock.store(on) // no handler for the tool: the call rejects, as it does when the plugin is absent
  const out = await closeOut($)
  expect(out).toContain('Close-out: nothing unmet')
  expect(out).toContain('fleet children NOT CHECKED')
  expect(out).not.toContain('Fleet:')
})

test('an error or an unrecognised reply is "not loaded", never zero children and never a crash', async ($, on) => {
  let reply: unknown = {}
  fleetTracker(on, () => reply)
  for (const r of [
    { result: 'Open fleet children: 3\n- LC-1 (x) COMPLETED session_a', isError: true },
    { deny: 'tool refused' },
    { result: 'ok' },
    { result: '' },
    // The header must match the list (CI review, PR #1816): a short or empty list is unreadable.
    { result: 'Open fleet children: 5' },
    { result: 'Open fleet children: 3\n- LC-1 (x) COMPLETED session_a' },
    { result: 'Open fleet children: 1\n- a\n- b' },
  ]) {
    reply = r
    const out = await closeOut($)
    expect(out).toContain('NOT CHECKED')
    expect(out).not.toContain('Fleet:')
  }
})

test('a stale list is dropped when fleet-tracker stops answering', async ($, on) => {
  let up = true
  mock.store(on)
  on('tool.call', { tool: OPEN_TOOL }, () => {
    if (!up) throw new Error('no such tool')
    return { result: 'Open fleet children: 1\n- LC-9 (build x) COMPLETED session_a' } as any
  })
  expect(await closeOut($)).toContain('Fleet: 1 child session(s)')
  up = false
  const out = await closeOut($)
  expect(out).not.toContain('Fleet:')
  expect(out).toContain('NOT CHECKED')
})

test('a wrap-up turn nudges about open fleet children', async ($, on) => {
  const toasts: string[] = []
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  on('turn.complete', () => ({ text: 'done' }) as any)
  fleetTracker(on, () => ({ result: 'Open fleet children: 1\n- LC-9 (build x) COMPLETED session_a' }))
  await ($ as any).turn.complete({ reason: 'answer', answer: 'All done and merged.' })
  expect(toasts.join(' ')).toContain('1 close-out item(s) unmet')
})
