// Locked-phone radar guide bridge (Capacitor shell).
//
// Starts/stops the RadarGuideService — the location-typed foreground service
// that keeps radar's by-ear guidance (beeps + haptics + GPS + compass) alive
// while the screen is locked and the WebView sleeps. app/src/radarMode.ts owns
// the policy (when to start, target updates, honest teardown); this module is
// a thin bridge that no-ops on web and older shells.

import { registerPlugin } from '@capacitor/core'

export interface RadarGuideTarget {
  lat: number
  lon: number
  uncertaintyMetres: number
  /** Unix milliseconds of the disclosure — ages on the native clock. */
  timestampMs: number
}

interface RadarGuidePluginApi {
  start(opts: Partial<RadarGuideTarget> & { muted?: boolean }): Promise<void>
  updateTarget(target: RadarGuideTarget): Promise<void>
  setMuted(opts: { muted: boolean }): Promise<void>
  stop(): Promise<void>
  isActive(): Promise<{ value: boolean }>
}

const RadarGuide = registerPlugin<RadarGuidePluginApi>('RadarGuide')

/** Start native guidance (from an unlocked, foregrounded radar open). */
export function startRadarGuide(target: RadarGuideTarget | null, muted: boolean): Promise<void> {
  return RadarGuide.start({ ...(target ?? {}), muted }).catch(() => { /* old shell — foreground-only radar */ })
}

/** Push the selected person's fresh permitted disclosure to the native guide. */
export function updateRadarTarget(target: RadarGuideTarget): Promise<void> {
  return RadarGuide.updateTarget(target).catch(() => { /* not running */ })
}

/** Mute/unmute the native audio (haptics continue either way). */
export function setRadarGuideMuted(muted: boolean): Promise<void> {
  return RadarGuide.setMuted({ muted }).catch(() => { /* not running */ })
}

/** Stop and silence the native guide immediately. */
export function stopRadarGuide(): Promise<void> {
  return RadarGuide.stop().catch(() => { /* already gone */ })
}

/** Is the native guide still running? (Its notification has its own Stop.) */
export async function isRadarGuideActive(): Promise<boolean> {
  try { return (await RadarGuide.isActive()).value } catch { return false }
}
