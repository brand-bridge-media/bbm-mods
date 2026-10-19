import { test, expect, mock } from 'claude-code/testing'

import { modActionsIn, withModActions } from '../hooks/modlog'

// LC-1711. session-close never denies or asks, so its callout is the one thing it does that the
// model and Stan should not miss: the wrap-up nudge. It carries `[mod:session-close]` and a toast,
// and it lists what the OTHER mods did ("Mod actions this session: ...") learned from the
// `[mod:<name>]` prefix on tool results and toasts.

const toastsOf = (on: any) => {
  const toasts: string[] = []
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  return toasts
}
const closeOut = async ($: any): Promise<string> =>
  JSON.stringify(await $.command.run({ command: 'close-out', args: '' } as any))

test('the wrap-up nudge is prefixed [mod:session-close] and toasts the unmet count and the mod actions', async ($, on) => {
  mock.store(on)
  const toasts = toastsOf(on)
  on('tool.call', (_$: any, e: any) =>
    (e.tool === 'mcp__x__guarded'
      ? { deny: '[mod:run-state] v2_s10 is BLOCKED by 9 Receipts audit' }
      : { result: 'ok', text: 'ok' }) as any)
  on('ui.status', (() => ({ value: undefined })) as any)
  on('turn.complete', ((_$: any, e: any) => ({ text: e.answer })) as any)
  await $.tool.call({ tool: 'mcp__srv__transitionJiraIssue', issueIdOrKey: 'LC-1711' } as any)
  await $.tool.call({ tool: 'mcp__x__guarded' } as any)
  await $.turn.complete({ answer: 'All done and merged.', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' } as any)
  const nudge = toasts.find(t => t.includes('close-out item(s) unmet'))
  expect(nudge).toBeDefined()
  expect(nudge!.startsWith('[mod:session-close]')).toBe(true)
  expect(nudge!).toContain('Mod actions this session: [run-state: v2_s10 is BLOCKED by 9 Receipts audit]')
})

test('a [mod:<name>] deny and a [mod:<name>] result are both listed by /close-out', async ($, on) => {
  mock.store(on)
  on('tool.call', (_$: any, e: any) =>
    (e.tool === 'Bash'
      ? { deny: '[mod:refresh-run-guard] publish-shaped call. Publishing is a human click.' }
      : { result: 'ok', text: '[mod:fleet-tracker] Tracking session_x as LC-1.' }) as any)
  await $.tool.call({ tool: 'Bash', command: 'curl publish' } as any)
  await $.tool.call({ tool: 'mcp__fleet-tracker__track', session_id: 'session_x' } as any)
  const out = await closeOut($)
  expect(out).toContain('Mod actions this session:')
  expect(out).toContain('refresh-run-guard: publish-shaped call. Publishing is a human click.')
  expect(out).toContain('fleet-tracker: Tracking session_x as LC-1.')
})

test('nothing from a mod is reported as "none seen", and its own tag is not counted', async ($, on) => {
  mock.store(on)
  on('tool.call', () => ({ result: 'ok', text: '[mod:session-close] my own nudge' }) as any)
  await $.tool.call({ tool: 'mcp__x__other' } as any)
  expect(await closeOut($)).toContain('Mod actions this session: none seen')
})

// LC-1711 review follow-ups: one action must not be listed twice, and quoted text is not an action.
const LONG = 'v2_s11c5 refused: it is not READY; it is BLOCKED by Render-integrity check and 6 other unmet blockers that keep going well past the toast limit'
const cut = (full: string) => (full.length > 160 ? `${full.slice(0, 157)}...` : full)

// A toast is cut at 160 characters with "..."; the deny that caused it is not. A test module cannot
// fire a toast, so the dedupe is proven on the pure helpers (the live path is the same two calls).
const ledger = (modActions: string[] = []): any => ({ modActions })
const fullDeny = `[mod:run-state] ${LONG} ${LONG}`
const cutToast = cut(fullDeny)

test('a toast cut at 160 characters and its full deny are one entry, in either order', () => {
  const full = modActionsIn([fullDeny])
  const toast = modActionsIn([cutToast])
  expect(toast[0].endsWith('...')).toBe(true)
  const denyFirst = withModActions(withModActions(ledger(), full), toast).modActions
  const toastFirst = withModActions(withModActions(ledger(), toast), full).modActions
  expect(denyFirst.length).toBe(1)
  expect(toastFirst.length).toBe(1)
  // The fuller wording wins over the cut one, whichever came first.
  expect(denyFirst[0].endsWith('...')).toBe(false)
  expect(toastFirst[0].endsWith('...')).toBe(false)
  expect(toastFirst[0]).toBe(denyFirst[0])
})

test('only a "..."-cut text is treated as a stem; a plain prefix is a different action', () => {
  const a = modActionsIn(['[mod:run-state] v2_s10 is BLOCKED'])
  const b = modActionsIn(['[mod:run-state] v2_s10 is BLOCKED by 9 Receipts audit'])
  expect(withModActions(withModActions(ledger(), a), b).modActions.length).toBe(2)
})

test('the same reason from two different mods stays two entries', () => {
  const l = withModActions(withModActions(ledger(), modActionsIn(['[mod:run-state] BLOCKED'])), modActionsIn(['[mod:draft-session] BLOCKED']))
  expect(l.modActions.length).toBe(2)
})

test('a mod never lists its own tag, and only a string that STARTS with a tag counts', () => {
  expect(modActionsIn(['[mod:session-close] my own nudge'])).toEqual([])
  expect(modActionsIn(['see [mod:run-state] in the README'])).toEqual([])
  expect(modActionsIn(['  [mod:run-state] indented is still a start'])).toEqual(['run-state: indented is still a start'])
})

test('two different reasons from the same mod stay two entries', async ($, on) => {
  mock.store(on)
  let n = 0
  on('tool.call', () => ({ deny: n++ === 0 ? '[mod:run-state] v2_s10 is BLOCKED' : '[mod:run-state] v2_s11c5 is BLOCKED' }) as any)
  await $.tool.call({ tool: 'Bash', command: 'a' } as any)
  await $.tool.call({ tool: 'Bash', command: 'b' } as any)
  expect((await closeOut($)).match(/run-state:/g)?.length).toBe(2)
})

test('only a mod tool speaks through its result; any other tool counts by deny / context alone', async ($, on) => {
  mock.store(on)
  on('tool.call', (_$: any, e: any) => (e.tool === 'mcp__fleet-tracker__track'
    ? { result: '[mod:fleet-tracker] Tracking s as LC-1.' }
    : e.tool === 'mcp__any__search'
      ? { result: '[mod:a-file] first line of a search hit', context: ['[mod:run-state] attached by a mod'] }
      : { result: 'ok' }) as any)
  await $.tool.call({ tool: 'mcp__fleet-tracker__track' } as any)
  await $.tool.call({ tool: 'mcp__any__search' } as any)
  const out = await closeOut($)
  expect(out).toContain('fleet-tracker: Tracking s as LC-1.')
  expect(out).toContain('run-state: attached by a mod')
  expect(out).not.toContain('a-file')
})

test('[mod:] text quoted inside a diff, a file read or command output is not an action', async ($, on) => {
  mock.store(on)
  on('tool.call', (_$: any, e: any) => ({
    result: e.tool === 'Read' ? 'README line: [mod:fake-one] quoted in a file' : 'ok',
    text: e.tool === 'Bash'
      ? '[mod:fake-two] a command whose output happens to begin with a tag\n+  // say [mod:fake-three] in the reply'
      : e.tool === 'mcp__github__get_file_contents' ? '[mod:fake-four] a file whose first line is a tag' : 'ok',
  }) as any)
  await $.tool.call({ tool: 'Bash', command: 'git diff' } as any)
  await $.tool.call({ tool: 'Read', file_path: '/x' } as any)
  await $.tool.call({ tool: 'mcp__github__get_file_contents' } as any)
  expect(await closeOut($)).toContain('Mod actions this session: none seen')
})
