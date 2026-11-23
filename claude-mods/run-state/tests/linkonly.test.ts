import { expect, mock } from 'claude-code/testing'
import { test } from './slow'

import { helperOutput, sqlReply } from './fixture'
import { isLinkOnlyEdit, receiptWritesInSql } from '../hooks/logic'

// LC-2244 (2026-11-18, deep sofas run 5e706b07): repointing `refresh_run_sections.human_action.requested.artifact_url` on the
// waiting barrier v2_s3_markup so the Refresh progress tracker links the rebuilt packet was refused: in a project thread nobody can
// answer the confirm. "Link-only" = exactly one UPDATE of refresh_run_sections that sets human_action through jsonb_set on the
// path {requested,artifact_url} to one http(s) URL (plus updated_at), on a WHERE that pins one row. Everything else that touches
// a barrier (state, findings, another json path, a whole-object replace, no row pin) must keep being judged.

const RUN = '5e706b07-1111-4222-8333-444455556666'
const SEC = 'v2_s3_markup'
const URL = 'https://claude.ai/artifact/new-packet'
const LINK = `update refresh_run_sections set human_action = jsonb_set(human_action, '{requested,artifact_url}', to_jsonb('${URL}'::text)), updated_at = now() where run_id = '${RUN}' and section_key = '${SEC}'`
const TOOL = 'mcp__Supabase__execute_sql'
const n = (q: string) => receiptWritesInSql(TOOL, q, [SEC, 'v2_s9c2']).length

test('VALID: the link-only edit of a barrier (the ticket statement and its natural spellings) is not a receipt write', () => {
  expect(n(LINK)).toBe(0)
  expect(n(`${LINK};`)).toBe(0)
  expect(n(`UPDATE public.refresh_run_sections\n  SET human_action = jsonb_set(coalesce(human_action, '{}'::jsonb), '{requested, artifact_url}', '"${URL}"'::jsonb, true)\n WHERE run_id = '${RUN}' AND section_key = '${SEC}' RETURNING section_key, human_action`)).toBe(0)
  expect(n(`update refresh_run_sections set human_action = jsonb_set(human_action, '{requested,artifact_url}', to_jsonb('${URL}')) where id = '00000000-0000-4000-8000-00000000000a'`)).toBe(0)
  expect(isLinkOnlyEdit(LINK)).toBe(true)
})

test('BAD: any other edit to a barrier is still judged', () => {
  const set = (s: string, where = `run_id = '${RUN}' and section_key = '${SEC}'`) => `update refresh_run_sections set ${s} where ${where}`
  const jp = (path: string, val = `to_jsonb('${URL}'::text)`) => `human_action = jsonb_set(human_action, '${path}', ${val})`
  for (const q of [
    set(`status = 'done'`),
    set(`${jp('{requested,artifact_url}')}, status = 'done'`),
    set(`${jp('{requested,artifact_url}')}, findings = '{}'::jsonb`),
    set(`${jp('{requested,artifact_url}')}, completed_at = now()`),
    set(jp('{submitted}', `'{"submitted_at":"2026-11-18T00:00:00Z"}'::jsonb`)),
    set(jp('{requested,header}', `to_jsonb('Pick'::text)`)),
    set(jp('{requested}', `to_jsonb('${URL}'::text)`)),
    set(`human_action = '{"requested":{"artifact_url":"${URL}"}}'::jsonb`),
    set(`human_action = human_action || '{"submitted":{"submitted_at":"x"}}'::jsonb`),
    set(`human_action = human_action #- '{requested}'`),
    set(jp('{requested,artifact_url}', `to_jsonb('not a url'::text)`)),
    set(jp('{requested,artifact_url}', `to_jsonb((select 'https://x' || status from refresh_run_sections limit 1))`)),
    set(jp('{requested,artifact_url}'), 'true'),
    // no single row pinned
    set(jp('{requested,artifact_url}'), `section_key = '${SEC}'`),
    set(jp('{requested,artifact_url}'), `run_id = '${RUN}'`),
    set(jp('{requested,artifact_url}'), `true`),
    set(jp('{requested,artifact_url}'), `run_id = '${RUN}' or section_key = '${SEC}'`),
    set(jp('{requested,artifact_url}'), `section_key = '${SEC}' and status = 'waiting'`),
    set(jp('{requested,artifact_url}'), `run_id in (select id from refresh_runs)`),
    set(jp('{requested,artifact_url}'), `id = '00000000-0000-4000-8000-00000000000a' or true`),
    set(jp('{requested,artifact_url}'), `run_id = '${RUN}' and section_key = '${SEC}' or 1 = 1`),
    `update refresh_run_sections set ${jp('{requested,artifact_url}')}`,
    `delete from refresh_run_sections where run_id = '${RUN}'`,
  ]) {
    expect(n(q), q).toBe(1)
  }
  // A second statement in the same call is judged on its own.
  expect(n(`${LINK}; update refresh_run_sections set status = 'done' where run_id = '${RUN}' and section_key = '${SEC}'`)).toBe(1)
})

// ---- through the guard, in a project thread: the barrier is WAITING_STAN, nobody answers the confirm.
async function guard($: any, on: any, planFails = false) {
  mock.store(on)
  mock.clock(on, { now: Date.parse('2026-11-18T19:00:00Z') })
  const seen = { reached: 0, asked: 0 }
  on('mcp.call', (_$: any, e: any) => {
    const q: string = e.args.query
    if (q.includes('limit 5')) {
      return { value: sqlReply([{ id: '896655cd-59e8-4f99-b127-6a275ab31e18', article_slug: 'most-comfortable-couches', status: 'in_progress' }]) } as any
    }
    return { value: sqlReply([{ id: '896655cd-59e8-4f99-b127-6a275ab31e18', stages: [] }]) } as any
  })
  on('process.run', () => (planFails
    ? ({ value: { exitCode: 1, stdout: '', stderr: 'no module named pydantic' } } as any)
    : ({ value: { exitCode: 0, stdout: helperOutput({ v2_s9c2: 'WAITING_STAN' }), stderr: '' } } as any)))
  on('tool.call', (_$: any, e: any) => {
    if (e.tool === 'AskUserQuestion') {
      seen.asked += 1
      return { result: { answers: { [e.questions?.[0]?.question]: 'Refuse' } }, text: 'Refuse' } as any
    }
    seen.reached += 1
    return { result: 'ok', text: 'ok' } as any
  })
  return seen
}

const BARRIER_LINK = `update refresh_run_sections set human_action = jsonb_set(human_action, '{requested,artifact_url}', to_jsonb('${URL}'::text)) where run_id = '896655cd-59e8-4f99-b127-6a275ab31e18' and section_key = 'v2_s9c2'`
const BARRIER_STATUS = `update refresh_run_sections set status = 'done' where run_id = '896655cd-59e8-4f99-b127-6a275ab31e18' and section_key = 'v2_s9c2'`

for (const planFails of [false, true]) {
  test(`VALID through the guard: the link-only edit of a waiting barrier runs with no question (plan unreadable: ${planFails})`, async ($, on) => {
    const seen = await guard($, on, planFails)
    const out: any = await $.tool.call({ tool: TOOL, query: BARRIER_LINK } as any)
    expect(out.deny).toBeUndefined()
    expect(seen.asked).toBe(0)
    expect(seen.reached).toBe(1)
  })
}

test('BAD through the guard: a state change on the same waiting barrier is still asked, and refused when nobody answers', async ($, on) => {
  const seen = await guard($, on)
  const out: any = await $.tool.call({ tool: TOOL, query: BARRIER_STATUS } as any)
  expect(JSON.stringify(out)).toContain('[mod:run-state]')
  expect(JSON.stringify(out)).toContain('human barrier')
  expect(seen.reached).toBe(0)
})
