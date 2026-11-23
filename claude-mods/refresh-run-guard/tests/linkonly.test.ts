import { test, expect } from 'claude-code/testing'

// LC-2244: PR #4384 let run-state allow one link-only edit, but this mod still refused it through Supabase MCP
// execute_sql, so the Refresh progress tracker kept a stale packet link. Exactly one statement shape is let through:
// UPDATE refresh_run_sections SET human_action = jsonb_set(human_action, '{requested,artifact_url}', <one http(s) URL
// literal>) [, updated_at = now()] WHERE <one row pinned by id, or run_id AND section_key>. Everything else keeps being denied.
// Twin of claude-mods/run-state/tests/linkonly.test.ts.

const RUN = '5e706b07-1111-4222-8333-444455556666'
const SEC = 'v2_s3_markup'
const URL = 'https://claude.ai/artifact/new-packet'
const TOOL = 'mcp__Supabase__execute_sql'
const LINK = `update refresh_run_sections set human_action = jsonb_set(human_action, '{requested,artifact_url}', to_jsonb('${URL}'::text)), updated_at = now() where run_id = '${RUN}' and section_key = '${SEC}'`
const pass = (on: any) => on('tool.call', () => ({ result: 'ok', text: 'ok' }) as any)
const run = async ($: any, query: string) => ((await $.tool.call({ tool: TOOL, query } as any)) as any).deny

test('VALID: the ticket link-only edit and its natural spellings are not denied', async ($, on) => {
  pass(on)
  for (const q of [
    LINK,
    `${LINK};`,
    `UPDATE public.refresh_run_sections\n  SET human_action = jsonb_set(coalesce(human_action, '{}'::jsonb), '{requested, artifact_url}', '"${URL}"'::jsonb, true)\n WHERE run_id = '${RUN}' AND section_key = '${SEC}' RETURNING section_key, human_action`,
    `update refresh_run_sections set human_action = jsonb_set(human_action, '{requested,artifact_url}', to_jsonb('${URL}')) where id = '00000000-0000-4000-8000-00000000000a'`,
  ]) {
    expect(await run($, q), q).toBeUndefined()
  }
})

test('BAD: any other edit of refresh_run_sections is still denied', async ($, on) => {
  pass(on)
  const set = (s: string, where = `run_id = '${RUN}' and section_key = '${SEC}'`) => `update refresh_run_sections set ${s} where ${where}`
  const jp = (path: string, val = `to_jsonb('${URL}'::text)`) => `human_action = jsonb_set(human_action, '${path}', ${val})`
  const LP = '{requested,artifact_url}'
  for (const q of [
    // other columns
    set(`status = 'done'`),
    set(`${jp(LP)}, status = 'done'`),
    set(`${jp(LP)}, findings = '{}'::jsonb`),
    set(`${jp(LP)}, completed_at = now()`),
    // other jsonb paths and whole-object edits
    set(jp('{submitted}', `'{"submitted_at":"2026-11-18T00:00:00Z"}'::jsonb`)),
    set(jp('{requested,header}', `to_jsonb('Pick'::text)`)),
    set(jp('{requested}', `to_jsonb('${URL}'::text)`)),
    set(`human_action = '{"requested":{"artifact_url":"${URL}"}}'::jsonb`),
    set(`human_action = human_action || '{"submitted":{"submitted_at":"x"}}'::jsonb`),
    set(`human_action = human_action #- '{requested}'`),
    // not a URL literal
    set(jp(LP, `to_jsonb('not a url'::text)`)),
    set(jp(LP, `to_jsonb((select 'https://x' || status from refresh_run_sections limit 1))`)),
    // multiple statements
    `${LINK}; update refresh_run_sections set status = 'done' where run_id = '${RUN}' and section_key = '${SEC}'`,
    `select 1; ${LINK}`,
    `${LINK}; delete from refresh_run_sections where run_id = '${RUN}'`,
    // no WHERE, or a WHERE that does not pin one row
    `update refresh_run_sections set ${jp(LP)}`,
    set(jp(LP), `section_key = '${SEC}'`),
    set(jp(LP), `run_id = '${RUN}'`),
    set(jp(LP), `true`),
    set(jp(LP), `run_id = '${RUN}' or section_key = '${SEC}'`),
    set(jp(LP), `section_key = '${SEC}' and status = 'waiting'`),
    set(jp(LP), `run_id in (select id from refresh_runs)`),
    set(jp(LP), `id = '00000000-0000-4000-8000-00000000000a' or true`),
    set(jp(LP), `run_id = '${RUN}' and section_key = '${SEC}' or 1 = 1`),
    // a comment or CTE riding along
    `${LINK} -- and more`,
    `with t as (${LINK} returning 1) select * from t`,
    // other table, and receipt writes
    `delete from refresh_run_sections where run_id = '${RUN}'`,
    `update refresh_runs set stages = jsonb_set(stages, '{a}', '1') where id = '${RUN}'`,
    // dynamic SQL naming the table
    `do $$ begin execute 'update refresh_run_sections set status = ''done'''; end $$`,
  ]) {
    expect(await run($, q), q).toContain('[mod:refresh-run-guard]')
  }
})

test('BAD: a publish-related write is still denied, link-only edit or not', async ($, on) => {
  pass(on)
  const WF = 'mcp__webflow__data_cms_tool'
  const pub: any = await $.tool.call({ tool: WF, actions: [{ publish_collection_items: { collection_id: '65fa33419d90d967c68a0964' } }] } as any)
  expect(pub.deny).toContain('[mod:refresh-run-guard]')
  const bash: any = await $.tool.call({ tool: 'Bash', command: 'curl -X POST https://api.webflow.com/v2/sites/abc/publish -d {}' } as any)
  expect(bash.deny).toContain('[mod:refresh-run-guard]')
  // a publish call in the same SQL text as the link edit is not the one allowed shape
  expect(await run($, `${LINK}; select publish_collection_items('x')`)).toContain('[mod:refresh-run-guard]')
})
