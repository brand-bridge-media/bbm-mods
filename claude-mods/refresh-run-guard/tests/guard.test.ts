import { test, expect, mock } from 'claude-code/testing'

const WF = 'mcp__webflow__data_cms_tool'
const PRODUCTS = '65fa33419d90d967c68a0963'
const BLOG = '65fa33419d90d967c68a0964'

const passthrough = (on: any, text = 'ok', extra: object = {}) =>
  on('tool.call', () => ({ result: { stdout: text, stderr: '', interrupted: false }, text, ...extra }) as any)

const update = (collection_id: string, fieldData: object, id = 'i1') => ({
  actions: [{ update_collection_items: { collection_id, request: { items: [{ id, fieldData }] } } }],
})

// Rule 1: hand-written receipts.
test('rule 1 denies a receipt UPDATE incl. CTE, allows a SELECT', async ($, on) => {
  passthrough(on)
  const bad: any = await $.tool.call({ tool: 'mcp__x__execute_sql', query: "update refresh_runs set stages = jsonb_set(stages, '{a}', '1') where id = 'r'" } as any)
  expect(bad.deny).toContain('write_stage_receipt.py')
  const cte: any = await $.tool.call({ tool: 'mcp__x__execute_sql', query: "with t as (update public.refresh_run_sections set findings = '{}' returning 1) select * from t" } as any)
  expect(cte.deny).toContain('refresh_run_sections')
  const ok: any = await $.tool.call({ tool: 'mcp__x__execute_sql', query: 'select stages from refresh_runs limit 1' } as any)
  expect(ok.deny).toBeUndefined()
  const other: any = await $.tool.call({ tool: 'mcp__x__execute_sql', query: "update refresh_runs set status = 'done' where id = 'r'" } as any)
  expect(other.deny).toBeUndefined()
})

// Rule 2: Bash publish path.
test('rule 2 denies a curl publish, allows a grep that merely names it', async ($, on) => {
  passthrough(on)
  const bad: any = await $.tool.call({ tool: 'Bash', command: 'curl -X POST https://api.webflow.com/v2/sites/abc/publish -d {}' } as any)
  expect(bad.deny).toContain('human click')
  const py: any = await $.tool.call({ tool: 'Bash', command: "python3 -c \"client.publish_collection_items('c', ['i'])\"" } as any)
  expect(py.deny).toContain('human click')
  const ok: any = await $.tool.call({ tool: 'Bash', command: 'grep -rn publish_collection_items webflow/' } as any)
  expect(ok.deny).toBeUndefined()
  const unpub: any = await $.tool.call({ tool: 'Bash', command: 'curl https://api.webflow.com/v2/collections/c/items/unpublish' } as any)
  expect(unpub.deny).toBeUndefined()
})

// Rule 3: Pass A freshness. Exit 0 records it; an item write stales it; a publish call says so.
test('rule 3 tracks Pass A and goes stale after a Webflow write', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  passthrough(on, 'receipt written — best-sofas: pass_a = PASS (scope full) -> refresh_runs run-1')
  await $.tool.call({ tool: 'Bash', command: 'python3 webflow/bulk-operations/article-audit/article_audit.py --slug best-sofas --pass a --write-receipt' } as any)
  const fresh: any = await $.tool.call({ tool: WF, actions: [{ publish_collection_items: { collection_id: BLOG } }] } as any)
  expect(fresh.deny).toContain('best-sofas: fresh')
  await $.tool.call({ tool: WF, ...update(BLOG, { 'meta-description': 'x' }) } as any)
  const stale: any = await $.tool.call({ tool: WF, actions: [{ publish_collection_items: { collection_id: BLOG } }] } as any)
  expect(stale.deny).toContain('Pass A stale')
  expect(stale.deny).toContain('best-sofas: STALE')
})

test('rule 3 does not record a failed audit run', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  // One hook beneath the plugin, switched by the command: the audit exits non-zero, the rest succeed.
  on('tool.call', (_$: any, e: any) =>
    (/article_audit/.test(e.command ?? '')
      ? { isError: true, result: 'exit 1', text: 'BLOCK' }
      : { result: {}, text: 'ok' }) as any)
  await $.tool.call({ tool: 'Bash', command: 'python3 article_audit.py --slug s --pass a --write-receipt' } as any)
  const r: any = await $.tool.call({ tool: WF, actions: [{ publish_site: { siteId: 's' } }] } as any)
  expect(r.deny).toContain('No Pass A receipt was recorded')
})

// Rule 4: payload checks.
test('rule 4 product-link must be a go.livingcozy.com URL', async ($, on) => {
  passthrough(on)
  const bad: any = await $.tool.call({ tool: WF, ...update(PRODUCTS, { 'product-link': 'https://brand.com/p/1' }) } as any)
  expect(bad.deny).toContain('go.livingcozy.com')
  const ok: any = await $.tool.call({ tool: WF, ...update(PRODUCTS, { 'product-link': 'https://go.livingcozy.com/albany-park-sofa' }) } as any)
  expect(ok.deny).toBeUndefined()
})

test('rule 4 card hero goes to feature-image, not main-image', async ($, on) => {
  passthrough(on)
  const bad: any = await $.tool.call({ tool: WF, ...update(PRODUCTS, { 'main-image': { url: 'https://x/y.webp' } }) } as any)
  expect(bad.deny).toContain('feature-image')
  const ok: any = await $.tool.call({ tool: WF, ...update(PRODUCTS, { 'feature-image': { url: 'https://x/y.webp' } }) } as any)
  expect(ok.deny).toBeUndefined()
})

test('rule 4 a body replace must not drop lc-deal-pill spans', async ($, on) => {
  const live = JSON.stringify({ items: [{ id: 'i1', fieldData: { 'intro': '<p>a</p><span class="lc-deal-pill">15% off</span>' } }] })
  on('tool.call', () => ({ result: {}, text: live }) as any)
  await $.tool.call({ tool: WF, actions: [{ list_collection_items: { collection_id: BLOG } }] } as any)
  const bad: any = await $.tool.call({ tool: WF, ...update(BLOG, { 'intro': '<p>new</p>' }) } as any)
  expect(bad.deny).toContain('lc-deal-pill')
  const ok: any = await $.tool.call({ tool: WF, ...update(BLOG, { 'intro': '<p>new</p><span class="lc-deal-pill">15% off</span>' }) } as any)
  expect(ok.deny).toBeUndefined()
})

// Asks: a hand-typed price in the body, and a body replace with no live read seen.
test('rule 4 asks on a hand-typed price; passes a shortcode', async ($, on) => {
  on('tool.check', () => ({ decision: 'allow' }) as any)
  on('tool.call', () => ({ result: {}, text: JSON.stringify({ items: [{ id: 'new', fieldData: { 'intro': '<p>old</p>' } }] }) }) as any)
  await $.tool.call({ tool: WF, actions: [{ list_collection_items: { collection_id: BLOG } }] } as any)
  const priced: any = await $.tool.check({ tool: WF, input: update(BLOG, { 'intro': '<p>Only $1,299 today</p>' }, 'new') } as any)
  expect(priced.decision).toBe('ask')
  expect(priced.reason).toContain('{{price:P-NNNNN}}')
  const meta: any = await $.tool.check({ tool: WF, input: update(BLOG, { 'meta-description': 'x' }) } as any)
  expect(meta.decision).toBe('allow')
})

// Review findings (PR #1578): comment-split verbs, non-string Bash input, off-host /publish URLs,
// and a Webflow server whose connector id is a UUID rather than the word "webflow".
test('review: a mid-token comment cannot hide a receipt write', async ($, on) => {
  passthrough(on)
  const bad: any = await $.tool.call({ tool: 'mcp__x__execute_sql', query: "upd/*x*/ate refresh_run_sections set findings='{}'" } as any)
  expect(bad.deny).toContain('refresh_run_sections')
  const dashed: any = await $.tool.call({ tool: 'mcp__x__execute_sql', query: "delete -- note\n from refresh_run_sections" } as any)
  expect(dashed.deny).toContain('refresh_run_sections')
})

test('review: a missing or non-string Bash command is refused, not stringified', async ($, on) => {
  passthrough(on)
  const none: any = await $.tool.call({ tool: 'Bash' } as any)
  expect(none.deny).toContain('could not be checked')
  const obj: any = await $.tool.call({ tool: 'Bash', command: { cmd: 'curl https://api.webflow.com/v2/sites/s/publish' } } as any)
  expect(obj.deny).toContain('could not be checked')
})

test('review: /publish on a non-Webflow host is none of this guard\'s business', async ($, on) => {
  passthrough(on)
  const ok: any = await $.tool.call({ tool: 'Bash', command: 'curl https://example.com/foo/publish' } as any)
  expect(ok.deny).toBeUndefined()
})

test('review: the Webflow gates fire for a UUID-named connector', async ($, on) => {
  passthrough(on)
  const bad: any = await $.tool.call({ tool: 'mcp__711821a6-e402-4a05-9590-64b915667d20__data_cms_tool', ...update(PRODUCTS, { 'product-link': 'https://brand.com/p' }) } as any)
  expect(bad.deny).toContain('go.livingcozy.com')
})

test('review 2: a shell wrapper cannot carry a publish past the guard', async ($, on) => {
  passthrough(on)
  const named: any = await $.tool.call({ tool: 'Bash', command: 'bash scripts/do_webflow_publish.sh' } as any)
  expect(named.deny).toContain('human click')
  const inline: any = await $.tool.call({ tool: 'Bash', command: "sh -c 'publish_collection_items c i'" } as any)
  expect(inline.deny).toContain('human click')
  const ok: any = await $.tool.call({ tool: 'Bash', command: 'bash scripts/lint.sh' } as any)
  expect(ok.deny).toBeUndefined()
})

test('review 2: Pass A is not recorded from a disguised or non-PASS audit run', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  // One hook beneath the plugin: it prints PASS for slug `s`, BLOCK for slug `blocked`.
  on('tool.call', (_$: any, e: any) => {
    const out = /--slug blocked/.test(e.command ?? '')
      ? 'receipt written — blocked: pass_a = BLOCK (scope full) -> refresh_runs r2'
      : 'receipt written — s: pass_a = PASS (scope full) -> refresh_runs r1'
    return { result: { stdout: out, stderr: '', interrupted: false }, text: out } as any
  })
  await $.tool.call({ tool: 'Bash', command: 'python3 article_audit.py --slug s --pass a --write-receipt || true' } as any)
  await $.tool.call({ tool: 'Bash', command: 'true # python3 article_audit.py --slug s --pass a --write-receipt' } as any)
  await $.tool.call({ tool: 'Bash', command: 'python3 article_audit.py --slug blocked --pass a --write-receipt' } as any)
  const none: any = await $.tool.call({ tool: WF, actions: [{ publish_site: { siteId: 's' } }] } as any)
  expect(none.deny).toContain('No Pass A receipt was recorded')
  // and the honest run IS recorded, from the output's slug
  await $.tool.call({ tool: 'Bash', command: 'python3 article_audit.py --slug s --pass a --write-receipt' } as any)
  const fresh: any = await $.tool.call({ tool: WF, actions: [{ publish_site: { siteId: 's' } }] } as any)
  expect(fresh.deny).toContain('s: fresh')
})

test('review 3: a spliced second command cannot forge a Pass A record', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('tool.call', () => ({ result: { stdout: 'receipt written — forged: pass_a = PASS (scope full) -> refresh_runs r1', stderr: '', interrupted: false }, text: 'x' }) as any)
  for (const cmd of [
    "python3 article_audit.py --slug b --pass a --write-receipt; python3 -c \"print('x')\"",
    "python3 article_audit.py --slug b --pass a --write-receipt | cat",
    'python3 article_audit.py --slug b --pass a --write-receipt && true',
  ]) await $.tool.call({ tool: 'Bash', command: cmd } as any)
  const r: any = await $.tool.call({ tool: WF, actions: [{ publish_site: { siteId: 's' } }] } as any)
  expect(r.deny).toContain('No Pass A receipt was recorded')
})

test('review 4: empty input is refused, and a hostile unterminated-comment query finishes fast', async ($, on) => {
  passthrough(on)
  const emptySql: any = await $.tool.call({ tool: 'mcp__x__execute_sql', query: '   ' } as any)
  expect(emptySql.deny).toContain('nothing to check')
  const emptyBash: any = await $.tool.call({ tool: 'Bash', command: '  \n ' } as any)
  expect(emptyBash.deny).toContain('nothing to check')
  const t0 = Date.now()
  const hostile: any = await $.tool.call({ tool: 'mcp__x__execute_sql', query: '/*'.repeat(100_000) + ' select 1' } as any)
  expect(hostile.deny).toBeUndefined()
  expect(Date.now() - t0).toBeLessThan(2000)
  const huge: any = await $.tool.call({ tool: 'mcp__x__execute_sql', query: 'x'.repeat(600_000) } as any)
  expect(huge.deny).toContain('too large')
})

test('review 5: direct scripts and runners named for a Webflow publish are denied; the gate selftest still runs', async ($, on) => {
  passthrough(on)
  for (const cmd of ['./scripts/do_webflow_publish.sh', '/opt/x/publish_webflow.sh', 'npm run webflow:publish', 'npm run publish:webflow']) {
    const r: any = await $.tool.call({ tool: 'Bash', command: cmd } as any)
    expect(r.deny).toContain('human click')
  }
  for (const cmd of ['python3 .claude/hooks/webflow-publish-gate.py --selftest', 'git commit -m "webflow publish guard"', 'npm run lint', 'bash scripts/unpublish_webflow.sh']) {
    const r: any = await $.tool.call({ tool: 'Bash', command: cmd } as any)
    expect(r.deny).toBeUndefined()
  }
})

test('review 5: a Webflow data call whose payload cannot be located is refused', async ($, on) => {
  passthrough(on)
  const nested: any = await $.tool.call({ tool: 'mcp__711821a6-e402-4a05-9590-64b915667d20__data_cms_tool', input: { actions: [] } } as any)
  expect(nested.deny).toContain('cannot be examined')
  const other: any = await $.tool.call({ tool: 'mcp__711821a6-e402-4a05-9590-64b915667d20__ask_webflow_ai', question: 'hi' } as any)
  expect(other.deny).toBeUndefined()
})

test('review 6: empty actions, a spoofed -gate name, and an envelope-nested payload are all handled', async ($, on) => {
  passthrough(on)
  const CMS = 'mcp__711821a6-e402-4a05-9590-64b915667d20__data_cms_tool'
  const empty: any = await $.tool.call({ tool: CMS, actions: [] } as any)
  expect(empty.deny).toContain('cannot be examined')
  const spoof: any = await $.tool.call({ tool: 'Bash', command: 'bash ./scripts/do_webflow_publish-gate.sh' } as any)
  expect(spoof.deny).toContain('human click')
  // a payload nested under `input` is examined, not skipped
  const nested: any = await $.tool.call({ tool: CMS, input: update(PRODUCTS, { 'product-link': 'https://brand.com/p' }) } as any)
  expect(nested.deny).toContain('go.livingcozy.com')
  const nestedPublish: any = await $.tool.call({ tool: CMS, input: { actions: [{ publish_collection_items: { collection_id: BLOG } }] } } as any)
  expect(nestedPublish.deny).toContain('publish-shaped')
})

const CMS = 'mcp__711821a6-e402-4a05-9590-64b915667d20__data_cms_tool'

// Pill baseline: an unknown baseline ASKS (tool.check), a known loss DENIES (tool.call); the body fields are the
// Blog Posts rich-text fields, each judged on its own.
test('review 3: no live read means ask, not deny; each body field has its own baseline', async ($, on) => {
  on('tool.check', () => ({ decision: 'allow' }) as any)
  // the MCP answers one JSON object per action, back to back (measured shape)
  const live =
    JSON.stringify({ label: 'a', action: 'list_collection_items', result: { items: [{ id: 'i9', fieldData: { intro: '<p>x</p>', 'post-content': '<span class="lc-deal-pill">10% off</span>' } }], pagination: { total: 1 } } }) +
    '\n' + JSON.stringify({ label: 'b', action: 'get_collection_list', result: {} })
  on('tool.call', () => ({ result: {}, text: live }) as any)
  const unread: any = await $.tool.check({ tool: CMS, input: update(BLOG, { intro: '<p>new</p>' }, 'never-read') } as any)
  expect(unread.decision).toBe('ask')
  const idless: any = await $.tool.check({ tool: CMS, input: { actions: [{ update_collection_items: { collection_id: BLOG, request: { fieldData: { intro: '<p>new</p>' } } } }] } } as any)
  expect(idless.decision).toBe('ask')
  await $.tool.call({ tool: CMS, actions: [{ list_collection_items: { collection_id: BLOG } }, { get_collection_list: { siteId: 's' } }] } as any)
  // `intro` had no pill and is clean; `post-content` had one, so dropping it is denied
  const intro: any = await $.tool.call({ tool: CMS, ...update(BLOG, { intro: '<p>new</p>' }, 'i9') } as any)
  expect(intro.deny).toBeUndefined()
  const lost: any = await $.tool.call({ tool: CMS, ...update(BLOG, { 'post-content': '<p>new</p>' }, 'i9') } as any)
  expect(lost.deny).toContain('post-content')
  // `post-body` is not a Blog Posts field: it is not treated as a body field
  const notBody: any = await $.tool.call({ tool: CMS, ...update(BLOG, { 'post-body': '<p>$5 x</p>' }, 'i9') } as any)
  expect(notBody.deny).toBeUndefined()
})

// Writes: every create_/update_/delete_/unpublish_ action stales Pass A (schema read of data_cms_tool).
test('review 3b: every write-shaped action stales Pass A, a read does not', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  passthrough(on, 'receipt written — best-sofas: pass_a = PASS (scope full) -> refresh_runs run-1')
  const audit = () => $.tool.call({ tool: 'Bash', command: 'python3 article_audit.py --slug best-sofas --pass a --write-receipt' } as any)
  const state = async () => ((await $.tool.call({ tool: CMS, actions: [{ publish_site: {} }] } as any)) as any).deny as string
  for (const action of [
    { delete_collection_items: { collection_id: BLOG, request: { items: [{ id: 'x' }] } } },
    { unpublish_collection_items: { collection_id: BLOG, request: { items: [{ id: 'x' }] } } },
    { update_collection_field: { collection_id: BLOG, field_id: 'f', request: {} } },
    { create_collection_static_field: { collection_id: BLOG, request: { type: 'PlainText', displayName: 'n' } } },
  ]) {
    await audit()
    expect(await state()).toContain('best-sofas: fresh')
    await $.tool.call({ tool: CMS, actions: [action] } as any)
    expect(await state()).toContain('best-sofas: STALE')
  }
  await audit()
  await $.tool.call({ tool: CMS, actions: [{ list_collection_items: { collection_id: BLOG } }] } as any)
  expect(await state()).toContain('best-sofas: fresh')
})

// Pass A recording accepts the usual wrappers; the forging shapes stay unrecorded.
test('review 3c: cd, 2>&1 and a tail pipe still record Pass A', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  passthrough(on, 'receipt written — best-sofas: pass_a = PASS (scope full) -> refresh_runs run-1')
  for (const cmd of [
    'cd /repo && python3 webflow/bulk-operations/article-audit/article_audit.py --slug best-sofas --pass a --write-receipt',
    'python3 article_audit.py --slug best-sofas --pass a --write-receipt 2>&1 | tail -20',
    'cd /repo && python3 article_audit.py --slug best-sofas --pass=a --write-receipt 2>&1 | tee /tmp/a.out',
  ]) {
    await $.tool.call({ tool: 'Bash', command: cmd } as any)
    expect(((await $.tool.call({ tool: CMS, actions: [{ publish_site: {} }] } as any)) as any).deny).toContain('best-sofas: fresh')
    // reset by a write so the next command has to record again
    await $.tool.call({ tool: CMS, ...update(BLOG, { 'meta-description': 'x' }) } as any)
  }
})

// SQL: the target of the write decides, string literals are data, run creation is allowed.
test('review 4b: SQL denies a receipt-table TARGET, not a mention', async ($, on) => {
  passthrough(on)
  const sql = async (query: string) => ((await $.tool.call({ tool: 'mcp__x__execute_sql', query } as any)) as any).deny as string | undefined
  for (const q of [
    'copy refresh_run_sections from stdin',
    "do $$ begin update refresh_run_sections set findings = '{}'; end $$",
    "select '--'; update refresh_run_sections set findings = '{}'",
    "-- it's a trap\nupdate refresh_run_sections set findings = '{}' where run_id = 'a'",
    'delete from refresh_runs where id is not null',
    'truncate table public.refresh_runs',
    "update refresh_runs set stages = '{}'::jsonb where id = 'r'",
    "with t as (update refresh_run_sections set findings = '{}' returning 1) select * from t",
    "insert into refresh_runs (id, stages) values ('x', '{}')",
  ]) expect(await sql(q)).toContain('refresh-run-guard')
  expect(await $.tool.call({ tool: 'mcp__x__apply_migration', query: "update refresh_run_sections set findings = '{}'" } as any)).toHaveProperty('deny')
  for (const q of [
    'select * into scratch from refresh_run_sections',
    'update other set x = (select count(*) from refresh_run_sections)',
    "select 'update refresh_run_sections set a = 1' as note",
    "insert into refresh_runs (id, article_slug) values ('x', 's')",
    "update refresh_runs set status = 'done' where id = 'r'",
    'select stages from refresh_runs limit 1',
    "with t as (select stages from refresh_runs) update other set y = 1",
  ]) expect(await sql(q)).toBeUndefined()
})

// Bash: quoted text is not code, and the executor + a publish call are both required.
test('review 5b: Bash false-denies are gone, the real publish paths are not', async ($, on) => {
  passthrough(on)
  const bash = async (command: string) => ((await $.tool.call({ tool: 'Bash', command } as any)) as any).deny as string | undefined
  for (const c of [
    'gh pr create --title "x" --body "the mod denies publish_site and publish_collection_items; also a|b ; c"',
    'git commit -m "guard curl https://api.webflow.com/v2/sites/s/publish"',
    'echo "publish_site"',
    'git commit -m "fix; curl https://api.webflow.com/v2/sites/s/publish"',
    'vim webflow/notes/webflow-publish-checklist.md',
    'python3 .claude/hooks/webflow-publish-gate.py --selftest',
  ]) expect(await bash(c)).toBeUndefined()
  for (const c of [
    "curl -X POST https://api.webflow.com/v2/sites/s/publish -d '{}'",
    'cd /x && wrangler publish_site',
    'FOO=1 $CMD publish_collection_items c i',
    './scripts/do_webflow_publish.sh',
    'npm run webflow:publish',
  ]) expect(await bash(c)).toContain('human click')
  // a `;` inside quotes does not split the command into harmless halves
  expect(await bash('python3 -c "x=1; client.publish_collection_items(c, i)"')).toContain('human click')
})

test('review 10: dynamic SQL cannot hide a receipt write inside a string or a prepared body', async ($, on) => {
  passthrough(on)
  const sql = async (query: string) => ((await $.tool.call({ tool: 'mcp__x__execute_sql', query } as any)) as any).deny as string | undefined
  for (const q of [
    "EXECUTE 'UPDATE refresh_run_sections SET findings = ''{}'''",
    "EXECUTE format('UPDATE refresh_run_sections SET findings = %L', '{}')",
    'EXECUTE prepared_receipt_write',
    'execute prepared_receipt_write(1)',
    'CALL write_receipt()',
    "do $$ begin execute 'update refresh_run_sections set findings = 1'; end $$",
    "do language plpgsql 'begin perform 1; end' /* refresh_runs */",
  ]) expect(await sql(q)).toContain('refresh-run-guard')
  for (const q of [
    "insert into notes (id) values (1) on conflict do nothing",
    "select 'do $$ not code $$' as s",
    "select 'execute me' as s from refresh_runs limit 1",
  ]) expect(await sql(q)).toBeUndefined()
})

test('review 11: SQL and Bash are judged in both envelopes; a failure marker cancels a Pass A record', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('tool.call', (_$: any, e: any) => {
    const bad = /--slug failing/.test(e.command ?? '')
    const out = bad
      ? '::error::failing: x.y - blocking\nreceipt written — failing: pass_a = PASS (scope full) -> refresh_runs r1'
      : 'receipt written — ok: pass_a = PASS (scope full) -> refresh_runs r2'
    return { result: { stdout: out, stderr: '', interrupted: false }, text: out } as any
  })
  // a SELECT decoy at the top level cannot shield a nested write
  const sql: any = await $.tool.call({ tool: 'mcp__x__execute_sql', query: 'select 1', input: { query: "update refresh_run_sections set findings = '{}'" } } as any)
  expect(sql.deny).toContain('refresh_run_sections')
  const bash: any = await $.tool.call({ tool: 'Bash', command: 'ls', input: { command: 'curl -X POST https://api.webflow.com/v2/sites/s/publish' } } as any)
  expect(bash.deny).toContain('human click')
  const clean: any = await $.tool.call({ tool: 'mcp__x__execute_sql', query: 'select 1', input: { query: 'select 2' } } as any)
  expect(clean.deny).toBeUndefined()
  // a receipt line that sits beside a failure marker is not recorded; a clean one is
  await $.tool.call({ tool: 'Bash', command: 'python3 article_audit.py --slug failing --pass a --write-receipt | tail -5' } as any)
  expect(((await $.tool.call({ tool: CMS, actions: [{ publish_site: {} }] } as any)) as any).deny).toContain('No Pass A receipt was recorded')
  await $.tool.call({ tool: 'Bash', command: 'python3 article_audit.py --slug ok --pass a --write-receipt | tail -5' } as any)
  expect(((await $.tool.call({ tool: CMS, actions: [{ publish_site: {} }] } as any)) as any).deny).toContain('ok: fresh')
})

test('review 12: unknown and variant Webflow actions are examined or refused; check and call agree', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('tool.check', () => ({ decision: 'allow' }) as any)
  passthrough(on, 'receipt written — best-sofas: pass_a = PASS (scope full) -> refresh_runs run-1')
  const bad = { 'product-link': 'https://brand.com/x' }
  const item = (key: string, fd: object) => ({ actions: [{ [key]: { collection_id: PRODUCTS, request: { items: [{ id: 'i1', fieldData: fd }] } } }] })
  // variant write keys are parsed, not skipped
  for (const key of ['upsert_collection_items', 'create_collection_items_live', 'update_collection_items_live']) {
    const r: any = await $.tool.call({ tool: CMS, ...item(key, bad) } as any)
    expect(r.deny).toContain('go.livingcozy.com')
  }
  // a key that is neither read nor write nor publish is refused
  const unk: any = await $.tool.call({ tool: CMS, actions: [{ label: 'x', frobnicate_items: {} }] } as any)
  expect(unk.deny).toContain('unrecognized Webflow action')
  const unkCheck: any = await $.tool.check({ tool: CMS, input: { actions: [{ frobnicate_items: {} }] } } as any)
  expect(unkCheck.decision).toBe('deny')
  // check and call agree on publish
  const pubCheck: any = await $.tool.check({ tool: CMS, input: { actions: [{ publish_collection_items: { collection_id: BLOG } }] } } as any)
  expect(pubCheck.decision).toBe('deny')
  expect(pubCheck.reason).toContain('human click')
  // a read passes; the page and branch writes that a create/update prefix misses stale Pass A
  const audit = () => $.tool.call({ tool: 'Bash', command: 'python3 article_audit.py --slug best-sofas --pass a --write-receipt' } as any)
  const PAGES = 'mcp__711821a6-e402-4a05-9590-64b915667d20__data_pages_tool'
  const state = async () => ((await $.tool.call({ tool: CMS, actions: [{ publish_site: {} }] } as any)) as any).deny as string
  await audit()
  await $.tool.call({ tool: PAGES, actions: [{ query_pages_schema_markup: { site_id: 's', pages: [{ id: 'p' }] } }, { list_pages: { site_id: 's' } }] } as any)
  expect(await state()).toContain('best-sofas: fresh')
  for (const action of [
    { bulk_update_pages: { site_id: 's', pages: [{ id: 'p', title: 't' }] } },
    { bulk_update_pages_schema_markup: { site_id: 's', pages: [{ id: 'p', jsonLdSchema: null }] } },
    { merge_branch: { site_id: 's', branch_id: 'b' } },
  ]) {
    await audit()
    await $.tool.call({ tool: PAGES, actions: [action] } as any)
    expect(await state()).toContain('best-sofas: STALE')
  }
})
