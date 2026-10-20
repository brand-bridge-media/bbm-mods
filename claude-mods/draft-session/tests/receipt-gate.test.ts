import { test, expect } from 'claude-code/testing'

// The Draft receipt (stage 6 -> done) must be impossible while draft-lint fails
// and possible once it passes. Both directions are tested: a gate that only ever
// says "no" would look identical to a gate that works (LC-1307 defect class).

const RUN = '11111111-1111-4111-8111-111111111111'
const ART = '22222222-2222-4222-8222-222222222222'
const OPTS = { runId: RUN, articleId: ART, slug: 'best-sofas', templateVariant: 'v1', contractPath: '/contract/v2_s6_draft.md' }
const RECEIPT = `python3 webflow/bulk-operations/refresh-receipt-writer/write_stage_receipt.py --run-id ${RUN} --stage 6 --status done --summary "Draft done"`

const GOOD_RECEIPT = { result: { passed: true, brief_scanned: true, testers_block_scanned: true, experts_block_scanned: true, counts: {} } }
type Extra = { engineTool?: () => unknown; receipt?: unknown; plan?: unknown; infra?: string | null; stat?: boolean; key?: boolean; mktemp?: boolean }

// lintExit: what draft_lint.py exits with. contract: null = file unreadable.
// The mock plays the lint: it records argv and serves the receipt the real lint would write to --output.
function setup($: any, on: any, lintExit: number, contract: string | null = '# v2_s6 contract\nrules...', x: Extra = {}) {
  const ran: string[][] = []
  const receipt = x.receipt ?? (lintExit === 0 ? GOOD_RECEIPT : { result: { passed: false } })
  on('fs.read', (_$: any, e: any) => {
    if (e.path === '/contract/v2_s6_draft.md') {
      if (contract === null) throw new Error(`ENOENT ${e.path}`)
      return { value: contract } as any
    }
    if (String(e.path).includes('draft-session-lint-')) return { value: JSON.stringify(receipt) } as any
    if (e.path === '/work/plan.json') return { value: JSON.stringify(x.plan ?? { article_id: ART, entries: [] }) } as any
    throw new Error(`ENOENT ${e.path}`)
  })
  // BBM_INFRA_PATH names the checkout; SUPABASE_SERVICE_ROLE_KEY present = the session can run the lint (LC-1869: absent routes to CI).
  on('env.get', (_$: any, e: any) => {
    if (e.name === 'SUPABASE_SERVICE_ROLE_KEY') return { value: x.key === false ? undefined : 'service-role-key' } as any
    if (e.name === 'BBM_INFRA_PATH') return { value: x.infra === null ? undefined : (x.infra ?? '/infra') } as any
    return { value: undefined } as any
  })
  on('session.root', () => ({ value: '/work' }) as any)
  on('fs.stat', (_$: any, e: any) => {
    if (x.stat === false) throw new Error(`ENOENT ${e.path}`)
    return { value: { isFile: true } } as any
  })
  on('clock.now', () => ({ value: 1 }) as any)
  on('process.run', (_$: any, e: any) => {
    if (e.argv[0] === 'mktemp') return x.mktemp === false ? { value: { exitCode: 1, stdout: '', stderr: 'no tmp' } } as any : { value: { exitCode: 0, stdout: '/tmp/draft-session-lint-Zq81xW02\n', stderr: '' } } as any
    ran.push([...e.argv])
    return { value: { exitCode: lintExit, stdout: lintExit === 0 ? 'PASS' : 'FAIL [tester_not_anonymous] entry 3', stderr: '' } } as any
  })
  on('tool.call', () => (x.engineTool ? x.engineTool() : { result: { text: 'ran' } }) as any)
  on('ui.status', () => ({ value: undefined }) as any)
  on('ui.toast', () => ({ value: undefined }) as any)
  return ran
}

const callBash = async ($: any, command: string) => JSON.stringify(await $.tool.call({ tool: 'Bash', command } as any))

test('failing lint blocks the Draft receipt', { options: OPTS }, async ($, on) => {
  const ran = setup($, on, 1)
  const done = await $.command.run({ command: 'draft-done', args: '' } as any)
  expect(JSON.stringify(done)).toContain('did NOT pass')
  expect(JSON.stringify(done)).toContain('tester_not_anonymous') // failures are shown, not swallowed
  expect(ran.length).toBe(1) // lint really ran: the deny below is not "nothing happened"
  expect(await callBash($, RECEIPT)).toContain('Draft receipt blocked')
})

test('passing lint allows the Draft receipt', { options: OPTS }, async ($, on) => {
  setup($, on, 0)
  await $.command.run({ command: 'draft-done', args: '' } as any)
  const out = await callBash($, RECEIPT)
  expect(out).not.toContain('blocked')
  expect(out).toContain('ran') // reached the (mock) Bash beneath the guard
})

test('no lint run at all blocks the receipt', { options: OPTS }, async ($, on) => {
  setup($, on, 0)
  expect(await callBash($, RECEIPT)).toContain('has not been run')
})

test('lint that cannot run (exit 2) is not a pass', { options: OPTS }, async ($, on) => {
  setup($, on, 2)
  await $.command.run({ command: 'draft-done', args: '' } as any)
  expect(await callBash($, RECEIPT)).toContain('Draft receipt blocked')
})

test('an edit after a pass re-locks the receipt', { options: OPTS }, async ($, on) => {
  setup($, on, 0)
  await $.command.run({ command: 'draft-done', args: '' } as any)
  await $.tool.call({ tool: 'Write', file_path: '/r/bbm-content/best-sofas.md', content: 'x' } as any)
  expect(await callBash($, RECEIPT)).toContain('re-run /draft-done')
})

test('the SQL form of the Draft receipt is gated the same way', { options: OPTS }, async ($, on) => {
  setup($, on, 1)
  const sql = `update refresh_run_sections set status='done' where run_id='${RUN}' and section='v2_s6'`
  const out = JSON.stringify(await $.tool.call({ tool: 'mcp__x__execute_sql', project_id: 'p', query: sql } as any))
  expect(out).toContain('Draft receipt blocked')
})

test('a partial receipt and a different stage are not gated', { options: OPTS }, async ($, on) => {
  setup($, on, 1)
  expect(await callBash($, RECEIPT.replace('--status done', '--status partial --remaining x'))).not.toContain('blocked')
  expect(await callBash($, RECEIPT.replace('--stage 6', '--stage 6.5'))).not.toContain('blocked')
})

test('receipt for another run is refused even after a pass', { options: OPTS }, async ($, on) => {
  setup($, on, 0)
  await $.command.run({ command: 'draft-done', args: '' } as any)
  const other = RECEIPT.replace(RUN, '99999999-9999-4999-8999-999999999999')
  expect(await callBash($, other)).toContain('this session drafts run')
})

test('writes to another article are refused', { options: OPTS }, async ($, on) => {
  setup($, on, 0)
  const bad = `update roundup_slots set blurb_1='x' where article_id='33333333-3333-4333-8333-333333333333'`
  expect(JSON.stringify(await $.tool.call({ tool: 'mcp__x__execute_sql', project_id: 'p', query: bad } as any))).toContain('article_id')
  const good = `update roundup_slots set blurb_1='x' where article_id='${ART}'`
  expect(JSON.stringify(await $.tool.call({ tool: 'mcp__x__execute_sql', project_id: 'p', query: good } as any))).toContain('ran')
  expect(await callBash($, `python3 write_article_content.py write --run-id ${RUN} --article-id 33333333-3333-4333-8333-333333333333`)).toContain('not this run')
})

test('an unpinned session is untouched', async ($, on) => {
  setup($, on, 1)
  expect(await callBash($, RECEIPT)).toContain('ran')
})

test('a draft writer CLI or any article-table write re-locks the receipt', { options: OPTS }, async ($, on) => {
  setup($, on, 0)
  const relock = async (act: () => Promise<unknown>) => {
    await $.command.run({ command: 'draft-done', args: '' } as any)
    expect(await callBash($, RECEIPT)).not.toContain('blocked') // unlocked first, so the next deny is caused by `act`
    await act()
    expect(await callBash($, RECEIPT)).toContain('re-run /draft-done')
  }
  await relock(() => callBash($, `python3 write_article_content.py write --run-id ${RUN}`))
  await relock(() => callBash($, `python3 write_key_details.py write --run-id ${RUN}`))
  await relock(() => $.tool.call({ tool: 'mcp__x__execute_sql', project_id: 'p', query: `update article_selection_briefs set x=1 where article_id='${ART}'` } as any))
  // a dry run changes nothing, so it must NOT re-lock
  await $.command.run({ command: 'draft-done', args: '' } as any)
  await callBash($, `python3 write_article_content.py write --run-id ${RUN} --dry-run`)
  expect(await callBash($, RECEIPT)).not.toContain('blocked')
})

test('slug pin matches the whole file stem, not a substring', { options: OPTS }, async ($, on) => {
  setup($, on, 0)
  const w = async (p: string) => JSON.stringify(await $.tool.call({ tool: 'Write', file_path: p, content: 'x' } as any))
  expect(await w('/r/bbm-content/not-best-sofas.md')).toContain('not this run')
  expect(await w('/r/bbm-content/best-sofas.md')).not.toContain('not this run')
})

test('Bash-borne SQL receipt, unbound article pin, stage=6 shape and Bash rewrites are all handled', { options: OPTS }, async ($, on) => {
  setup($, on, 1)
  const sql = (q: string) => async () => JSON.stringify(await $.tool.call({ tool: 'mcp__x__execute_sql', project_id: 'p', query: q } as any))
  // psql form of the receipt
  expect(await callBash($, `psql -c "update refresh_run_sections set status='done' where run_id='${RUN}' and section='v2_s6'"`)).toContain('Draft receipt blocked')
  // stage=6 spelling, no v2_s6 token
  expect(await sql(`update refresh_run_sections set status='done' where run_id='${RUN}' and stage=6`)()).toContain('Draft receipt blocked')
  // the pin as a bare uuid in a comment is NOT a binding
  expect(await sql(`update roundup_slots set blurb_1='x' where true; -- ${ART}`)()).toContain('article_id')
  expect(await sql(`update roundup_slots set blurb_1='x' where id='s1' and article_id='${ART}'`)()).toContain('ran')
  // a Bash rewrite after a pass re-locks
})

test('a Bash file rewrite after a pass re-locks the receipt', { options: OPTS }, async ($, on) => {
  setup($, on, 0)
  await $.command.run({ command: 'draft-done', args: '' } as any)
  expect(await callBash($, RECEIPT)).not.toContain('blocked')
  await callBash($, `sed -i 's/our tester/Jane/' /r/bbm-content/best-sofas.md`)
  expect(await callBash($, RECEIPT)).toContain('re-run /draft-done')
  // read-only Bash with 2>&1 must NOT re-lock
  await $.command.run({ command: 'draft-done', args: '' } as any)
  await callBash($, 'ls -la 2>&1')
  expect(await callBash($, RECEIPT)).not.toContain('blocked')
})

test('run pin must be a bound predicate, and a draft writer must name its article', { options: OPTS }, async ($, on) => {
  setup($, on, 0)
  await $.command.run({ command: 'draft-done', args: '' } as any) // passing lint: only the pin can stop the next calls
  const sql = async (q: string) => JSON.stringify(await $.tool.call({ tool: 'mcp__x__execute_sql', project_id: 'p', query: q } as any))
  expect(await sql(`update refresh_run_sections set status='done' where section='v2_s6'; -- ${RUN}`)).toContain('run_id')
  expect(await sql(`update refresh_run_sections set status='done' where run_id='${RUN}' and section='v2_s6'`)).toContain('ran')
  expect(await callBash($, 'python3 write_article_content.py')).toContain('names no run')
  expect(await callBash($, 'python3 write_article_content.py write --slug other-article')).toContain('names no run') // slug alone is no pin
  expect(await callBash($, 'python3 write_article_content.py write --run-id 99999999-9999-4999-8999-999999999999')).toContain('not this session')
  expect(await callBash($, `python3 write_key_details.py write --run-id ${RUN}`)).not.toContain('names no run')
})

test('fail-closed shapes: any passing status on a run table, receipt writer with no/garbled --stage', { options: OPTS }, async ($, on) => {
  setup($, on, 1)
  const sql = async (q: string) => JSON.stringify(await $.tool.call({ tool: 'mcp__x__execute_sql', project_id: 'p', query: q } as any))
  expect(await sql(`update refresh_run_sections set status='done' where run_id='${RUN}'`)).toContain('Draft receipt blocked')
  // findings-only write (no status) must stay open: draft-lint reads those findings, so they come BEFORE the receipt
  expect(await sql(`update refresh_run_sections set findings='{}' where run_id='${RUN}' and section='v2_s6'`)).toContain('ran')
  const w = 'python3 webflow/bulk-operations/refresh-receipt-writer/write_stage_receipt.py'
  expect(await callBash($, `${w} --run-id ${RUN} --status done`)).toContain('Draft receipt blocked')
  expect(await callBash($, `${w} --run-id ${RUN} --stage abc --status done`)).toContain('Draft receipt blocked')
  expect(await callBash($, `${w} --run-id ${RUN} --stage="" --status done`)).toContain('Draft receipt blocked')
  expect(await callBash($, `${w} --run-id ${RUN} --stage='' --status done`)).toContain('Draft receipt blocked')
  expect(await callBash($, `${w} --run-id ${RUN} --stage 7 --status done`)).not.toContain('blocked')
})

test('status spelled any way is gated: upper case, unquoted, INSERT column list; not-passing and findings-only stay open', { options: OPTS }, async ($, on) => {
  setup($, on, 1)
  const sql = async (q: string) => JSON.stringify(await $.tool.call({ tool: 'mcp__x__execute_sql', project_id: 'p', query: q } as any))
  const blocked = 'Draft receipt blocked'
  expect(await sql(`UPDATE refresh_run_sections SET status='DONE' WHERE run_id='${RUN}'`)).toContain(blocked)
  expect(await sql(`update refresh_run_sections set status=done where run_id='${RUN}'`)).toContain(blocked)
  expect(await sql(`insert into refresh_run_sections (run_id, section, status) values ('${RUN}', 'v2_s6', 'done')`)).toContain(blocked)
  expect(await sql(`update refresh_run_sections set status = some_expr() where run_id='${RUN}'`)).toContain(blocked)
  expect(await sql(`update refresh_run_sections set status='partial' where run_id='${RUN}'`)).toContain('ran')
  expect(await sql(`update refresh_run_sections set findings='{}' where run_id='${RUN}'`)).toContain('ran')
})

test('a gate that throws BEFORE next() was reached denies, and the tool never runs', { options: OPTS }, async ($, on) => {
  let calls = 0
  setup($, on, 0, undefined, { engineTool: () => { calls++; return { result: { text: 'ran' } } } })
  // a non-string command makes the guard's own string handling throw before it reaches next()
  const out = JSON.stringify(await $.tool.call({ tool: 'Bash', command: 12345 } as any))
  expect(out).toContain('its guard failed')
  expect(calls).toBe(0)
})

test('offline plan for another article never unlocks the receipt', { options: OPTS }, async ($, on) => {
  const ran = setup($, on, 0, undefined, { plan: { article_id: '33333333-3333-4333-8333-333333333333', entries: [] } })
  const done = JSON.stringify(await $.command.run({ command: 'draft-done', args: '/work/plan.json' } as any))
  expect(done).toContain('not this run')
  expect(ran.length).toBe(1) // the lint ran and exited 0: the wrong plan, not a lint failure, is what locks it
  expect(await callBash($, RECEIPT)).toContain('Draft receipt blocked')
})

test('offline plan passes --run-id so the heading and template checks run', { options: OPTS }, async ($, on) => {
  const ran = setup($, on, 0)
  await $.command.run({ command: 'draft-done', args: '/work/plan.json' } as any)
  expect(ran[0]).toContain('--run-id')
  expect(ran[0]).toContain(RUN)
  expect(ran[0]).toContain('--plan')
})

test('a PASS that skipped the heading check is a partial lint: receipt stays locked and says so', { options: OPTS }, async ($, on) => {
  setup($, on, 0, undefined, { receipt: { result: { passed: true, brief_scanned: false, counts: {} } } })
  const done = JSON.stringify(await $.command.run({ command: 'draft-done', args: '' } as any))
  expect(done).toContain('PARTIAL LINT')
  expect(done).toContain('locked-heading')
  expect(await callBash($, RECEIPT)).toContain('partial lint')
})

test('a V2 plan whose method rules did not run is partial too', { options: OPTS }, async ($, on) => {
  setup($, on, 0, undefined, { plan: { article_id: ART, template_variant: 'v2', entries: [] }, receipt: GOOD_RECEIPT })
  const done = JSON.stringify(await $.command.run({ command: 'draft-done', args: '/work/plan.json' } as any))
  expect(done).toContain('PARTIAL LINT')
  expect(done).toContain('V2 approved-method')
})

test('lint script comes from BBM_INFRA_PATH, else the session root, never the cwd; missing = refuse', { options: OPTS }, async ($, on) => {
  const ran = setup($, on, 0, undefined, { infra: '/infra' })
  await $.command.run({ command: 'draft-done', args: '' } as any)
  expect(ran[0][1]).toBe('/infra/webflow/bulk-operations/draft-lint/draft_lint.py')
})

test('session root is the fallback when BBM_INFRA_PATH is unset', { options: OPTS }, async ($, on) => {
  const ran = setup($, on, 0, undefined, { infra: null })
  await $.command.run({ command: 'draft-done', args: '' } as any)
  expect(ran[0][1]).toBe('/work/webflow/bulk-operations/draft-lint/draft_lint.py')
})

test('no draft_lint.py anywhere: refuse loudly and stay locked', { options: OPTS }, async ($, on) => {
  const ran = setup($, on, 0, undefined, { stat: false })
  const done = JSON.stringify(await $.command.run({ command: 'draft-done', args: '' } as any))
  expect(done).toContain('REFUSED')
  expect(ran.length).toBe(0)
  expect(await callBash($, RECEIPT)).toContain('Draft receipt blocked')
})

test('/draft-start needs a slug', async ($, on) => {
  setup($, on, 0)
  const out = JSON.stringify(await $.command.run({ command: 'draft-start', args: `${RUN} ${ART}` } as any))
  expect(out).toContain('the first three are required')
  // and a session pinned by options WITHOUT a slug refuses every article file rather than allowing them
})

test('file pin: nested paths, no-slug pin, and Bash cp/mv/redirect into another article', { options: OPTS }, async ($, on) => {
  setup($, on, 0)
  const w = async (p: string) => JSON.stringify(await $.tool.call({ tool: 'Write', file_path: p, content: 'x' } as any))
  expect(await w('/r/content/articles/other-one/index.md')).toContain('not this run')
  expect(await w('/r/content/articles/best-sofas/index.md')).not.toContain('not this run')
  expect(await callBash($, 'cp /tmp/x.md /r/bbm-content/other-one.md')).toContain('not this run')
  expect(await callBash($, 'echo hi > /r/bbm-content/other-one.md')).toContain('not this run')
  expect(await callBash($, 'mv /tmp/x.md /r/bbm-content/best-sofas.md')).not.toContain('not this run')
})

test('a pin with no slug refuses article files outright', { options: { runId: RUN, articleId: ART, slug: '', contractPath: '/contract/v2_s6_draft.md' } }, async ($, on) => {
  setup($, on, 0)
  const out = JSON.stringify(await $.tool.call({ tool: 'Write', file_path: '/r/bbm-content/anything.md', content: 'x' } as any))
  expect(out).toContain('no slug is pinned')
})

test('scratch and notes edits do not re-lock; the linted plan file does', { options: OPTS }, async ($, on) => {
  setup($, on, 0)
  await $.command.run({ command: 'draft-done', args: '/work/plan.json' } as any)
  expect(await callBash($, RECEIPT)).not.toContain('blocked')
  await $.tool.call({ tool: 'Write', file_path: '/tmp/notes.txt', content: 'x' } as any)
  await callBash($, 'echo todo > /tmp/notes.txt')
  expect(await callBash($, RECEIPT)).not.toContain('blocked') // still unlocked: scratch is not the draft
  await $.tool.call({ tool: 'Write', file_path: '/work/plan.json', content: '{}' } as any)
  expect(await callBash($, RECEIPT)).toContain('re-run /draft-done')
})

test('online lint (no plan) with an unknown template stays partial unless the V2 rules ran', { options: { contractPath: '/contract/v2_s6_draft.md' } }, async ($, on) => {
  setup($, on, 0)
  // unknown template (no templateVariant option): strict, GOOD_RECEIPT has no v2_method_rules_run
  const strict = JSON.stringify(await $.command.run({ command: 'draft-start', args: `${RUN} ${ART} best-sofas` } as any))
  expect(strict).toContain('session pinned to run')
  const done = JSON.stringify(await $.command.run({ command: 'draft-done', args: '' } as any))
  expect(done).toContain('PARTIAL LINT')
  expect(done).toContain('V2 approved-method')
  expect(await callBash($, RECEIPT)).toContain('partial lint')
})

test('a run declared v1 unlocks without the V2 rules; a run declared v2 needs them', { options: { contractPath: '/contract/v2_s6_draft.md' } }, async ($, on) => {
  setup($, on, 0)
  await $.command.run({ command: 'draft-start', args: `${RUN} ${ART} best-sofas v1` } as any)
  await $.command.run({ command: 'draft-done', args: '' } as any)
  expect(await callBash($, RECEIPT)).not.toContain('blocked')
  await $.command.run({ command: 'draft-start', args: `${RUN} ${ART} best-sofas v2` } as any)
  await $.command.run({ command: 'draft-done', args: '' } as any)
  expect(await callBash($, RECEIPT)).toContain('partial lint')
})

test('a plan with no article_id is refused explicitly', { options: OPTS }, async ($, on) => {
  setup($, on, 0, undefined, { plan: { entries: [] } })
  const done = JSON.stringify(await $.command.run({ command: 'draft-done', args: '/work/plan.json' } as any))
  expect(done).toContain('carries no article_id')
  expect(await callBash($, RECEIPT)).toContain('Draft receipt blocked')
})

// LC-1869: the local /draft-done is the same pre-receipt lint as the stage-6 gate.
const SCOPE = 'draft_receipt_complete.status'
const withScope = (scoped: unknown) => ({ result: { ...GOOD_RECEIPT.result, counts: { v2_method_rules_run: true, checks_scoped: scoped } } })

test('/draft-done runs the lint with --pre-receipt, in both modes', { options: OPTS }, async ($, on) => {
  const ran = setup($, on, 0)
  await $.command.run({ command: 'draft-done', args: '' } as any)
  await $.command.run({ command: 'draft-done', args: '/work/plan.json' } as any)
  expect(ran.length).toBe(2)
  for (const argv of ran) expect(argv).toContain('--pre-receipt')
})

test('a receipt scoped to exactly the status check unlocks; any other checks_scoped never does', { options: OPTS }, async ($, on) => {
  setup($, on, 0, undefined, { receipt: withScope([SCOPE]) })
  await $.command.run({ command: 'draft-done', args: '' } as any)
  expect(await callBash($, RECEIPT)).not.toContain('blocked')
})

for (const [label, scoped] of [
  ['an extra check', [SCOPE, 'vos_records_present']],
  ['a different check', ['vos_records_present']],
  ['the whole rule', ['draft_receipt_complete']],
  ['an empty list', []],
  ['a bare string', SCOPE],
  ['null', null],
] as const) {
  test(`the mod refuses a lint receipt whose checks_scoped is ${label}`, { options: OPTS }, async ($, on) => {
    setup($, on, 0, undefined, { receipt: withScope(scoped) })
    const done = JSON.stringify(await $.command.run({ command: 'draft-done', args: '' } as any))
    expect(done).toContain('scoped out')
    expect(await callBash($, RECEIPT)).toContain('Draft receipt blocked')
  })
}

test('the lint receipt goes in a directory the mod just created (mktemp), never a predictable /tmp name', { options: OPTS }, async ($, on) => {
  const ran = setup($, on, 0)
  await $.command.run({ command: 'draft-done', args: '' } as any)
  const out = ran[0][ran[0].indexOf('--output') + 1]
  expect(out).toBe('/tmp/draft-session-lint-Zq81xW02/lint.json')
})

test('no private directory for the receipt = no lint, and the receipt stays locked', { options: OPTS }, async ($, on) => {
  const ran = setup($, on, 0, undefined, { mktemp: false })
  const done = JSON.stringify(await $.command.run({ command: 'draft-done', args: '' } as any))
  expect(done).toContain('private directory')
  expect(ran.length).toBe(0)
  expect(await callBash($, RECEIPT)).toContain('Draft receipt blocked')
})
