import { test, expect } from 'claude-code/testing'

import { world, iso, DAY, RUN, ARTICLE } from './fixture'

const JIRA = 'mcp__claude_ai_Atlassian__createJiraIssue'
const DISPATCH = 'mcp__github__actions_run_trigger'
const FIX = 'connect the Supabase MCP so the approved pillar brief can be checked; nothing selects products without it'
const idea = (description: unknown, over: Record<string, unknown> = {}) => ({
  tool: JIRA, cloudId: 'x', projectKey: 'LCC', issueTypeName: 'Task', summary: 'idea',
  description, additional_fields: { labels: ['article-idea'] }, ...over,
}) as any
const dispatch = (workflow_id: string, inputs: Record<string, unknown>) =>
  ({ tool: DISPATCH, method: 'run_workflow', owner: 'o', repo: 'r', ref: 'main', workflow_id, inputs }) as any
const shortlist = (over: Record<string, unknown> = {}) => dispatch('run-heading-research.yml', { run_id: RUN, step: 'shortlist', apply: true, ...over })
const bash = (command: string) => ({ tool: 'Bash', command }) as any
const write = (file_path: string, content = '# x') => ({ tool: 'Write', file_path, content }) as any
const fmFile = (slug: string, extra = '') => `---\ntitle: T\nslug: ${slug}\n${extra}---\nbody`
const b64 = (s: string) => btoa(s)

// ---- rule 1: article ideas name an EXISTING parent -------------------------------------------

test('article-idea without a parent line is denied, and nothing reaches Jira', async ($, on) => {
  const w = world(on)
  const r: any = await $.tool.call(idea('A great idea about cat trees.'))
  expect(r.deny).toMatch(/^\[mod:pillar-brief-guard\] /)
  expect(r.deny).toContain('Parent article: <slug>')
  expect(w.reached.length).toBe(0)
})

test('placeholder parents (none, tbd, n/a) do not count', async ($, on) => {
  const w = world(on)
  for (const p of ['none', 'TBD', 'n/a', 'unknown']) {
    const r: any = await $.tool.call(idea(`Parent article: ${p}`))
    expect(r.deny).toBeDefined()
  }
  expect(w.reached.length).toBe(0)
})

test('a named, existing parent (plain, Markdown-bold, ADF) is allowed and gets the next steps injected', async ($, on) => {
  const w = world(on)
  const adf = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Parent article: best-sofas' }] }] }
  for (const d of ['Why now.\nParent article: best-sofas', '**Parent article:** `best-sofas`', adf]) {
    const r: any = await $.tool.call(idea(d))
    expect(r.deny).toBeUndefined()
    const ctx = String((r.context ?? []).join(' '))
    expect(ctx).toContain('[mod:pillar-brief-guard]')
    expect(ctx).toContain('--parent-slug best-sofas')
    expect(ctx).toContain('LC-1728')
    expect(ctx).toContain("the operator's approval")
  }
  expect(w.reached.length).toBe(3)
  expect(w.queries[0]).toBe("select id from public.articles where slug = 'best-sofas' limit 1")
})

test('a parent slug that is not in public.articles is denied', async ($, on) => {
  const w = world(on, { articles: ['best-sofas'] })
  const r: any = await $.tool.call(idea('Parent article: made-up-article'))
  expect(r.deny).toContain('"made-up-article" does not exist in public.articles')
  expect(w.reached.length).toBe(0)
})

test('an unreadable parent lookup denies with the connect-MCP message', async ($, on) => {
  const w = world(on, { throwSql: true })
  const r: any = await $.tool.call(idea('Parent article: best-sofas'))
  expect(r.deny).toContain(FIX)
  expect(w.asked.length).toBe(0)
  expect(w.reached.length).toBe(0)
})

test('unreadable additional_fields fails closed: the labels and the project may be inside it', async ($, on) => {
  const w = world(on)
  for (const over of [
    { additional_fields: 'not-json' },
    { additional_fields: 'not-json', projectKey: undefined },
    { additional_fields: 42 },
  ]) {
    const r: any = await $.tool.call(idea('no parent here', over))
    expect(r.deny, JSON.stringify(over)).toContain('Parent article')
  }
  // a known non-LCC project is still left alone, whatever its fields look like
  expect(((await $.tool.call(idea('no parent', { projectKey: 'LC', additional_fields: 'not-json' }))) as any).deny).toBeUndefined()
  expect(w.reached.length).toBe(1)
})

test('other projects, or LCC without the label, are untouched', async ($, on) => {
  const w = world(on)
  const a: any = await $.tool.call(idea('no parent', { projectKey: 'LC' }))
  const b: any = await $.tool.call(idea('no parent', { additional_fields: { labels: ['bug'] } }))
  const c: any = await $.tool.call(idea('no parent', { additional_fields: undefined }))
  for (const r of [a, b, c]) { expect(r.deny).toBeUndefined(); expect(r.context).toBeUndefined() }
  expect(w.toasts.length).toBe(0)
  expect(w.queries.length).toBe(0)
})

test('article-idea labels in any shape are recognised; an unreadable shape fails closed', async ($, on) => {
  const w = world(on)
  const shapes: Record<string, unknown>[] = [
    { additional_fields: { labels: 'article-idea' } },
    { additional_fields: { labels: 'bug, Article-Idea' } },
    { additional_fields: { labels: [{ name: 'article-idea' }] } },
    { additional_fields: undefined, labels: ['article-idea'] },
    { additional_fields: { labels: { odd: true } } },
    { additional_fields: JSON.stringify({ labels: ['article-idea'] }) },
    { projectKey: undefined, additional_fields: { project: { key: 'lcc' }, labels: ['article-idea'] } },
  ]
  for (const over of shapes) {
    const r: any = await $.tool.call(idea('no parent here', over))
    expect(r.deny, JSON.stringify(over)).toContain('Parent article')
  }
  expect(w.reached.length).toBe(0)
  const ok: any = await $.tool.call(idea('no parent here', { additional_fields: { labels: 'bug, docs' } }))
  expect(ok.deny).toBeUndefined()
})

// ---- rule 2: shortlist dispatch --------------------------------------------------------------

test('shortlist dispatch with no approved brief is denied and names the step to run', async ($, on) => {
  const w = world(on, { brief: null })
  const r: any = await $.tool.call(shortlist())
  expect(r.deny).toContain('no approved pillar brief for "best-sofas"')
  expect(r.deny).toContain('brief_stage.py draft --article-slug best-sofas')
  expect(r.deny).toContain('--by "the operator"')
  expect(w.reached.length).toBe(0)
})

test('shortlist dispatch with a fresh approved brief goes through; the run id resolves to the article via public.articles-keyed ids', async ($, on) => {
  const w = world(on)
  const r: any = await $.tool.call(dispatch('.github/workflows/run-heading-research.yml', { run_id: RUN, step: 'shortlist', apply: 'true' }))
  expect(r.deny).toBeUndefined()
  expect(w.reached).toEqual(['mcp__github__actions_run_trigger'])
  expect(w.queries[0]).toContain('refresh_runs')
  expect(w.queries[1]).toContain(`article_id = '${ARTICLE}'`)
  expect(w.queries[1]).toContain("status = 'approved'")
})

test('a JSON-wrapped execute_sql reply ({"result":"..."}) is read: a fresh brief goes through', async ($, on) => {
  const w = world(on, { wrapped: true })
  const r: any = await $.tool.call(shortlist())
  expect(r.deny).toBeUndefined()
  expect(w.reached).toEqual(['mcp__github__actions_run_trigger'])
})

test('a JSON-wrapped reply with no approved brief still denies with the draft step', async ($, on) => {
  const w = world(on, { wrapped: true, brief: null })
  const r: any = await $.tool.call(shortlist())
  expect(r.deny).toContain('no approved pillar brief for "best-sofas"')
  expect(w.reached.length).toBe(0)
})

const UNREADABLE: [string, string][] = [
  ['wrapped, no row array', '{"result":"no rows here"}'],
  ['wrapped, broken rows', '{"result":"<untrusted-data-x>{not json]</untrusted-data-x>"}'],
  ['plain garbage', 'boom ['],
  ['JSON without result', '{"other":1}'],
]
for (const [name, garbage] of UNREADABLE) {
  test(`an unreadable reply (${name}) fails closed with the lookup message`, async ($, on) => {
    const w = world(on, { garbage })
    const r: any = await $.tool.call(shortlist())
    expect(r.deny).toContain('could not run')
    expect(w.reached.length).toBe(0)
  })
}

test('apply false or missing is a selftest: shortlist dispatch is not gated, no lookup', async ($, on) => {
  const w = world(on, { brief: null })
  for (const apply of [false, 'false', 'False', undefined, '']) {
    const r: any = await $.tool.call(shortlist({ apply }))
    expect(r.deny, String(apply)).toBeUndefined()
  }
  expect(w.queries.length).toBe(0)
  expect(w.reached.length).toBe(5)
  // Truthy spellings (1/yes/on) are judged as a selection.
  for (const apply of ['1', 'yes', 'ON', 'y']) {
    const r: any = await $.tool.call(shortlist({ apply }))
    expect(r.deny, String(apply)).toContain('no approved pillar brief')
  }
  // Out of the enum: never guessed. (The workflow input is a boolean, so Actions would reject these anyway.)
  for (const apply of ['maybe', 2, 'enable']) {
    const r: any = await $.tool.call(shortlist({ apply }))
    expect(r.deny, String(apply)).toContain('apply must be true or false')
  }
  expect(w.queries.length).toBe(4 * 2)
  expect(((await $.tool.call(shortlist({ apply: '0' }))) as any).deny).toBeUndefined()
})

test('other heading-research steps and other workflows never look anything up', async ($, on) => {
  const w = world(on, { brief: null })
  await $.tool.call(dispatch('run-heading-research.yml', { run_id: RUN, step: 'demand-sweep', apply: true }))
  await $.tool.call(dispatch('roster-materialize.yml', { step: 'shortlist', apply: true }))
  await $.tool.call({ ...shortlist(), method: 'rerun_workflow_run' })
  expect(w.queries.length).toBe(0)
  expect(w.reached.length).toBe(3)
})

test('a numeric workflow id is a match when its inputs carry step=shortlist or mode=approve', async ($, on) => {
  const w = world(on, { brief: null })
  expect(((await $.tool.call(dispatch('987654', { run_id: RUN, step: 'shortlist', apply: true }))) as any).deny).toContain('no approved pillar brief')
  expect(((await $.tool.call(dispatch('987654', { mode: 'approve', approved_by: '' }))) as any).deny).toContain('named human approver')
  expect(((await $.tool.call(dispatch('987654', { step: 'demand-sweep' }))) as any).deny).toBeUndefined()
  expect(w.reached.length).toBe(1)
})

test('a brief approved under the legacy spelling (before LC-1889) still passes the approver check', async ($, on) => {
  const w = world(on, { brief: { version: 2, approved_at: iso(30 * DAY), approved_by: 'stan (chat)' } })
  expect((await $.tool.call(shortlist()) as any).deny).toBeUndefined()
  expect(w.asked.length).toBe(0)
})

test('age: exactly 365 days passes without a question', async ($, on) => {
  const w = world(on, { brief: { version: 2, approved_at: iso(365 * DAY), approved_by: 'The operator' } })
  expect((await $.tool.call(shortlist()) as any).deny).toBeUndefined()
  expect(w.asked.length).toBe(0)
})

test('an expired brief asks; refusing denies', async ($, on) => {
  const w = world(on, { brief: { version: 2, approved_at: iso(366 * DAY), approved_by: 'The operator' }, answer: 'Refuse' })
  const r: any = await $.tool.call(shortlist())
  expect(w.asked.length).toBe(1)
  expect(w.asked[0]).toContain('366 days old')
  expect(r.deny).toContain('(refused)')
  expect(w.reached.length).toBe(0)
})

test('an expired brief asks; allowing lets the call through', async ($, on) => {
  const w = world(on, { brief: { approved_at: iso(500 * DAY), approved_by: 'The operator' }, answer: 'Allow this call' })
  const r: any = await $.tool.call(shortlist())
  expect(r.deny).toBeUndefined()
  expect(w.reached).toEqual(['mcp__github__actions_run_trigger'])
})

test('fail closed: a lookup that cannot run DENIES with the fix (never asks): error result, thrown, unknown run, bad approved_at, no approver', async ($, on) => {
  const w = world(on, { answer: 'Allow this call' })
  const cases: [Record<string, unknown>, string][] = [
    [{ sqlError: true }, FIX],
    [{ throwSql: true }, FIX],
    [{ runs: {} }, 'cannot find refresh run'],
    [{ brief: { approved_at: 'garbage', approved_by: 'The operator' } }, 'no readable approved_at'],
    [{ brief: { approved_at: iso(DAY), approved_by: '  ' } }, 'names no configured approver'],
    [{ brief: { approved_at: iso(DAY), approved_by: 'claude' } }, 'names no configured approver'],
  ]
  for (const [w0, msg] of cases) {
    Object.assign(w.w, { sqlError: false, throwSql: false, runs: undefined, brief: undefined }, w0)
    const r: any = await $.tool.call(shortlist())
    expect(r.deny, msg).toContain(msg)
  }
  expect(w.asked.length).toBe(0) // an unattended session cannot answer; a stall is worse than a refusal
  expect(w.reached.length).toBe(0)
})

test('the lookup-failure message must not promise a server-side fallback', async ($, on) => {
  world(on, { throwSql: true })
  const r: any = await $.tool.call(shortlist())
  expect(r.deny).not.toContain('server-side')
  expect(r.deny).not.toContain('enforces')
})

test('no Supabase MCP connected at all (the cloud-session case) is a deny naming the fix', async ($, on) => {
  const w = world(on, { throwSql: true })
  const r: any = await $.tool.call(bash(`python3 product_shortlist.py --run-id ${RUN}`))
  expect(r.deny).toMatch(/^\[mod:pillar-brief-guard\] /)
  expect(r.deny).toContain('could not run')
  expect(r.deny).toContain(FIX)
  expect(w.asked.length).toBe(0)
})

test('a non-UUID run id is never put into SQL: it is denied', async ($, on) => {
  const w = world(on, { answer: 'Refuse' })
  const r: any = await $.tool.call(shortlist({ run_id: "x' or '1'='1" }))
  expect(w.queries.length).toBe(0)
  expect(r.deny).toContain('not a UUID')
})

// ---- rule 3: approvals name a configured human approver ----------------------------------------

test('run-pillar-brief.yml mode=approve needs a configured approver (the operator), case-insensitively', async ($, on) => {
  const w = world(on)
  for (const inputs of [{ mode: 'approve' }, { mode: 'approve', approved_by: '' }, { mode: 'Approve', approved_by: '   ' }, { mode: 'approve', approved_by: 'claude' }, { mode: 'approve', approved_by: 'x' }, { mode: 'approve', approved_by: 'claude (chat)' }, { mode: 'approve', approved_by: '(chat)' }]) {
    const r: any = await $.tool.call(dispatch('run-pillar-brief.yml', inputs))
    expect(r.deny, JSON.stringify(inputs)).toContain('named human approver (the operator)')
  }
  expect(w.reached.length).toBe(0)
  for (const inputs of [{ mode: 'approve', approved_by: 'The operator' }, { mode: 'approve', approved_by: ' THE operator ' }, { mode: 'approve', approved_by: 'operator (chat)' }, { mode: 'approve', approved_by: 'stan (chat)' }, { mode: 'approve', approved_by: 'STAN' }, { mode: 'approve', approved_by: 'The operator (portal)' }, { mode: 'draft' }]) {
    expect(((await $.tool.call(dispatch('run-pillar-brief.yml', inputs))) as any).deny, JSON.stringify(inputs)).toBeUndefined()
  }
})

test('pillar_brief.py approve without a configured --by is denied in every spelling', async ($, on) => {
  const w = world(on)
  for (const c of [
    'python3 webflow/bulk-operations/pillar-brief/pillar_brief.py approve --brief-id abc',
    'python3 pillar_brief.py approve --brief-id abc --by ""',
    'python3 pillar_brief.py approve --brief-id abc --by=',
    "python3 pillar_brief.py approve --by '  ' --brief-id abc",
    'python3 pillar_brief.py approve --brief-id abc --by',
    'python3 pillar_brief.py approve --by --brief-id abc',
    'python3 pillar_brief.py approve --brief-id abc --by claude',
    'python3 pillar_brief.py approve --brief-id abc --by=x',
    "cd x && bash -c 'python3 pillar_brief.py approve --brief-id abc --by Claude'",
    'echo hi; python3 ./pillar_brief.py approve --brief-id abc | tee out',
    'python3 -m webflow.pillar_brief approve --brief-id abc',
  ]) {
    const r: any = await $.tool.call(bash(c))
    expect(r.deny, c).toContain('named human approver')
  }
  expect(w.reached.length).toBe(0)
})

test('approve by the operator, other subcommands, and mentions of approve are allowed', async ($, on) => {
  const w = world(on)
  for (const c of [
    'python3 pillar_brief.py approve --brief-id abc --by "The operator"',
    'python3 pillar_brief.py approve --brief-id abc --by="THE OPERATOR"',
    'python3 pillar_brief.py show --article-slug best-sofas',
    'grep -n approve webflow/bulk-operations/pillar-brief/pillar_brief.py',
    'git commit -m "pillar_brief.py approve needs --by"',
  ]) {
    expect(((await $.tool.call(bash(c))) as any).deny, c).toBeUndefined()
  }
  expect(w.reached.length).toBe(5)
})

// ---- rule 2: Bash selection writers ---------------------------------------------------------

test('product_shortlist.py: gated by --run-id, --article or --article-id; denied with no brief', async ($, on) => {
  const w = world(on, { brief: null })
  for (const c of [
    `python3 product_shortlist.py --run-id ${RUN} --output r.json`,
    'python3 product_shortlist.py --article best-sofas',
    `python3 product_shortlist.py --article-id=${ARTICLE}`,
  ]) {
    expect((await $.tool.call(bash(c)) as any).deny, c).toContain('no approved pillar brief')
  }
  expect(w.reached.length).toBe(0)
})

test('product_shortlist.py with a fresh brief runs; --selftest/--dry-run/--render and a no-target call are not selections', async ($, on) => {
  const w = world(on, { answer: 'Refuse' })
  expect(((await $.tool.call(bash(`python3 product_shortlist.py --run-id ${RUN}`))) as any).deny).toBeUndefined()
  const before = w.queries.length
  for (const c of ['python3 product_shortlist.py --selftest', `python3 product_shortlist.py --run-id ${RUN} --dry-run`, 'python3 product_shortlist.py --render f.json --html o.html', 'python3 product_shortlist.py', 'python3 product_shortlist.py --output r.json']) {
    expect(((await $.tool.call(bash(c))) as any).deny, c).toBeUndefined()
  }
  expect(w.queries.length).toBe(before)
})

test('a target flag with a bad value is still a selection and is denied', async ($, on) => {
  const w = world(on)
  const r: any = await $.tool.call(bash('python3 product_shortlist.py --run-id not-a-uuid'))
  expect(r.deny).toContain('not a UUID')
  expect(w.queries.length).toBe(0)
})

test('roster_materialize.py apply reads the article from the plan file; plan (read-only) is not gated', async ($, on) => {
  const w = world(on, { brief: null, files: { 'plan.json': JSON.stringify({ article_id: ARTICLE }) } })
  const r: any = await $.tool.call(bash('python3 roster_materialize.py apply --plan plan.json'))
  expect(r.deny).toContain('no approved pillar brief')
  expect(w.queries[0]).toContain(`article_id = '${ARTICLE}'`)
  const plan: any = await $.tool.call(bash('python3 roster_materialize.py plan --article best-sofas --output plan.json'))
  expect(plan.deny).toBeUndefined()
})

test('roster apply with an unreadable or article-less plan is denied (fail closed, no question)', async ($, on) => {
  const w = world(on, { files: { 'bare.json': '{"slots":[]}' } })
  for (const c of ['python3 roster_materialize.py apply --plan missing.json', 'python3 roster_materialize.py apply --plan bare.json', 'python3 roster_materialize.py apply']) {
    expect(((await $.tool.call(bash(c))) as any).deny, c).toContain('cannot tell which article')
  }
  expect(w.asked.length).toBe(0)
})

test('only RECOGNISED actions trigger: heredocs, greps, commit messages and tests that merely mention the names pass untouched', async ($, on) => {
  const w = world(on, { throwSql: true, brief: null })
  const cmds = [
    "cat <<'EOF' > notes.md\nselect * from pillar_briefs join refresh_runs using (article_id);\npython3 product_shortlist.py --run-id " + RUN + "\npython3 pillar_brief.py approve --brief-id x\ngh workflow run run-pillar-brief.yml -f mode=approve\nEOF",
    "cat > t.sh <<EOF\npython3 roster_materialize.py apply --plan p.json\nEOF\necho done",
    'grep -rn product_shortlist.py webflow/',
    'cat webflow/bulk-operations/pillar-brief/pillar_brief.py',
    'git commit -m "guard product_shortlist.py and roster_materialize.py apply"',
    `echo "python3 product_shortlist.py --run-id ${RUN}"`,
    'python3 -m pytest webflow/bulk-operations/heading-research/tests -k product_shortlist',
    "psql -c 'select * from refresh_runs'",
    'echo gh workflow run run-pillar-brief.yml -f mode=approve',
  ]
  for (const c of cmds) expect(((await $.tool.call(bash(c))) as any).deny, c).toBeUndefined()
  expect(w.queries.length).toBe(0)
  expect(w.reached.length).toBe(cmds.length)
})

test('a command AFTER a heredoc is still judged', async ($, on) => {
  const w = world(on, { brief: null })
  const r: any = await $.tool.call(bash(`cat <<EOF > a.txt\nhi\nEOF\npython3 product_shortlist.py --run-id ${RUN}`))
  expect(r.deny).toContain('no approved pillar brief')
  expect(w.reached.length).toBe(0)
})

test('recognition: interpreter flags, env assignments, launchers, python -m, and shell keywords/grouping', async ($, on) => {
  const w = world(on, { brief: null })
  for (const c of [
    `FOO=1 python3 -u webflow/bulk-operations/heading-research/product_shortlist.py --run-id ${RUN}`,
    `./product_shortlist.py --run-id ${RUN}`,
    `cd x && timeout 60 python3 product_shortlist.py --run-id ${RUN}`,
    `python3 -m webflow.bulk_operations.heading_research.product_shortlist --run-id ${RUN}`,
    `if true; then python3 product_shortlist.py --run-id ${RUN}; fi`,
    `for i in 1; do python3 product_shortlist.py --run-id ${RUN}; done`,
    `true || (python3 product_shortlist.py --run-id ${RUN})`,
    `{ python3 product_shortlist.py --run-id ${RUN}; }`,
    `true; else python3 product_shortlist.py --run-id ${RUN}`,
    `nohup python3 product_shortlist.py --run-id ${RUN} &`,
    `exec python3 product_shortlist.py --run-id ${RUN}`,
    `command python3 product_shortlist.py --run-id ${RUN}`,
    `while read x; do python3 product_shortlist.py --run-id ${RUN}; done`,
  ]) expect(((await $.tool.call(bash(c))) as any).deny, c).toContain('no approved pillar brief')
  expect(w.reached.length).toBe(0)
})

// ---- gh CLI dispatch --------------------------------------------------------------------------

test('gh workflow run: shortlist honours apply; approve needs the approver', async ($, on) => {
  const w = world(on, { brief: null })
  const base = 'gh workflow run run-heading-research.yml'
  const denied = await $.tool.call(bash(`${base} -f run_id=${RUN} -f step=shortlist -f apply=true`)) as any
  expect(denied.deny).toContain('no approved pillar brief')
  for (const c of [
    `${base} -f run_id=${RUN} -f step=shortlist`,
    `${base} -f run_id=${RUN} -f step=shortlist -f apply=false`,
    `${base} -f step=demand-sweep -f apply=true`,
  ]) expect(((await $.tool.call(bash(c))) as any).deny, c).toBeUndefined()
  for (const c of [
    `gh workflow run run-pillar-brief.yml -f mode=approve`,
    `gh workflow run run-pillar-brief.yml -f mode=approve -f approved_by=claude`,
    `gh workflow run run-pillar-brief.yml --ref main -R o/r -f mode=approve -f approved_by=`,
    `gh workflow run 12345 --field mode=approve`,
  ]) expect(((await $.tool.call(bash(c))) as any).deny, c).toContain('named human approver')
  for (const c of [
    `gh workflow run run-pillar-brief.yml -f mode=approve -f approved_by="the operator"`,
    `gh workflow run run-pillar-brief.yml -fmode=approve -fapproved_by="the operator"`,
    `gh workflow run run-pillar-brief.yml --field=mode=approve --field=approved_by="The Operator"`,
    `gh workflow run run-pillar-brief.yml -f mode=draft`,
  ]) expect(((await $.tool.call(bash(c))) as any).deny, c).toBeUndefined()
  void w
})

test('gh workflow run --json hides the inputs: denied for the guarded workflows, not for others', async ($, on) => {
  world(on)
  expect(((await $.tool.call(bash('gh workflow run run-pillar-brief.yml --json < in.json'))) as any).deny).toContain('-f key=value')
  expect(((await $.tool.call(bash('gh workflow run run-heading-research.yml --json < in.json'))) as any).deny).toContain('-f key=value')
  expect(((await $.tool.call(bash('gh workflow run deploy.yml --json < in.json'))) as any).deny).toBeUndefined()
})

// ---- rule 2: writing a new article file -----------------------------------------------------

test('a NEW article markdown (slug + title frontmatter) in a bbm-content checkout needs an approved brief', async ($, on) => {
  const w = world(on, { brief: null })
  const r: any = await $.tool.call(write('/home/user/bbm-content/articles/cat-trees.md', fmFile('cat-trees')))
  expect(r.deny).toContain('no approved pillar brief for "cat-trees"')
  expect(w.reached.length).toBe(0)
})

test('slug lookups resolve through public.articles, never pillar_briefs.article_slug', async ($, on) => {
  const w = world(on)
  await $.tool.call(write('/h/bbm-content/articles/new.md', fmFile('new')))
  expect(w.queries[0]).toContain("article_id = (select id from public.articles where slug = 'new')")
  expect(w.queries[0]).not.toContain('pillar_briefs.article_slug')
  expect(w.queries[0]).not.toMatch(/where article_slug/)
})

test('only files with slug: AND title: frontmatter are articles; the frontmatter slug names the article', async ($, on) => {
  const w = world(on, { brief: null })
  // not articles: pass untouched
  for (const content of ['# just notes', '---\ntitle: T\n---\nslug: best-sofas\n# body', '---\nslug: only-slug\n---\nbody', '---\ntitle: Only title\n---\nbody']) {
    expect(((await $.tool.call(write('/h/bbm-content/articles/notes.md', content))) as any).deny, content).toBeUndefined()
  }
  expect(w.queries.length).toBe(0)
  // articles: the FIRST fenced block names the slug, a later slug: line does not
  const c: any = await $.tool.call(write('/h/bbm-content/articles/x.md', '---\ntitle: T\nslug: real-one\n---\nslug: best-sofas'))
  expect(c.deny).toContain('"real-one"')
})

test('with an approved brief the new article file is written', async ($, on) => {
  const w = world(on)
  const r: any = await $.tool.call(write('/h/bbm-content/articles/new.md', fmFile('new')))
  expect(r.deny).toBeUndefined()
  expect(w.reached).toEqual(['Write'])
})

test('existing article, non-article paths, README: never gated', async ($, on) => {
  const w = world(on, { brief: null, files: { '/h/bbm-content/articles/old.md': 'x' } })
  for (const p of ['/h/bbm-content/articles/old.md', '/h/bbm-content/README.md', '/h/notes/cat-trees.md', '/h/bbm-content/docs/guide.md', '/h/bbm-content/drafts/x.md', '/h/bbm-content/articles/a.txt', '/h/bbm-content/.github/articles/x.md', '/h/bbm-content/docs/articles/x.md', '/h/bbm-content/node_modules/articles/x.md']) {
    expect(((await $.tool.call(write(p, fmFile('whatever')))) as any).deny, p).toBeUndefined()
  }
  expect(w.queries.length).toBe(0)
  expect(w.reached.length).toBe(9)
})

// ---- rule 2: the GitHub MCP route -----------------------------------------------------------

const GH = 'mcp__github__create_or_update_file'
const GHC = 'mcp__GitHub_Custom__create_or_update_file'
const PUSH = 'mcp__github__push_files'

test('create_or_update_file creating a new bbm-content article is gated (both server names); an update (sha) is not', async ($, on) => {
  const w = world(on, { brief: null })
  const content = b64(fmFile('cat-trees'))
  for (const tool of [GH, GHC]) {
    const r: any = await $.tool.call({ tool, owner: 'o', repo: 'bbm-content', path: 'articles/cat-trees.md', content, message: 'm', branch: 'b' } as any)
    expect(r.deny, tool).toContain('no approved pillar brief for "cat-trees"')
  }
  const viaPath: any = await $.tool.call({ tool: GH, owner: 'o', repo: 'other', path: 'bbm-content/articles/cat-trees.md', content, message: 'm', branch: 'b' } as any)
  expect(viaPath.deny).toContain('no approved pillar brief')
  expect(w.reached.length).toBe(0)
  const update: any = await $.tool.call({ tool: GH, owner: 'o', repo: 'bbm-content', path: 'articles/cat-trees.md', content, sha: 'abc123', message: 'm', branch: 'b' } as any)
  expect(update.deny).toBeUndefined()
})

test('create_or_update_file: with an approved brief it goes through; non-articles and other repos are untouched', async ($, on) => {
  const w = world(on)
  const ok: any = await $.tool.call({ tool: GH, owner: 'o', repo: 'bbm-content', path: 'articles/best-sofas.md', content: b64(fmFile('best-sofas')), message: 'm', branch: 'b' } as any)
  expect(ok.deny).toBeUndefined()
  const before = w.queries.length
  for (const over of [
    { path: 'articles/notes.md', content: b64('# no frontmatter') },
    { path: 'README.md', content: b64(fmFile('x')) },
    { path: 'articles/x.txt', content: b64(fmFile('x')) },
    { repo: 'bbm-infrastructure', path: 'articles/x.md', content: b64(fmFile('x')) },
  ]) {
    const r: any = await $.tool.call({ tool: GH, owner: 'o', repo: 'bbm-content', message: 'm', branch: 'b', ...over } as any)
    expect(r.deny, JSON.stringify(over)).toBeUndefined()
  }
  expect(w.queries.length).toBe(before)
})

test('push_files: every article file in the batch needs an approved brief; the first without one denies', async ($, on) => {
  const w = world(on, { brief: null })
  const r: any = await $.tool.call({ tool: PUSH, owner: 'o', repo: 'bbm-content', branch: 'b', message: 'm', files: [
    { path: 'README.md', content: '# hi' },
    { path: 'articles/a.md', content: fmFile('alpha') },
    { path: 'articles/b.md', content: fmFile('beta') },
  ] } as any)
  expect(r.deny).toContain('"alpha"')
  expect(w.reached.length).toBe(0)
  const none: any = await $.tool.call({ tool: PUSH, owner: 'o', repo: 'bbm-content', branch: 'b', message: 'm', files: [{ path: 'README.md', content: '# hi' }, { path: 'articles/n.md', content: '# no fm' }] } as any)
  expect(none.deny).toBeUndefined()
})

test('push_files with approved briefs goes through', async ($, on) => {
  const w = world(on)
  const r: any = await $.tool.call({ tool: PUSH, owner: 'o', repo: 'bbm-content', branch: 'b', message: 'm', files: [{ path: 'articles/a.md', content: fmFile('alpha') }] } as any)
  expect(r.deny).toBeUndefined()
  expect(w.reached).toEqual([PUSH])
})

// ---- re-review D1-D7 -------------------------------------------------------------------------

test('D1: argparse abbreviations of the target flags are still targets (--run, --ru, --art, --article-i, --run=)', async ($, on) => {
  const w = world(on, { brief: null })
  for (const c of [
    `python3 product_shortlist.py --run ${RUN}`,
    `python3 product_shortlist.py --ru ${RUN}`,
    `python3 product_shortlist.py --run=${RUN}`,
    `python3 product_shortlist.py --run-i ${RUN}`,
    `python3 product_shortlist.py --article-i=${ARTICLE}`,
  ]) expect(((await $.tool.call(bash(c))) as any).deny, c).toContain('no approved pillar brief')
  expect(w.reached.length).toBe(0)
  // an ambiguous prefix (argparse would error) is still treated as a target and refused, never passed
  expect(((await $.tool.call(bash('python3 product_shortlist.py --arti best-sofas'))) as any).deny).toBeDefined()
  // exact sibling flags are not confused with each other's prefix
  expect(((await $.tool.call(bash('python3 product_shortlist.py --article best-sofas'))) as any).deny).not.toContain('not a UUID')
})

test('D2: bash -lc / -ec / -xc payloads are re-tokenised', async ($, on) => {
  const w = world(on, { brief: null })
  for (const sh of ['bash -lc', 'bash -ec', 'sh -xc', 'bash -c']) {
    const r: any = await $.tool.call(bash(`${sh} "python3 product_shortlist.py --run-id ${RUN}"`))
    expect(r.deny, sh).toContain('no approved pillar brief')
  }
  expect(w.reached.length).toBe(0)
  const ok: any = await $.tool.call(bash('git commit -lc "python3 product_shortlist.py --run-id ' + RUN + '"'))
  expect(ok.deny).toBeDefined() // `git commit -lc "..."` is still shell-shaped to us: fail-safe, documented
})

test('D3: additional_fields that is present but does not parse to an object is unreadable', async ($, on) => {
  const w = world(on)
  for (const af of ['"just a string"', '[1,2]', '12', 'null-ish', true, ['article-idea']]) {
    const r: any = await $.tool.call(idea('no parent here', { additional_fields: af }))
    expect(r.deny, JSON.stringify(af)).toContain('Parent article')
  }
  expect(w.reached.length).toBe(0)
})

test('D4: a comment apostrophe, a here-string and arithmetic << never hide the next-line command', async ($, on) => {
  const w = world(on, { brief: null })
  const next = `\npython3 webflow/bulk-operations/heading-research/product_shortlist.py --run-id ${RUN}`
  for (const head of [
    "echo hi # it's a comment",
    'cat <<< "x"',
    'echo $((1<<3))',
    '((x = 1<<3))',
    'echo a # "unbalanced',
    'cat <<EOF_NEVER_CLOSED',
  ]) {
    const r: any = await $.tool.call(bash(head + next))
    expect(r.deny, head).toContain('no approved pillar brief')
  }
  // ...and with a line that LOOKS like the terminator later on (so a mis-read heredoc would swallow the command)
  for (const c of [
    `cat <<< EOF\npython3 product_shortlist.py --run-id ${RUN}\nEOF`,
    `echo $((1<<3))\npython3 product_shortlist.py --run-id ${RUN}\n3`,
    `((x = 1<<EOF))\npython3 product_shortlist.py --run-id ${RUN}\nEOF`,
  ]) expect(((await $.tool.call(bash(c))) as any).deny, c).toContain('no approved pillar brief')
  expect(w.reached.length).toBe(0)
  // a real heredoc is still text, and `a#b` is not a comment
  const real: any = await $.tool.call(bash(`cat <<'EOF'\npython3 product_shortlist.py --run-id ${RUN}\nEOF\necho a#b`))
  expect(real.deny).toBeUndefined()
})

test('D5: gh global flags before the subcommand are seen through; 1/yes/on count as apply=true', async ($, on) => {
  world(on, { brief: null })
  for (const c of [
    `gh -R o/r workflow run run-heading-research.yml -f run_id=${RUN} -f step=shortlist -f apply=true`,
    `gh --repo o/r workflow run run-heading-research.yml -f run_id=${RUN} -f step=shortlist -f apply=yes`,
    `gh -R o/r workflow run run-heading-research.yml -f run_id=${RUN} -f step=shortlist -f apply=1`,
  ]) expect(((await $.tool.call(bash(c))) as any).deny, c).toContain('no approved pillar brief')
  expect(((await $.tool.call(bash('gh -R o/r workflow run run-pillar-brief.yml -f mode=approve'))) as any).deny).toContain('named human approver')
})

test('D6: only tokens in flag position count as skip flags (a value named --selftest is not one)', async ($, on) => {
  const w = world(on, { brief: null })
  for (const c of [
    `python3 product_shortlist.py --run-id ${RUN} --output --selftest`,
    `python3 product_shortlist.py --run-id ${RUN} --html --dry-run`,
    `python3 product_shortlist.py --run-id ${RUN} --out --selftest`,
    `python3 product_shortlist.py --run-id ${RUN} --htm --dry-run`,
    `python3 product_shortlist.py --run-id ${RUN} --ren --selftest`,
  ]) expect(((await $.tool.call(bash(c))) as any).deny, c).toContain('no approved pillar brief')
  expect(((await $.tool.call(bash(`python3 product_shortlist.py --run-id ${RUN} --dry-run`))) as any).deny).toBeUndefined()
  // `--run` (abbreviated value flag) swallows `--selftest` as its value: still a refused selection
  expect(((await $.tool.call(bash(`python3 product_shortlist.py --run --selftest ${RUN}`))) as any).deny).toContain('not a UUID')
  // an inline value (`--out=x`) does not swallow the next word, so a real skip flag after it still skips
  expect(((await $.tool.call(bash(`python3 product_shortlist.py --run-id ${RUN} --out=r.json --selftest`))) as any).deny).toBeUndefined()
  void w
})

test('D7: a BOM before the frontmatter and push_files `files` as a JSON string are still judged', async ($, on) => {
  const w = world(on, { brief: null })
  const bom: any = await $.tool.call(write('/h/bbm-content/articles/x.md', '﻿' + fmFile('with-bom')))
  expect(bom.deny).toContain('"with-bom"')
  const js: any = await $.tool.call({ tool: PUSH, owner: 'o', repo: 'bbm-content', branch: 'b', message: 'm', files: JSON.stringify([{ path: 'articles/a.md', content: fmFile('alpha') }]) } as any)
  expect(js.deny).toContain('"alpha"')
  expect(w.reached.length).toBe(0)
})

test('unreadable dispatch inputs fail closed for guarded workflows and numeric ids; others and missing inputs are untouched', async ($, on) => {
  const w = world(on)
  for (const wf of ['run-heading-research.yml', '.github/workflows/run-pillar-brief.yml', '987654']) {
    for (const inputs of ['not-json', 42, ['step', 'shortlist'], '[1]', true]) {
      const r: any = await $.tool.call(dispatch(wf, inputs as any))
      expect(r.deny, `${wf} ${JSON.stringify(inputs)}`).toContain('cannot be read')
    }
  }
  expect(w.reached.length).toBe(0)
  // a JSON-string object is readable and judged normally
  const ok: any = await $.tool.call(dispatch('run-heading-research.yml', JSON.stringify({ run_id: RUN, step: 'demand-sweep' }) as any))
  expect(ok.deny).toBeUndefined()
  // other workflows and absent inputs are not this guard's business
  expect(((await $.tool.call(dispatch('deploy.yml', 'not-json' as any))) as any).deny).toBeUndefined()
  expect(((await $.tool.call({ ...dispatch('run-heading-research.yml', {}), inputs: undefined })) as any).deny).toBeUndefined()
})

test('nested shells (bash -c inside bash -c inside eval) are seen through, to a bounded depth', async ($, on) => {
  const w = world(on, { brief: null })
  const inner = `python3 product_shortlist.py --run-id ${RUN}`
  const wrap = (cmd: string, how: 'bash' | 'eval'): string => how === 'bash' ? `bash -c "${cmd.replace(/(["\\$`])/g, '\\$1')}"` : `eval "${cmd.replace(/(["\\$`])/g, '\\$1')}"`
  let c = inner
  for (const how of ['bash', 'bash', 'bash'] as const) c = wrap(c, how)
  expect(((await $.tool.call(bash(c))) as any).deny, c).toContain('no approved pillar brief')
  let e = inner
  for (const how of ['eval', 'bash', 'eval', 'bash'] as const) e = wrap(e, how)
  expect(((await $.tool.call(bash(e))) as any).deny, e).toContain('no approved pillar brief')
  expect(w.reached.length).toBe(0)
  // a long but harmless nest still passes, and the work stays bounded
  let harmless = 'echo hello'
  for (let i = 0; i < 12; i++) harmless = wrap(harmless, 'bash')
  expect(((await $.tool.call(bash(harmless))) as any).deny).toBeUndefined()
})

test('real run-pillar-brief.yml inputs (mode, approved_by, dry_run): the workflow defaults approved_by to the operator, so omitting it is still denied', async ($, on) => {
  const w = world(on)
  // approve with the live-apply input shape and no approved_by would be attributed to the operator by the workflow default
  const omitted: any = await $.tool.call(dispatch('run-pillar-brief.yml', { mode: 'approve', brief_id: 'b1', dry_run: false }))
  expect(omitted.deny).toContain('named human approver')
  const named: any = await $.tool.call(dispatch('run-pillar-brief.yml', { mode: 'approve', brief_id: 'b1', dry_run: false, approved_by: 'The operator' }))
  expect(named.deny).toBeUndefined()
  const gh: any = await $.tool.call(bash('gh workflow run run-pillar-brief.yml -f mode=approve -f brief_id=b1 -f dry_run=false'))
  expect(gh.deny).toContain('named human approver')
  // draft / criteria carry no approval
  for (const mode of ['draft', 'criteria']) {
    expect(((await $.tool.call(dispatch('run-pillar-brief.yml', { mode, file: 'x.json', dry_run: true }))) as any).deny, mode).toBeUndefined()
  }
  expect(w.reached.length).toBe(3)
})
