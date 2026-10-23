import { test as kitTest } from 'claude-code/testing'

// Every test in this mod runs under the kit's 5 s default budget, and the budget is wall-clock: a file's tests run
// together, so on the pooled, CPU-bound bbm-vps runners a test is charged for the whole file's load (3 to 6 s per test
// in CI against about 0.3 s locally; PR #2094 jobs 120178220652, 120182832442, 120188320022). Everything here is mocked and
// in-process, so there is no wait to replace with a condition: the budget is the only thing to raise. 60 s is about 5x the
// worst test measured with the machine buried under 200 busy loops (11.7 s), and a real hang still fails.
// `timeoutMs` is the option the kit honours (`timeout` is silently ignored).
export const TEST_BUDGET_MS = 60_000

export const test = ((name: string, body: any) => (kitTest as any)(name, { timeoutMs: TEST_BUDGET_MS }, body)) as typeof kitTest
