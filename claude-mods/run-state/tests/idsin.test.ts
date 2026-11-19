import { expect } from 'claude-code/testing'
import { test } from './slow'

import { againstPlan, idsIn, receiptWritesInSql } from '../hooks/logic'

// LCH-745: ids are whole words, and a SQL target is re-matched against the plan it is judged on.
test('idsIn matches whole section ids only', () => {
  expect(idsIn("section_key = 'v2_s6'", ['v2_s6', 'v2_s6_vos'])).toEqual(['v2_s6'])
  expect(idsIn("section_key = 'v2_s6_vos'", ['v2_s6'])).toEqual([])
})

test('againstPlan re-matches a SQL target, leaves a Bash target alone', () => {
  const [t] = receiptWritesInSql('mcp__Supabase__execute_sql',
    "update refresh_run_sections set findings = '{}' where section_key = 'v2_s6'", [])
  expect(t.ids).toEqual([])
  const view: any = { slug: 's', runId: 'r', table: [{ id: 'v2_s6', stage: 6, part: null }], sections: [] }
  expect(againstPlan(t, view).ids).toEqual(['v2_s6'])
  const bash: any = { what: 'x', ids: [], pairs: [], passes: [] }
  expect(againstPlan(bash, view)).toBe(bash)
})
