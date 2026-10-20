import { test, expect } from 'claude-code/testing'

// LC-1869: a cloud drafting session (no service role) pins itself with a tool, and gets the credentialed CI lint
// instead of a local one. Both directions are tested, because a guard that only ever says "no" looks identical to
// one that works: the pin must TAKE EFFECT, must NOT be movable by the model, and nothing may unlock without a
// real lint PASS.

const RUN = '11111111-1111-4111-8111-111111111111'
const ART = '22222222-2222-4222-8222-222222222222'
const OTHER_RUN = '33333333-3333-4333-8333-333333333333'
const OTHER_ART = '44444444-4444-4444-8444-444444444444'
const PIN = 'mcp__draft-session__draft_pin'
const REQ = 'mcp__draft-session__draft_lint_request'
const DISPATCH = 'mcp__github__actions_run_trigger'
const RECEIPT = `python3 webflow/bulk-operations/refresh-receipt-writer/write_stage_receipt.py --run-id ${RUN} --stage 6 --status done --summary "Draft done"`
const GOOD = { result: { passed: true, brief_scanned: true, testers_block_scanned: true, experts_block_scanned: true, counts: { v2_method_rules_run: true } } }

type X = { key?: boolean; envRun?: string; envArt?: string }
function setup(on: any, x: X = {}) {
  const toasts: string[] = []
  const ran: string[][] = []
  on('fs.read', (_$: any, e: any) => {
    if (e.path === '/home/user/bbm-refresh-agent/stages/v2_s6_draft.md') return { value: '# contract' } as any
    if (String(e.path).includes('draft-session-lint-')) return { value: JSON.stringify(GOOD) } as any
    throw new Error(`ENOENT ${e.path}`)
  })
  on('env.get', (_$: any, e: any) => {
    if (e.name === 'SUPABASE_SERVICE_ROLE_KEY') return { value: x.key ? 'service-role-key' : undefined } as any
    if (e.name === 'BBM_INFRA_PATH') return { value: '/infra' } as any
    if (e.name === 'BBM_DRAFT_RUN_ID') return { value: x.envRun } as any
    if (e.name === 'BBM_DRAFT_ARTICLE_ID') return { value: x.envArt } as any
    return { value: undefined } as any
  })
  on('session.root', () => ({ value: '/work' }) as any)
  on('fs.stat', () => ({ value: { isFile: true } }) as any)
  on('clock.now', () => ({ value: 1 }) as any)
  on('process.run', (_$: any, e: any) => {
    if (e.argv[0] === 'mktemp') return { value: { exitCode: 0, stdout: '/tmp/draft-session-lint-Zq81xW02\n', stderr: '' } } as any
    ran.push([...e.argv])
    return { value: { exitCode: 0, stdout: 'PASS', stderr: '' } } as any
  })
  on('tool.call', () => ({ result: { text: 'ran' } }) as any)
  on('ui.status', () => ({ value: undefined }) as any)
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  return { toasts, ran }
}
const pin = ($: any, run = RUN, art = ART, extra: any = {}) => $.tool.call({ tool: PIN, run_id: run, article_id: art, ...extra } as any)
const bash = async ($: any, command: string) => JSON.stringify(await $.tool.call({ tool: 'Bash', command } as any))

test('draft_pin pins an unpinned session and the guards then bite', async ($, on) => {
  const { toasts } = setup(on)
  expect(await bash($, RECEIPT)).not.toContain('blocked') // unpinned: not gated at all
  const r: any = await pin($)
  expect(r.result).toMatch(/^\[mod:draft-session\] /)
  expect(r.result).toContain(`pinned to run ${RUN}`)
  expect(toasts.some(t => t.startsWith('[mod:draft-session] session pinned'))).toBe(true)
  expect(await bash($, RECEIPT)).toContain('Draft receipt blocked') // the SAME call is now gated
  const other: any = await $.tool.call({ tool: 'Write', file_path: '/work/bbm-content/other-article.md', content: 'x' } as any)
  expect(other.deny).toBeDefined() // pinned with no slug: every article file refused
})

test('draft_pin refuses non-uuid input, prefixed and toasted, and pins nothing', async ($, on) => {
  const { toasts } = setup(on)
  for (const bad of [{ run_id: 'x', article_id: ART }, { run_id: RUN, article_id: '' }, { run_id: undefined, article_id: undefined }]) {
    const r: any = await $.tool.call({ tool: PIN, ...bad } as any)
    expect(r.deny).toMatch(/^\[mod:draft-session\] draft_pin REFUSED/)
  }
  expect((await $.tool.call({ tool: PIN, run_id: RUN, article_id: ART, slug: 'Bad Slug!' } as any) as any).deny).toContain('REFUSED')
  expect(toasts.length).toBe(4)
  expect(await bash($, RECEIPT)).not.toContain('blocked') // still unpinned
})

test('the same run again is a no-op and does not re-lock a lint pass', async ($, on) => {
  setup(on, { key: true })
  await pin($)
  await $.command.run({ command: 'draft-done', args: '' } as any)
  expect(await bash($, RECEIPT)).not.toContain('blocked') // credentialed session: local lint passed
  const again: any = await pin($, RUN.toUpperCase(), ART)
  expect(again.result).toContain('no change')
  expect(await bash($, RECEIPT)).not.toContain('blocked')
})

test('a different run is refused and the original pin stays', async ($, on) => {
  const { toasts } = setup(on)
  await pin($)
  toasts.length = 0
  const r: any = await pin($, OTHER_RUN, OTHER_ART)
  expect(r.deny).toMatch(/^\[mod:draft-session\] draft_pin REFUSED/)
  expect(r.deny).toContain(RUN)
  expect(toasts.length).toBe(1)
  const sameRunOtherArticle: any = await pin($, RUN, OTHER_ART)
  expect(sameRunOtherArticle.deny).toContain('REFUSED')
  // still pinned to the first run: a receipt for the other run is a pin violation, one for the pin is gated
  expect(await bash($, RECEIPT.replace(RUN, OTHER_RUN))).toContain('this session drafts run')
  expect(await bash($, RECEIPT)).toContain('Draft receipt blocked')
})

test('a pin can gain a slug but never swap it', async ($, on) => {
  setup(on)
  await pin($)
  expect(((await pin($, RUN, ART, { slug: 'best-sofas' })) as any).result).toContain('slug best-sofas')
  expect(((await pin($, RUN, ART, { slug: 'other-slug' })) as any).deny).toContain('already names slug best-sofas')
  const own: any = await $.tool.call({ tool: 'Write', file_path: '/work/bbm-content/best-sofas.md', content: 'x' } as any)
  expect(own.deny).toBeUndefined()
})

test('there is no tool that unpins or clears: draft_pin with empty ids leaves the pin', async ($, on) => {
  setup(on)
  await pin($)
  const r: any = await $.tool.call({ tool: PIN, run_id: '', article_id: '' } as any)
  expect(r.deny).toContain('REFUSED')
  expect(await bash($, RECEIPT)).toContain('Draft receipt blocked')
})

async function startAndProbe($: any, on: any, x: X) {
  const { toasts } = setup(on, x)
  on('session.start', (() => ({ cwd: '/tmp' })) as any)
  on('command.register', (() => ({ value: undefined })) as any)
  on('tool.register', (() => ({ value: undefined })) as any)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  return { blocked: (await bash($, RECEIPT)).includes('Draft receipt blocked'), toasts }
}

test('session.start pins from BBM_DRAFT_RUN_ID / BBM_DRAFT_ARTICLE_ID', async ($, on) => {
  const { blocked, toasts } = await startAndProbe($, on, { envRun: RUN, envArt: ART })
  expect(blocked).toBe(true)
  expect(toasts.some(t => t.startsWith('[mod:draft-session] session pinned'))).toBe(true)
})

test('a malformed env pin pins nothing and says so', async ($, on) => {
  const { blocked, toasts } = await startAndProbe($, on, { envRun: RUN, envArt: 'nope' })
  expect(blocked).toBe(false)
  expect(toasts.some(t => t.startsWith('[mod:draft-session]') && t.includes('NOT pinned'))).toBe(true)
})

test('a half-set or absent env pin pins nothing', async ($, on) => {
  expect((await startAndProbe($, on, { envRun: RUN })).blocked).toBe(false)
})

test('/draft-done with no service-role key runs no lint and hands over the CI dispatch; nothing unlocks', async ($, on) => {
  const { toasts, ran } = setup(on, { key: false })
  await pin($)
  toasts.length = 0
  const r: any = await $.command.run({ command: 'draft-done', args: '' } as any)
  expect(ran.length).toBe(0) // no lint here: it could only exit 2
  expect(r.text).toMatch(/^\[mod:draft-session\] /)
  expect(r.text).toContain('run-refresh-stage-gate.yml')
  expect(r.text).toContain('"gate":"stage-6-draft"')
  expect(r.text).toContain(`"run_id":"${RUN}"`)
  expect(r.text).toContain('"dry_run":"false"')
  expect(r.text).toContain('mcp__github__actions_run_trigger')
  expect(toasts.length).toBe(1)
  expect(await bash($, RECEIPT)).toContain('Draft receipt blocked') // still locked, however often it is asked
  await $.command.run({ command: 'draft-done', args: '/work/plan.json' } as any)
  expect(ran.length).toBe(0)
  expect(await bash($, RECEIPT)).toContain('Draft receipt blocked')
})

test('draft_lint_request: refused when unpinned, returns the dispatch when pinned, unlocks nothing, re-locks a stale pass', async ($, on) => {
  setup(on, { key: true })
  const none: any = await $.tool.call({ tool: REQ } as any)
  expect(none.deny).toMatch(/^\[mod:draft-session\] draft_lint_request REFUSED/)
  await pin($)
  await $.command.run({ command: 'draft-done', args: '' } as any)
  expect(await bash($, RECEIPT)).not.toContain('blocked') // a real local PASS (credentialed session)
  const r: any = await $.tool.call({ tool: REQ } as any)
  expect(r.result).toMatch(/^\[mod:draft-session\] /)
  expect(r.result).toContain('"gate":"stage-6-draft"')
  expect(r.result).toContain('Do not write the stage-6 receipt yourself')
  expect(await bash($, RECEIPT)).toContain('Draft receipt blocked') // asking for CI never leaves a pass standing
})

test('a session-written passing stage-6 receipt stays denied in every form (the CI receipt is the only path)', async ($, on) => {
  setup(on, { key: false })
  await pin($)
  await $.tool.call({ tool: REQ } as any)
  await $.command.run({ command: 'draft-done', args: '' } as any)
  const sql = `update refresh_run_sections set status = 'done' where run_id = '${RUN}' and section_key = 'v2_s6'`
  const viaSql: any = await $.tool.call({ tool: 'mcp__Supabase__execute_sql', query: sql } as any)
  expect(viaSql.deny).toContain('Draft receipt blocked')
  const viaStages = `update refresh_runs set stages = stages || '[{"stage":6,"status":"done"}]'::jsonb where id = '${RUN}'`
  expect(((await $.tool.call({ tool: 'mcp__Supabase__execute_sql', query: viaStages } as any)) as any).deny).toContain('Draft receipt blocked')
  expect(await bash($, RECEIPT)).toContain('Draft receipt blocked')
})

const OWN = { run_id: RUN, gate: 'stage-6-draft', dry_run: 'false' }
const dispatch = ($: any, over: any = {}) =>
  $.tool.call({ tool: DISPATCH, method: 'run_workflow', owner: 'mykhaylenkostan', repo: 'bbm-infrastructure',
    workflow_id: 'run-refresh-stage-gate.yml', ref: 'main', inputs: OWN, ...over } as any)

test('unpinned: dispatches are not gated at all (pinning only adds restrictions)', async ($, on) => {
  setup(on)
  expect(((await dispatch($, { ref: 'some-branch', inputs: { ...OWN, run_id: OTHER_RUN } })) as any).deny).toBeUndefined()
})

test('pinned: the one exact dispatch passes (object or JSON-string inputs)', async ($, on) => {
  setup(on)
  await pin($)
  expect(((await dispatch($)) as any).deny).toBeUndefined()
  expect(((await dispatch($, { inputs: JSON.stringify(OWN) })) as any).deny).toBeUndefined()
  expect(((await dispatch($, { inputs: { ...OWN, run_id: RUN.toUpperCase() } })) as any).deny).toBeUndefined()
})

for (const [label, over, needle] of [
  ['a branch ref', { ref: 'my-branch' }, 'ref'],
  ['refs/heads/main', { ref: 'refs/heads/main' }, 'ref'],
  ['a missing ref', { ref: undefined }, 'ref'],
  ['a different repo', { repo: 'other-repo' }, 'only mykhaylenkostan/bbm-infrastructure'],
  ['a different owner', { owner: 'someone-else' }, 'only mykhaylenkostan/bbm-infrastructure'],
  ['a different gate', { inputs: { ...OWN, gate: 'both' } }, 'gate'],
  ['a missing gate', { inputs: { run_id: RUN } }, 'gate'],
  ['a different run', { inputs: { ...OWN, run_id: OTHER_RUN } }, OTHER_RUN],
  ['no run', { inputs: { gate: 'stage-6-draft' } }, '(none)'],
  ['unparseable inputs', { inputs: '{not json' }, 'could not read'],
  ['a numeric workflow id', { workflow_id: 123456 }, 'workflow_id'],
  ['a numeric-string workflow id', { workflow_id: '123456' }, 'workflow_id'],
  ['another workflow', { workflow_id: 'some-other-workflow.yml' }, 'workflow_id'],
  ['the workflow name with a prefix', { workflow_id: 'x/run-refresh-stage-gate.yml' }, 'workflow_id'],
  ['a rerun method', { method: 'rerun_workflow_run' }, 'only method run_workflow'],
] as const) {
  test(`pinned: a dispatch with ${label} is denied, prefixed and toasted`, async ($, on) => {
    const { toasts } = setup(on)
    await pin($)
    toasts.length = 0
    const r: any = await dispatch($, over)
    expect(r.deny).toMatch(/^\[mod:draft-session\] /)
    expect(r.deny).toContain(needle)
    expect(toasts.length).toBe(1)
  })
}

test('BBM_DRAFT_RUN_ID is the only run draft_pin accepts, even with no in-memory pin (a reload lost it)', async ($, on) => {
  setup(on, { envRun: RUN, envArt: ART })
  const bad: any = await pin($, OTHER_RUN, OTHER_ART)
  expect(bad.deny).toMatch(/^\[mod:draft-session\] draft_pin REFUSED/)
  expect(bad.deny).toContain('BBM_DRAFT_RUN_ID')
  expect(((await pin($, RUN, OTHER_ART)) as any).deny).toContain('BBM_DRAFT_ARTICLE_ID')
  expect(await bash($, RECEIPT)).not.toContain('blocked') // nothing was pinned by the refused calls
  expect(((await pin($)) as any).result).toContain('pinned to run') // the env run itself is accepted
  expect(await bash($, RECEIPT)).toContain('Draft receipt blocked')
})

// ---- shell routes to a workflow run (gh, direct API calls) ----
const SHELL_DENIED = [
  'gh workflow run x --ref evil',
  'gh api repos/mykhaylenkostan/bbm-infrastructure/dispatches -f event_type=x',
  'GH_TOKEN=x gh workflow run run-refresh-stage-gate.yml --ref my-branch',
  'curl -X POST https://api.github.com/repos/o/r/actions/workflows/1/dispatches -d \'{"ref":"evil"}\'',
  'bash -c "gh workflow run x --ref evil"',
  'GH   Workflow    run x',
  "gh 'workflow' run x",
  'gh -R o/r run rerun 123',
  'gh --repo=o/r api repos/o/r/actions/runs/1/rerun',
  'wget --post-data=x "https://API.GITHUB.COM/repos/o/r/actions/runs/9/rerun"',
  'http POST api.github.com/repos/o/r/dispatches ref=evil',
  'cd /tmp && curl -s -XPOST https://api.github.com/repos/o/r/actions/runs/1/cancel',
]

test('pinned: workflow dispatch through the shell is denied in every spelling, prefixed and toasted', async ($, on) => {
  const { toasts } = setup(on)
  await pin($)
  for (const command of SHELL_DENIED) {
    toasts.length = 0
    const r: any = await $.tool.call({ tool: 'Bash', command } as any)
    expect(r.deny, command).toMatch(/^\[mod:draft-session\] /)
    expect(toasts.length, command).toBe(1)
  }
})

test('pinned: ordinary shell commands are untouched', async ($, on) => {
  setup(on)
  await pin($)
  for (const command of ['ls', 'git status', 'git push origin lc1869', 'echo "github workflow run"', 'curl -s https://example.com/dispatches', 'python3 draft.py --run-id x', 'gh pr view 12'])
    expect(((await $.tool.call({ tool: 'Bash', command } as any)) as any).deny, command).toBeUndefined()
})

test('unpinned: the shell ban does not apply (pinning only adds restrictions)', async ($, on) => {
  setup(on)
  expect(((await $.tool.call({ tool: 'Bash', command: 'gh workflow run x --ref evil' } as any)) as any).deny).toBeUndefined()
})

test('the env pin keeps the dispatch and shell guards on after a reload (no in-memory pin)', async ($, on) => {
  setup(on, { envRun: RUN, envArt: ART }) // no session.start, no draft_pin: the in-memory run is null
  for (const command of SHELL_DENIED.slice(0, 5))
    expect(((await $.tool.call({ tool: 'Bash', command } as any)) as any).deny, command).toMatch(/^\[mod:draft-session\] /)
  expect(((await dispatch($, { ref: 'my-branch' })) as any).deny).toMatch(/^\[mod:draft-session\] /)
  expect(((await dispatch($, { inputs: { ...OWN, run_id: OTHER_RUN } })) as any).deny).toContain(OTHER_RUN)
  expect(((await dispatch($, { workflow_id: 99 })) as any).deny).toContain('workflow_id')
  expect(((await dispatch($)) as any).deny).toBeUndefined() // the one exact dispatch still passes
})

test('a half-set or malformed env pin does not turn the guards on', async ($, on) => {
  setup(on, { envRun: RUN })
  expect(((await $.tool.call({ tool: 'Bash', command: 'gh workflow run x' } as any)) as any).deny).toBeUndefined()
  expect(((await dispatch($, { ref: 'my-branch' })) as any).deny).toBeUndefined()
})

test('pinned: a non-string run_id (number, array, null) is denied, never compared loosely', async ($, on) => {
  setup(on)
  await pin($)
  for (const run_id of [123, [RUN], null]) {
    const r: any = await dispatch($, { inputs: { ...OWN, run_id } })
    expect(r.deny, JSON.stringify(run_id)).toMatch(/^\[mod:draft-session\] /)
    expect(r.deny).toContain('(none)')
  }
})
