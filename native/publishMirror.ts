// JS side of the native background publish pipeline: mirrors the MINIMUM
// config (identity sk, active circle seed + precision, relays, no-report
// zones, off-grid) into the Keystore-backed native store, and reads back the
// publish journal on resume. Design: docs/plans/
// 2026-07-05-native-background-publish-design.md. The mirror must be cleared
// on lock engage, decoy hide, reset and stop-sharing — app.ts owns calling us.

import { registerPlugin } from '@capacitor/core'
import type { Persisted } from '../app/src/store'
import type { NoReportZone } from '@forgesworn/flock'

interface FlockPublishPlugin {
  setConfig(options: { json: string }): Promise<void>
  clearConfig(): Promise<void>
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
}

/** Pure: the config to mirror, or null when background publish must be off
 *  (not sharing, no local key — Signet, no circle). Null clears the mirror. */
export function buildNativePublishConfig(
  persisted: Persisted,
  sharing: boolean,
  basePrecision: number,
): NativePublishConfig | null {
  if (!sharing) return null
  const skHex = persisted.identity?.skHex
  if (!skHex || persisted.authMethod === 'signet') return null
  const circle = persisted.circles.find((c) => c.id === persisted.activeCircleId)
  if (!circle) return null
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
  }
}

/** Sentinel meaning "last attempt failed — always retry on the next sync". */
const RETRY = Symbol('retry')
let lastSent: string | null | typeof RETRY = RETRY

/** Diffed sync — only crosses the bridge when the config actually changed. */
export async function syncNativePublishConfig(cfg: NativePublishConfig | null): Promise<void> {
  const json = cfg === null ? null : JSON.stringify(cfg)
  if (json === lastSent) return
  lastSent = json
  try {
    if (json === null) await FlockPublish.clearConfig()
    else await FlockPublish.setConfig({ json })
  } catch { lastSent = RETRY /* plugin missing (old shell/web) — retry next sync */ }
}

/** Unconditional teardown (hide / reset / lock) — never leaves seeds behind. */
export async function clearNativePublish(): Promise<void> {
  lastSent = null
  try { await FlockPublish.clearConfig() } catch { /* plugin unavailable */ }
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
