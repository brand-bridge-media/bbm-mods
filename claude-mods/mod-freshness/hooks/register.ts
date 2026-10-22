import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { CHECK_MS, newlyStale, notCheckedText, RUN_TIMEOUT_MS, wakeText } from './logic'
import type { Fingerprints } from '../types'
import type { Verdict } from './logic'
import { runArgs } from './py'

// Why (LC-1711 follow-up, 2026-10-22): a session kept open across mod merges keeps running the
// mod code its container installed at start. The Catalog orchestrator ran a fleet-tracker without
// auto-track and with the old phone-push wording, and it read as "Claude ignores the mods".
// This mod fingerprints the loaded mods at session start and, hourly, asks ./mod-freshness.py
// whether the bbm-mods mirror now ships different code for any of them.

const loaded = atom({ plugin: 'mod-freshness', key: 'loaded' } as const, {} as Fingerprints)
const warned = atom({ plugin: 'mod-freshness', key: 'warned' } as const, [] as string[])

// Wakes the host refused (submitted from inside a tool call) wait for the turn's end.
const pendingWakes: string[] = []
let ticking = false
let busy = false
let toldNotChecked = false

async function runPy($: any, payload: unknown): Promise<any> {
  try {
    const { argv, init } = runArgs($.plugin.root, 'mod-freshness.py', payload)
    const r = await $.process.run(argv, { ...init, timeoutMs: RUN_TIMEOUT_MS })
    return r?.exitCode === 0 ? JSON.parse(String(r.stdout ?? '')) : undefined
  } catch {
    return undefined
  }
}

function toast($: any, text: string) {
  try { $.ui.toast(text.split('\n')[0]!.slice(0, 200)) } catch { /* a toast never changes a verdict */ }
}

function flush($: any) {
  if (pendingWakes.length === 0) return
  const lines = pendingWakes.splice(0)
  toast($, lines[0]!)
  Promise.resolve()
    .then(() => $.prompt.submit({ text: lines.join('\n') }))
    .catch(() => { pendingWakes.unshift(...lines) })
}

async function tick($: any) {
  if (busy) return
  busy = true
  try {
    const snap = await read($, loaded)
    const v: Verdict | undefined = await runPy($, { mode: 'check', loaded: snap })
    const nc = notCheckedText(v)
    // NOT CHECKED is never read as fresh, but an hourly network blip is not worth a wake: one toast.
    if (nc && !toldNotChecked) { toldNotChecked = true; toast($, nc) }
    const fresh = newlyStale(v, await read($, warned))
    if (v && fresh.length > 0) {
      await update($, warned, w => [...w, ...fresh])
      pendingWakes.push(wakeText(fresh, v))
      flush($)
    }
  } catch { /* a failed tick is retried by the next one */ } finally {
    busy = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // The fingerprint must be of what was LOADED, so it is taken now, before anything can change on disk.
    const dirs = (await $.env.get('CLAUDE_CODE_PLUGIN_DIRS')) ?? ''
    const snap = await runPy($, { mode: 'snapshot', plugin_dirs: dirs })
    if (snap?.loaded && typeof snap.loaded === 'object') await update($, loaded, () => snap.loaded)
    if (!ticking) {
      ticking = true
      $.clock.every(CHECK_MS, () => { void tick($) })
    }
    return started
  // Fail open: a bug here must never cost the session its start.
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const res = await next(e)
    flush($)
    return res
  })
}
