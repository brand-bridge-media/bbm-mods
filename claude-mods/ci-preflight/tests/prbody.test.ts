import { test, expect } from 'claude-code/testing'

import { bodyFromGet, parseRemote, pickOpenPr } from '../hooks/logic'
import { world, bash } from './fixture'

// LCH-582: the open PR's body carries the schema-drift "by design" overrides CI reads; the mod must pass
// it to preflight.sh, or a declared column is blocked locally while CI passes it.

const BODY = 'read-only by design: contract_sends.partner_email: written only by contract_send()'
const PR = (over: Record<string, unknown> = {}) => ({ number: 2289, state: 'open', head: { ref: 'lc1846-x' }, body: BODY, ...over })

test('the open PR body is written into the git dir and passed as the third argument', async ($, on) => {
  const w = world(on, { exit: 0, prs: [PR()] })
  const r: any = await $.tool.call(bash('git push'))
  expect(r.deny).toBeUndefined()
  expect(w.writes).toEqual([{ body: BODY, path: '/work/repo/.git/ci-preflight-pr-body.md' }])
  expect(w.preflightRuns[0]!.argv).toEqual(['bash', '/work/repo/scripts/ci/preflight.sh', '/work/repo', 'origin/main', '/work/repo/.git/ci-preflight-pr-body.md'])
  expect(r.context.join('\n')).toContain('PR #2289')
  const list = w.mcpCalls.find(c => c.tool === 'list_pull_requests')!
  expect(list.args).toMatchObject({ owner: 'brand-bridge-media', repo: 'bbm-infrastructure', head: 'brand-bridge-media:lc1846-x', state: 'open' })
})

test('a list answer without bodies fetches the PR body with pull_request_read get', async ($, on) => {
  const w = world(on, { exit: 0, prs: [PR({ body: undefined })], prGet: { number: 2289, body: BODY } })
  await $.tool.call(bash('git push'))
  expect(w.mcpCalls.some(c => c.tool === 'pull_request_read' && c.args.method === 'get' && c.args.pullNumber === 2289)).toBe(true)
  expect(w.writes[0]!.body).toBe(BODY)
})

const noBody = (name: string, opts: Record<string, unknown>) =>
  test(`${name}: preflight runs exactly as before (three arguments, no note)`, async ($, on) => {
    const w = world(on, { exit: 0, ...opts })
    const r: any = await $.tool.call(bash('git push'))
    expect(w.preflightRuns[0]!.argv.length).toBe(4)
    expect(w.writes.length).toBe(0)
    expect((r.context ?? []).join('\n')).not.toContain('PR #')
  })
noBody('no open PR', { prs: [] })
noBody('no origin remote', { remote: null, prs: [PR()] })
noBody('an empty PR body', { prs: [PR({ body: '' })] })
noBody('a detached HEAD (no branch to look up)', { branch: 'HEAD', prs: [PR({ head: { ref: 'HEAD' } })] })

test('a connector that throws is skipped and the next name is tried', async ($, on) => {
  const w = world(on, { exit: 0, prs: [PR()], failServers: ['github'] })
  await $.tool.call(bash('git push'))
  expect(w.mcpCalls.filter(c => c.tool === 'list_pull_requests').map(c => c.server)).toEqual(['github', 'GitHub_Custom'])
  expect(w.preflightRuns[0]!.argv.length).toBe(5)
})

test('a blocked push says nothing in the command ran, so a chained commit was not made', async ($, on) => {
  world(on, { exit: 1, output: 'FAIL         schema-drift\npreflight: 0 passed, 1 failed, 0 not checked' })
  const r: any = await $.tool.call(bash('git commit -m x && git push'))
  expect(r.deny).toContain('NOTHING in this command ran')
  expect(r.deny).toContain('commit was NOT made')
})

test('PREFLIGHT_SKIP=1 never looks the PR up', async ($, on) => {
  const w = world(on, { exit: 1, prs: [PR()] })
  await $.tool.call(bash('PREFLIGHT_SKIP=1 git push'))
  expect(w.mcpCalls.length).toBe(0)
  expect(w.writes.length).toBe(0)
})

test('parseRemote: https, ssh, the session proxy path; garbage is refused', async () => {
  expect(parseRemote('https://github.com/brand-bridge-media/bbm-infrastructure.git')).toEqual({ owner: 'brand-bridge-media', repo: 'bbm-infrastructure' })
  expect(parseRemote('git@github.com:brand-bridge-media/bbm-mods.git\n')).toEqual({ owner: 'brand-bridge-media', repo: 'bbm-mods' })
  expect(parseRemote('http://local_proxy@127.0.0.1:41753/git/brand-bridge-media/bbm-infrastructure')).toEqual({ owner: 'brand-bridge-media', repo: 'bbm-infrastructure' })
  expect(parseRemote('')).toBeUndefined()
  expect(parseRemote('not a url')).toBeUndefined()
})

test('pickOpenPr: exactly one open PR from the branch, in an array or wrapped; ambiguity or junk gives nothing', async () => {
  expect(pickOpenPr(JSON.stringify([PR()]), 'lc1846-x')).toEqual({ number: 2289, body: BODY })
  expect(pickOpenPr(JSON.stringify({ pull_requests: [PR()] }), 'lc1846-x')?.number).toBe(2289)
  expect(pickOpenPr(JSON.stringify([PR({ head: { ref: 'other' } })]), 'lc1846-x')).toBeUndefined()
  expect(pickOpenPr(JSON.stringify([PR(), PR({ number: 2290 })]), 'lc1846-x')).toBeUndefined()
  expect(pickOpenPr(JSON.stringify([PR({ state: 'closed' })]), 'lc1846-x')).toBeUndefined()
  expect(pickOpenPr('not json', 'lc1846-x')).toBeUndefined()
  expect(bodyFromGet(JSON.stringify({ body: 'x' }))).toBe('x')
  expect(bodyFromGet('nope')).toBeUndefined()
})
