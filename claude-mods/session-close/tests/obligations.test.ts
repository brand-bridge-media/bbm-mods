import { test, expect, mock } from 'claude-code/testing'

// One met + one unmet case per obligation. The `on('tool.call')` beneath the
// plugin stands for the engine: it answers every call as a success, which is
// what the mod needs to count a write as having happened.
const setup = (on: any) => {
  mock.store(on)
  on('tool.call', () => ({ result: 'ok', text: 'ok' }) as any)
}
const call = ($: any, tool: string, input: Record<string, unknown> = {}) =>
  $.tool.call({ tool, ...input } as any)
const closeOut = async ($: any): Promise<string> =>
  JSON.stringify(await $.command.run({ command: 'close-out', args: '' } as any))
const MCP = (n: string) => `mcp__srv-1__${n}`
const RUN = '39a99b61-0000-4000-8000-000000000001'

// Two work signals make the session "non-trivial" for the INGEST obligation.
const doWork = async ($: any) => {
  await call($, MCP('merge_pull_request'), { owner: 'o', repo: 'r', pullNumber: 1 })
  await call($, MCP('merge_pull_request'), { owner: 'o', repo: 'r', pullNumber: 2 })
}

test('ingest unmet: non-trivial work, no knowledge_memories INSERT', async ($, on) => {
  setup(on)
  await doWork($)
  expect(await closeOut($)).toContain('Knowledge INGEST')
})

test('ingest met: knowledge_memories INSERT observed', async ($, on) => {
  setup(on)
  await doWork($)
  await call($, MCP('execute_sql'), { project_id: 'p', query: "INSERT INTO public.knowledge_memories (content) VALUES ('x')" })
  expect(await closeOut($)).not.toContain('Knowledge INGEST')
})

test('jira unmet: ticket transitioned, never commented', async ($, on) => {
  setup(on)
  await call($, MCP('transitionJiraIssue'), { issueIdOrKey: 'LC-1713' })
  expect(await closeOut($)).toContain('no comment on LC-1713')
})

test('jira met: comment on the ticket the session served', async ($, on) => {
  setup(on)
  await call($, MCP('transitionJiraIssue'), { issueIdOrKey: 'LC-1713' })
  await call($, MCP('addCommentToJiraIssue'), { issueIdOrKey: 'LC-1713', commentBody: 'done' })
  expect(await closeOut($)).not.toContain('no comment on LC-1713')
})

test('run unmet: refresh_runs read back in_progress', async ($, on) => {
  mock.store(on)
  on('tool.call', () => ({ result: [{ id: RUN, status: 'in_progress' }], text: JSON.stringify([{ id: RUN, status: 'in_progress' }]) }) as any)
  await call($, MCP('execute_sql'), { project_id: 'p', query: `select id, status from refresh_runs where id = '${RUN}'` })
  expect(await closeOut($)).toContain(`refresh_runs ${RUN}`)
})

test('run met: the session closed the run it touched', async ($, on) => {
  setup(on)
  await call($, MCP('execute_sql'), { project_id: 'p', query: `update refresh_runs set status = 'in_progress' where id = '${RUN}'` })
  await call($, MCP('execute_sql'), { project_id: 'p', query: `update refresh_runs set status = 'done' where id = '${RUN}'` })
  expect(await closeOut($)).not.toContain(`refresh_runs ${RUN}`)
})

const publish = ($: any) => call($, MCP('data_cms_tool'), { actions: [{ publish_collection_items: { collection_id: 'c' } }] })

test('checkpoints unmet: published, nothing scheduled', async ($, on) => {
  setup(on)
  await publish($)
  const out = await closeOut($)
  expect(out).toContain('cannibalization re-check not scheduled')
  expect(out).toContain('30/60/90 GSC checkpoints not scheduled')
})

test('checkpoints met: send_later + Jira next-due cover both', async ($, on) => {
  setup(on)
  await publish($)
  await call($, MCP('send_later'), { delay_minutes: 20160, message: '+2 week cannibalization re-check for the sofa refresh' })
  await call($, MCP('editJiraIssue'), { issueIdOrKey: 'LC-9', fields: { description: 'Next due: GSC checkpoint 30/60/90' } })
  const out = await closeOut($)
  expect(out).not.toContain('cannibalization re-check not scheduled')
  expect(out).not.toContain('30/60/90 GSC checkpoints not scheduled')
})

test('pass verdicts unmet: published, none recorded', async ($, on) => {
  setup(on)
  await publish($)
  const out = await closeOut($)
  expect(out).toContain('no Pass A verdict')
  expect(out).toContain('no Pass B verdict')
})

test('pass verdicts met: Pass A via Jira comment, Pass B via receipt script', async ($, on) => {
  setup(on)
  await publish($)
  await call($, MCP('transitionJiraIssue'), { issueIdOrKey: 'LC-9' })
  await call($, MCP('addCommentToJiraIssue'), { issueIdOrKey: 'LC-9', commentBody: 'Pass A: PASS 2026-10-07' })
  await call($, 'Bash', { command: 'python3 article_audit.py --slug x --pass b --write-receipt' })
  const out = await closeOut($)
  expect(out).not.toContain('no Pass A verdict')
  expect(out).not.toContain('no Pass B verdict')
})

test('a failed write is not counted, and nothing is denied', async ($, on) => {
  mock.store(on)
  on('tool.call', () => ({ result: 'boom', text: 'boom', isError: true }) as any)
  await call($, MCP('execute_sql'), { project_id: 'p', query: "INSERT INTO public.knowledge_memories (content) VALUES ('x')" })
  await call($, MCP('merge_pull_request'), {})
  expect(await closeOut($)).toContain('nothing unmet')
})

// The nudge never blocks and never alters the answer: a wrap-up turn with
// unmet obligations shows a status line and still resolves to the model's text.
const turn = ($: any, answer: string) =>
  $.turn.complete({ answer, durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' } as any)

test('wrap-up turn with unmet obligations nudges and passes the answer through', async ($, on) => {
  setup(on)
  const lines: unknown[] = []
  on('ui.status', ((_$: any, e: any) => { lines.push(e.text); return { value: undefined } }) as any)
  on('ui.toast', (() => ({ value: undefined })) as any)
  on('turn.complete', ((_$: any, e: any) => ({ text: e.answer })) as any)
  await doWork($)
  const out: any = await turn($, 'All done, merged.')
  expect(out.text).toBe('All done, merged.')
  expect(JSON.stringify(lines)).toContain('close-out: 1 unmet')
})

test('mid-work turn stays quiet', async ($, on) => {
  setup(on)
  const lines: unknown[] = []
  on('ui.status', ((_$: any, e: any) => { lines.push(e.text); return { value: undefined } }) as any)
  on('turn.complete', ((_$: any, e: any) => ({ text: e.answer })) as any)
  await doWork($)
  await turn($, 'Reading the next file.')
  expect(JSON.stringify(lines)).not.toContain('close-out')
})

test('bare "checkpoint" does not satisfy the GSC schedule', async ($, on) => {
  setup(on)
  await publish($)
  await call($, MCP('send_later'), { delay_minutes: 5, message: 'security checkpoint reminder' })
  expect(await closeOut($)).toContain('30/60/90 GSC checkpoints not scheduled')
})

test('Pass verdict prose on an unrelated ticket does not count', async ($, on) => {
  setup(on)
  await publish($)
  await call($, MCP('addCommentToJiraIssue'), { issueIdOrKey: 'LC-5', commentBody: 'Pass A: PASS and Pass B: pass' })
  const out = await closeOut($)
  expect(out).toContain('no Pass A verdict')
  expect(out).toContain('no Pass B verdict')
})

test('SQL on another table cannot close a run or satisfy a Pass verdict', async ($, on) => {
  mock.store(on)
  on('tool.call', () => ({ result: [{ id: RUN, status: 'in_progress' }], text: JSON.stringify([{ id: RUN, status: 'in_progress' }]) }) as any)
  await call($, MCP('execute_sql'), { project_id: 'p', query: `select id, status from refresh_runs where id = '${RUN}'` })
  await call($, MCP('execute_sql'), { project_id: 'p', query: `update other_table set status = 'done', note = 'pass_a pass_b' where run = '${RUN}'` })
  await call($, MCP('execute_sql'), { project_id: 'p', query: `update other_table set status = 'done', note = 'pass_a' where id in (select id from refresh_runs where id = '${RUN}')` })
  await call($, MCP('execute_sql'), { project_id: 'p', query: `select id, status from not_refresh_runs where id = '${RUN}'` })
  await publish($)
  const out = await closeOut($)
  expect(out).toContain(`refresh_runs ${RUN}`)
  expect(out).toContain('no Pass A verdict')
})

test('a list_published read is neither a write nor a publish', async ($, on) => {
  setup(on)
  await call($, MCP('data_cms_tool'), { actions: [{ list_published_items: { collection_id: 'c' } }] })
  expect(await closeOut($)).toContain('nothing unmet')
})

const sql = ($: any, query: string) => call($, MCP('execute_sql'), { project_id: 'p', query })

test('a queued run read back stays open; an unknown status changes nothing', async ($, on) => {
  mock.store(on)
  on('tool.call', () => ({ result: 'r', text: JSON.stringify([{ id: RUN, status: 'queued' }]) }) as any)
  await sql($, `select id, status from refresh_runs where id = '${RUN}'`)
  expect(await closeOut($)).toContain(`refresh_runs ${RUN}`)
})

test('prose in a refresh_runs note moves neither run state nor Pass verdicts', async ($, on) => {
  setup(on)
  await sql($, `update refresh_runs set status = 'in_progress' where id = '${RUN}'`)
  await sql($, `update refresh_runs set note = 'was ''done'', awaiting pass_a / pass_b' where id = '${RUN}'`)
  await publish($)
  const out = await closeOut($)
  expect(out).toContain(`refresh_runs ${RUN}`)
  expect(out).toContain('no Pass A verdict')
  expect(out).toContain('no Pass B verdict')
})

test('Pass verdicts are never read from SQL, only receipts and anchored Jira comments', async ($, on) => {
  setup(on)
  await publish($)
  await sql($, `update refresh_runs set selection_provenance = selection_provenance, note = 'pass_a: PASS, pass_b: BLOCK' where id = '${RUN}'`)
  await sql($, `update refresh_runs set verification = '{"pass_b": "PASS"}' where id = '${RUN}'`)
  const out = await closeOut($)
  expect(out).toContain('no Pass A verdict')
  expect(out).toContain('no Pass B verdict')
})

test('receipt flags count in either order', async ($, on) => {
  setup(on)
  await publish($)
  await call($, 'Bash', { command: 'python3 article_audit.py --write-receipt --pass a --slug x' })
  expect(await closeOut($)).not.toContain('no Pass A verdict')
})

test('an unrecognised status on a read does not close an open run', async ($, on) => {
  mock.store(on)
  on('tool.call', () => ({ result: 'r', text: JSON.stringify([{ id: RUN, status: 'weird' }]) }) as any)
  await sql($, `update refresh_runs set status = 'in_progress' where id = '${RUN}'`)
  await sql($, `select id, status from refresh_runs where id = '${RUN}'`)
  expect(await closeOut($)).toContain(`refresh_runs ${RUN}`)
})

test('a phrase inside a quoted value is not an INSERT target', async ($, on) => {
  setup(on)
  await doWork($)
  await sql($, "select 1 from t where note = 'insert into knowledge_memories'")
  expect(await closeOut($)).toContain('Knowledge INGEST')
})

test('arguments nested under input are still detected', async ($, on) => {
  setup(on)
  await call($, MCP('transitionJiraIssue'), { input: { issueIdOrKey: 'LC-11' } })
  expect(await closeOut($)).toContain('no comment on LC-11')
})

test('Pass verdict text in a note literal never counts, whatever the quoting', async ($, on) => {
  setup(on)
  await publish($)
  await sql($, `update refresh_runs set note = 'pass_a: PASS, pass_b: BLOCK' where id = '${RUN}'`)
  const out = await closeOut($)
  expect(out).toContain('no Pass A verdict')
  expect(out).toContain('no Pass B verdict')
})

test('unterminated, dollar-quoted and commented INSERT text does not meet INGEST', async ($, on) => {
  setup(on)
  await doWork($)
  await sql($, "select 1 from t where note = 'insert into knowledge_memories")
  await sql($, 'select $q$ insert into knowledge_memories $q$')
  await sql($, 'select 1 -- insert into knowledge_memories (content) values (1)')
  await sql($, 'select 1 /* insert into knowledge_memories */')
  expect(await closeOut($)).toContain('Knowledge INGEST')
})

test('a real INSERT after a comment and a literal still counts', async ($, on) => {
  setup(on)
  await doWork($)
  await sql($, "-- capture\nselect 'x'; INSERT INTO public.knowledge_memories (content) VALUES ('it''s done $$ ok')")
  expect(await closeOut($)).not.toContain('Knowledge INGEST')
})

test('a commented-out status assignment cannot close a run', async ($, on) => {
  setup(on)
  await sql($, `update refresh_runs set status = 'in_progress' where id = '${RUN}'`)
  await sql($, `update refresh_runs set x = 1 -- status = 'done'\nwhere id = '${RUN}'`)
  await sql($, `update refresh_runs set x = 1 /* status = 'done' */ where id = '${RUN}'`)
  expect(await closeOut($)).toContain(`refresh_runs ${RUN}`)
})

test('a multi-run read pairs each id with its own status', async ($, on) => {
  mock.store(on)
  const OTHER = '39a99b61-0000-4000-8000-000000000002'
  on('tool.call', () => ({ result: 'r', text: JSON.stringify([{ id: RUN, status: 'done' }, { id: OTHER, status: 'in_progress' }]) }) as any)
  await sql($, `select id, status from refresh_runs where id in ('${RUN}', '${OTHER}')`)
  const out = await closeOut($)
  expect(out).toContain(`refresh_runs ${OTHER}`)
  expect(out).not.toContain(`refresh_runs ${RUN}`)
})

test('an INSERT never moves run state', async ($, on) => {
  setup(on)
  await sql($, `insert into refresh_runs (id, status) values ('${RUN}', 'in_progress')`)
  expect(await closeOut($)).toContain('nothing unmet')
})

test('negated or untimed schedule prose does not satisfy the checkpoints', async ($, on) => {
  setup(on)
  await publish($)
  await call($, MCP('send_later'), { delay_minutes: 5, message: 'do not schedule gsc or cannibalization checks' })
  await call($, MCP('send_later'), { message: '+2 week cannibalization and 30/60/90 GSC' })
  const out = await closeOut($)
  expect(out).toContain('cannibalization re-check not scheduled')
  expect(out).toContain('30/60/90 GSC checkpoints not scheduled')
})

test('an error-shaped result is not a confirmed write', async ($, on) => {
  mock.store(on)
  on('tool.call', () => ({ result: 'r', text: 'ERROR: permission denied' }) as any)
  await call($, MCP('transitionJiraIssue'), { issueIdOrKey: 'LC-12' })
  expect(await closeOut($)).toContain('nothing unmet')
})

test('wrong-typed fields in a saved ledger are dropped on restore', async ($, on) => {
  mock.store(on, { 'session-close:ledger': { ingests: 'many', served: 'LC-1', runs: [], commits: true } })
  on('tool.call', () => ({ result: 'ok', text: 'ok' }) as any)
  on('command.register', (() => ({ value: undefined })) as any)
  on('session.start', (() => ({ cwd: '/tmp' })) as any)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  await doWork($)
  expect(await closeOut($)).toContain('Knowledge INGEST')
})

test('ids that contain write words are not Webflow writes or publishes', async ($, on) => {
  setup(on)
  await call($, MCP('data_cms_tool'), { actions: [{ list_items: { collection_id: 'my_publish_test' } }] })
  await call($, MCP('data_cms_tool'), { actions: [{ list_items: { collection_id: 'create_me' } }] })
  await call($, MCP('data_cms_tool'), { actions: [{ get_item: { item_id: 'update_bulk_add_1' } }] })
  expect(await closeOut($)).toContain('nothing unmet')
})

test('only a result whose FIRST line reads as an error is discarded', async ($, on) => {
  mock.store(on)
  on('tool.call', () => ({ result: 'r', text: 'ERROR: permission denied' }) as any)
  await call($, MCP('transitionJiraIssue'), { issueIdOrKey: 'LC-13' })
  expect(await closeOut($)).toContain('nothing unmet')
})

test('a later line that starts with "error" is ordinary output and still counts', async ($, on) => {
  mock.store(on)
  on('tool.call', () => ({ result: 'r', text: 'transitioned\nerror budget unchanged' }) as any)
  await call($, MCP('transitionJiraIssue'), { issueIdOrKey: 'LC-14' })
  expect(await closeOut($)).toContain('no comment on LC-14')
})

test('a refresh_runs subquery inside another table\'s SELECT cannot close a run', async ($, on) => {
  mock.store(on)
  let n = 0
  on('tool.call', () => {
    n += 1
    const status = n === 1 ? 'in_progress' : 'done'
    return { result: 'r', text: JSON.stringify([{ id: RUN, status }]) } as any
  })
  await sql($, `select id, status from refresh_runs where id = '${RUN}'`)
  await sql($, `select id, status from other_table where id in (select id from refresh_runs where id = '${RUN}')`)
  expect(await closeOut($)).toContain(`refresh_runs ${RUN}`)
})

test('an observer that throws never changes the tool result', async ($, on) => {
  // The store write inside observing blows up; the tool's own answer must
  // still come back exactly as the engine gave it.
  on('store.set', (() => { throw new Error('boom') }) as any)
  on('tool.call', () => ({ result: 'untouched', text: 'untouched' }) as any)
  const out: any = await call($, MCP('transitionJiraIssue'), { issueIdOrKey: 'LC-15' })
  expect(out.result).toBe('untouched')
  expect(out.text).toBe('untouched')
})

test('the checklist says which schedule shapes it accepts', async ($, on) => {
  setup(on)
  await publish($)
  expect(await closeOut($)).toContain('accepted: send_later / create_trigger / CronCreate with a time, or a Jira next-due/duedate write')
})

const startSession = async ($: any, on: any, savedId: string, currentId: string) => {
  mock.store(on, { 'session-close:ledger': { served: ['LC-77'], sessionId: savedId } })
  on('session.id', (() => ({ value: currentId })) as any)
  on('command.register', (() => ({ value: undefined })) as any)
  on('session.start', (() => ({ cwd: '/tmp' })) as any)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
}

test('a ledger saved by another session is not inherited', async ($, on) => {
  await startSession($, on, 'session_old', 'session_new')
  expect(await closeOut($)).toContain('nothing unmet')
})

test('the same session restores its own ledger', async ($, on) => {
  await startSession($, on, 'session_same', 'session_same')
  expect(await closeOut($)).toContain('no comment on LC-77')
})
