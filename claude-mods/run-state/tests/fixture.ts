// A trimmed copy of a REAL conductor verdict: run 896655cd (most-comfortable-couches, v2),
// produced 2026-10-07 by running refresh_conductor.py's evaluate() on the row read through the
// Supabase MCP (LC-1715 step 0). Trimmed to the sections the tests need; states are unchanged.
const sec = (id: string, state: string, unmet: string[] = []) => ({ id, label: id, kind: 'script', state, unmet })

export const helperOutput = (over: Record<string, string> = {}) => {
  const state = (id: string, dflt: string) => over[id] ?? dflt
  return JSON.stringify({
    plan: {
      run_id: '896655cd-59e8-4f99-b127-6a275ab31e18',
      slug: 'most-comfortable-couches',
      run_status: 'in_progress',
      pipeline_version: 2,
      sections: [
        sec('v2_s0', 'DONE'),
        sec('v2_s9c1', state('v2_s9c1', 'FAILED')),
        sec('v2_s9c2', state('v2_s9c2', 'READY')),
        sec('v2_s9c6', state('v2_s9c6', 'READY')),
        sec('v2_s10', 'BLOCKED', ['9 Receipts audit', '9 Technical audit Pass A']),
        sec('v2_s11c5', 'BLOCKED', ['Render-integrity check']),
      ],
    },
    table: [
      { id: 'v2_s0', stage: 0, part: null },
      { id: 'v2_s9c1', stage: 9, part: 'c1' },
      { id: 'v2_s9c2', stage: 9, part: 'c2' },
      { id: 'v2_s9c6', stage: 9, part: 'c6' },
      { id: 'v2_s10', stage: 10, part: null },
      { id: 'v2_s11c5', stage: 11, part: 'c5' },
    ],
    pass_a: { verdict: 'BLOCK', at: '2026-10-05T16:08:11Z' },
  })
}

const envelope = (rows: unknown[]) =>
  '<untrusted-data-x>\n' + JSON.stringify(rows) + '\n</untrusted-data-x>'

// What the Supabase MCP returns for execute_sql, wrapped as the real server wraps it.
export const sqlReply = (rows: unknown[]) => ({
  isError: false,
  content: [{ type: 'text', text: 'Below is the result...\n\n' + envelope(rows) }],
})
