// Pure decisions for mod-freshness. The comparison itself lives in ./mod-freshness.py (its own
// --selftest); this file only decides what to say about its answer.

export const CHECK_MS = 60 * 60_000 // hourly: a merge-to-mirror takes minutes, a stale session lasts hours
export const RUN_TIMEOUT_MS = 60_000 // the check fetches the mirror over the network

export type Verdict = {
  stale?: string[]
  fresh?: string[]
  /** Mirror mods this session never loaded; only reported for the account copy (LC-2217). */
  missing?: string[]
  /** The loaded mods came from the claude.ai account copy, which a fresh session does not refresh. */
  account?: boolean
  not_checked?: Record<string, string>
  mirror?: string
  /** When the mirror's head commit landed (ISO). */
  mirror_at?: string
  /**
   * Account copy only. True: this thread synced AFTER the mirror head and still differs, so the account copy
   * itself is behind and only the operator can fix it. False: this thread synced BEFORE the mirror head, so
   * only this thread's copy is known to be old; a new thread may already be current (board request #72).
   */
  account_behind?: boolean
}

/** Stale mods not yet reported this session. Each mod is reported once; a newly stale one is reported again. */
export function newlyStale(v: Verdict | undefined, warned: readonly string[]): string[] {
  return [...(v?.stale ?? []), ...(v?.missing ?? [])].filter(m => !warned.includes(m))
}

/** The wake text for newly stale mods. */
export function wakeText(stale: readonly string[], v: Verdict): string {
  const names = stale.join(', ')
  const head = v.mirror ? ` The mirror now ships: ${v.mirror}.` : ''
  if (v.account) {
    // LC-2217: a project thread loads the claude.ai account copy, which does not follow the mirror,
    // so "start a fresh session" would load the same old code again.
    const missing = (v.missing ?? []).filter(m => stale.includes(m))
    const gone = missing.length ? ` Not loaded at all: ${missing.join(', ')}.` : ''
    if (v.account_behind === false) {
      // Board request #72 (2026-11-20): three threads that started before the operator's Check for updates
      // kept asking for it after it was done. This thread cannot see today's account copy, only the one it
      // started with; a thread started later checks the account itself and asks only if it is really behind.
      return `[mod:mod-freshness] This thread started with an older copy of these mods: ${names}.${head}${gone} ` +
        'The thread synced its mods before that mirror change, so it cannot tell whether the claude.ai account ' +
        'copy is current. Do NOT ask the operator to run Check for updates and do not use the NEEDS YOU banner: ' +
        'a thread started later checks the account copy itself and asks only if it is really behind. If this ' +
        'thread\'s work depends on the changed mod, mention in one line that a new thread has the newer copy. ' +
        'Until then, do the stale mod\'s job by hand where it matters.'
    }
    return `[mod:mod-freshness] This thread loaded the claude.ai account copy of the mods, and it is behind the ` +
      `bbm-mods mirror for: ${names}.${head}${gone} A fresh thread loads the same old copy. ` +
      'Tell the operator in chat, opening with the NEEDS YOU banner: on claude.ai Plugins, run Check for updates ' +
      'on the bbm-mods marketplace (if a mod is still behind after that, Remove and re-add the marketplace; never a zip upload, LC-2217), then start a new thread. ' +
      'See LC-2217. Until then, do the stale mod\'s job by hand where it matters.'
  }
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
