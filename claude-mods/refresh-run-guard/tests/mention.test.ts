import { test, expect } from 'claude-code/testing'

// LCH-552: a Bash command that only MENTIONS publishing (a column name such as webflow_last_published, the
// word "published" in prose or a JSON fixture) is not a publish. The script-name rule judges a script NAMED
// for a Webflow publish; the participle "published" is not a script name. A real publish stays denied.
// Review by 2027-02-23: false-positive guard for the publish-name rule; the real calls below must stay denied.

const passthrough = (on: any) =>
  on('tool.call', () => ({ result: { stdout: 'ran', stderr: '', interrupted: false }, text: 'ran' }) as any)
const bash = ($: any, command: string): Promise<any> => $.tool.call({ tool: 'Bash', command } as any)
const DENY = /^\[mod:refresh-run-guard\] /

test('LCH-552 valid: commands that only mention publishing or webflow_last_published run', async ($, on) => {
  passthrough(on)
  for (const cmd of [
    // python -c naming the column (the ticket's shape)
    `python3 -c "print('select webflow_last_published from articles')"`,
    `python3 -c "import json; json.dump({'slug': 'best-sofas', 'webflow_last_published': None}, open('f.json', 'w'))"`,
    // heredoc patch of a README table row that names the column
    `python3 - <<'PY'\nrow = '| webflow_last_published | when the article was published |'\nprint(row)\nPY`,
    // a JSON fixture mentioning a slug and "published"
    `python3 -c "import json; json.dump({'slug': 'best-sofas', 'status': 'published'}, open('fixture.json', 'w'))"`,
    `python3 -c "print('webflow_published_at is the live date; the page was published')"`,
  ]) {
    const r = await bash($, cmd)
    expect(r.deny).toBeUndefined()
  }
})

test('LCH-552 bad: a real publish call or a script named for a Webflow publish is still denied', async ($, on) => {
  passthrough(on)
  for (const cmd of [
    'curl -X POST https://api.webflow.com/v2/sites/abc/publish -d {}',
    `python3 -c "import os; os.system('curl -X POST https://api.webflow.com/v2/sites/abc/publish')"`,
    `python3 -c "client.publish_collection_items('c', ['i'])"`,
    'python3 webflow-publish-site.py',
    'python3 webflow_publish.py --all',
    'bash scripts/publish_webflow.sh',
    'python3 webflow/publishwebflow.py',
    'node webflow-publish.js',
    'python3 webflow_publish_all.py',
  ]) {
    const r = await bash($, cmd)
    expect(r.deny).toMatch(DENY)
    expect(r.deny).toContain('publishes to Webflow')
  }
})
