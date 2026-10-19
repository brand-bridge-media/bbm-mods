import { test, expect } from 'claude-code/testing'

// The contract is READ from the refresh-agent file each compose, never pasted in
// this mod; an unreadable file must say so loudly and inject nothing stale.

const OPTS = { runId: 'r1', articleId: 'a1', slug: '', contractPath: '/contract/v2_s6_draft.md' }
const ARGS = { model: 'claude-test', promptModel: 'claude-test', outputStyle: null, traits: [], tools: [], surfaces: [] }
const base = (on: any) => on('prompt.compose', () => ({ sections: [{ id: 'system', text: 'base', scope: 'shared' }] }) as any)
const compose = async ($: any, on: any, read: () => string) => {
  base(on)
  on('fs.read', () => ({ value: read() }) as any)
  return JSON.stringify(await $.prompt.compose(ARGS as any))
}

test('contract text comes from the file, live', { options: OPTS }, async ($, on) => {
  let text = 'CONTRACT-V1 never say our tester'
  base(on)
  on('fs.read', () => ({ value: text }) as any)
  on('ui.toast', () => ({ value: undefined }) as any)
  expect(JSON.stringify(await $.prompt.compose(ARGS as any))).toContain('CONTRACT-V1')
  text = 'CONTRACT-V2 changed upstream'
  const out = JSON.stringify(await $.prompt.compose(ARGS as any))
  expect(out).toContain('CONTRACT-V2')
  expect(out).not.toContain('CONTRACT-V1')
})

test('unreadable contract says so and injects no copy', { options: OPTS }, async ($, on) => {
  const out = await compose($, on, () => { throw new Error('ENOENT') })
  expect(out).toContain('CONTRACT UNAVAILABLE')
  expect(out).toContain('DO NOT draft from memory')
})

test('/draft-done refuses when the contract is unreadable', { options: OPTS }, async ($, on) => {
  on('fs.read', () => { throw new Error('ENOENT') })
  const done = await $.command.run({ command: 'draft-done', args: '' } as any)
  expect(JSON.stringify(done)).toContain('contract unreadable')
})
