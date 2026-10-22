// Pure decisions for mod-freshness. The comparison itself lives in ./mod-freshness.py (its own
// --selftest); this file only decides what to say about its answer.

export const CHECK_MS = 60 * 60_000 // hourly: a merge-to-mirror takes minutes, a stale session lasts hours
export const RUN_TIMEOUT_MS = 60_000 // the check fetches the mirror over the network

export type Verdict = {
  stale?: string[]
  fresh?: string[]
  not_checked?: Record<string, string>
  mirror?: string
}

/** Stale mods not yet reported this session. Each mod is reported once; a newly stale one is reported again. */
export function newlyStale(v: Verdict | undefined, warned: readonly string[]): string[] {
  return (v?.stale ?? []).filter(m => !warned.includes(m))
}

/** The wake text for newly stale mods. */
export function wakeText(stale: readonly string[], v: Verdict): string {
  const names = stale.join(', ')
  const head = v.mirror ? ` The mirror now ships: ${v.mirror}.` : ''
  return `[mod:mod-freshness] This session is running out-of-date mod code: ${names}.${head} ` +
    'Mods load once, when the container starts, so fixes merged since then are not active here. ' +
    'Tell the operator in chat, opening with the NEEDS YOU banner: start a fresh session to pick them up ' +
    '(carry open work over with the session-handoff skill). Until then, do the stale mod\'s job by hand ' +
    'where it matters (for fleet-tracker: track every child session yourself, never a timed check-in).'
}

/** A NOT CHECKED line for the operator's toast, or undefined when everything was checked. */
export function notCheckedText(v: Verdict | undefined): string | undefined {
  const nc = v?.not_checked ?? {}
  const why = nc['*'] ?? Object.values(nc)[0]
  if (v && why === undefined) return undefined
  return `[mod:mod-freshness] NOT CHECKED: ${why ?? 'the check returned nothing'}`
}
