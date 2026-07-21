// JS side of the native background publish pipeline: mirrors the MINIMUM
// config (identity sk, active circle seed + precision, relays, no-report
// zones, off-grid) into the Keystore-backed native store, and reads back the
// publish journal on resume. Design: docs/plans/
// 2026-07-05-native-background-publish-design.md. The mirror is persistent (a
// killed process's native task reads it without the WebView); its config is
// cleared on stop-sharing and on reopen into the app-lock screen (journal
// preserved for a later drain); decoy hide and reset go further and wipe the
// journal too — app.ts owns calling us.

import { registerPlugin } from '@capacitor/core'
import { postureOf, type Persisted } from '../app/src/store'
import type { NoReportZone } from '@forgesworn/flock'

interface FlockPublishPlugin {
  setConfig(options: { json: string }): Promise<void>
  clearConfig(): Promise<void>
  wipeAll(): Promise<void>
  getJournal(): Promise<{ entries: string[] }>
  ackJournal(options: { count: number }): Promise<void>
}

const FlockPublish = registerPlugin<FlockPublishPlugin>('FlockPublish')

export interface NativePublishConfig {
  v: 1
  skHex: string
  circleId: string
  seedHex: string
  precision: number
  festivalUntil: number
  relayUrls: string[]
  noReportZones: NoReportZone[]
  offGridUntil: number
  /** Radar session (live navigation) cadence lift — 0s when no session is
   *  live. The native publisher applies the session floors strictly while
   *  `now < sessionUntilSec`, so a session expires on the native clock even
   *  if the WebView never wakes to withdraw it. CADENCE ONLY — precision
   *  stays `precision` and every policy cap applies exactly as without. */
  sessionMinIntervalSec: number
  sessionHeartbeatSec: number
  sessionUntilSec: number
}

/** Pure: the config to mirror, or null when background publish must be off
 *  (not sharing, no local key — Signet, no circle). Null clears the mirror. */
export function buildNativePublishConfig(
  persisted: Persisted,
  sharing: boolean,
  basePrecision: number,
  session: { minIntervalSec: number; heartbeatSec: number; untilSec: number } | null = null,
): NativePublishConfig | null {
  if (!sharing) return null
  const skHex = persisted.identity?.skHex
  if (!skHex || persisted.authMethod === 'signet') return null
  // No native Orbot/SOCKS route yet — OkHttp would go clearnet, leaking the IP
  // to the relay. Degrade to foreground-only (JS pipeline stays fail-closed)
  // rather than silently bypass Tor. Follow-up: route OkHttp via Orbot SOCKS.
  if (persisted.torRelay) return null
  const circle = persisted.circles.find((c) => c.id === persisted.activeCircleId)
  if (!circle) return null
  // Private posture never continuously beacons — the background publisher must
  // honour that exactly as the foreground autoEmit does (app.ts), or a killed
  // WebView would keep broadcasting a circle the user set to event-only. `sharing`
  // is global and switchCircle doesn't reset it, so this is reachable simply by
  // sharing in one circle then switching focus to a Private one.
  if (postureOf(circle) === 'private') return null
  return {
    v: 1,
    skHex,
    circleId: circle.id,
    seedHex: circle.seedHex,
    precision: basePrecision,
    festivalUntil: circle.festivalUntil ?? 0,
    relayUrls: persisted.relayUrls,
    noReportZones: persisted.noReportZones,
    offGridUntil: persisted.offGridUntil ?? 0,
    sessionMinIntervalSec: session?.minIntervalSec ?? 0,
    sessionHeartbeatSec: session?.heartbeatSec ?? 0,
    sessionUntilSec: session?.untilSec ?? 0,
  }
}

/** Sentinel meaning "last attempt failed — always retry on the next sync". */
const RETRY = Symbol('retry')
let lastSent: string | null | typeof RETRY = RETRY

/** Mirrors store.lockSaves() — once hiding starts, nothing may re-arm the
 *  native mirror. There is no unlock: module state only resets on reload. */
let publishLocked = false
export function lockNativePublish(): void { publishLocked = true }

/** Diffed sync — only crosses the bridge when the config actually changed. */
export async function syncNativePublishConfig(cfg: NativePublishConfig | null): Promise<void> {
  if (publishLocked) return
  const json = cfg === null ? null : JSON.stringify(cfg)
  if (json === lastSent) return
  lastSent = json
  try {
    if (json === null) await FlockPublish.clearConfig()
    else await FlockPublish.setConfig({ json })
  } catch { lastSent = RETRY /* plugin missing (old shell/web) — retry next sync */ }
}

/** Config-level teardown (stop-sharing, app-lock reopen) — clears config +
 *  cadence but preserves the journal, so a cold-start/app-lock boot that calls
 *  this before drainNativeJournal() ever runs doesn't destroy unsent beacons. */
export async function clearNativePublish(): Promise<void> {
  lastSent = null
  try { await FlockPublish.clearConfig() } catch { lastSent = RETRY /* clear didn't land — force the next sync to retry */ }
}

/** Full wipe (decoy hide / reset) — config, cadence AND journal all go, so a
 *  decoy or a reset device leaves nothing behind for a later drain to adopt. */
export async function wipeNativePublish(): Promise<void> {
  lastSent = null
  try { await FlockPublish.wipeAll() } catch { lastSent = RETRY /* wipe didn't land — force the next sync to retry */ }
}

export interface NativeJournalEntry {
  t: 'fix' | 'pub'
  at: number
  rx?: number
  c?: string
  g?: string
  p?: number
  rl?: number
}

export async function readNativeJournal(): Promise<NativeJournalEntry[]> {
  try {
    const { entries } = await FlockPublish.getJournal()
    return entries.flatMap((e) => {
      try { return [JSON.parse(e) as NativeJournalEntry] } catch { return [] }
    })
  } catch { return [] }
}

export async function ackNativeJournal(count: number): Promise<void> {
  try { await FlockPublish.ackJournal({ count }) } catch { /* plugin unavailable */ }
}
