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
  /** A stationary waypoint (dropped pin): the native guide re-stamps its own age
   *  from the live GPS clock so it never decays to the "stale" cue while locked. */
  evergreen?: boolean
}

interface RadarGuidePluginApi {
  start(opts: Partial<RadarGuideTarget> & { muted?: boolean; voice?: boolean }): Promise<void>
  updateTarget(target: RadarGuideTarget): Promise<void>
  setMuted(opts: { muted: boolean }): Promise<void>
  setVoice(opts: { voice: boolean }): Promise<void>
  stop(): Promise<void>
  isActive(): Promise<{ value: boolean }>
  getMode(): Promise<{ value: string }>
  addListener(
    eventName: 'heading',
    cb: (data: { headingDeg: number; usable: boolean }) => void,
  ): Promise<{ remove: () => Promise<void> }>
}

const RadarGuide = registerPlugin<RadarGuidePluginApi>('RadarGuide')

/** Start native guidance (from an unlocked, foregrounded radar open). */
export function startRadarGuide(target: RadarGuideTarget | null, muted: boolean, voice: boolean): Promise<void> {
  return RadarGuide.start({ ...(target ?? {}), muted, voice }).catch(() => { /* old shell — foreground-only radar */ })
}

/** Push the selected person's fresh permitted disclosure to the native guide. */
export function updateRadarTarget(target: RadarGuideTarget): Promise<void> {
  return RadarGuide.updateTarget(target).catch(() => { /* not running */ })
}

/** Mute/unmute the native audio (haptics continue either way). */
export function setRadarGuideMuted(muted: boolean): Promise<void> {
  return RadarGuide.setMuted({ muted }).catch(() => { /* not running */ })
}

/** Turn the native voice (TTS) channel on/off, mirroring the in-app toggle. */
export function setRadarGuideVoice(voice: boolean): Promise<void> {
  return RadarGuide.setVoice({ voice }).catch(() => { /* not running / old shell */ })
}

/** Stop and silence the native guide immediately. */
export function stopRadarGuide(): Promise<void> {
  return RadarGuide.stop().catch(() => { /* already gone */ })
}

/** Is the native guide still running? (Its notification has its own Stop.) */
export async function isRadarGuideActive(): Promise<boolean> {
  try { return (await RadarGuide.isActive()).value } catch { return false }
}

/** The native guide's currently-resolved mode (vector | seek | homing), or ''
 *  when unavailable — lets the reopened JS scope reflect the locked-run mode. */
export async function radarGuideMode(): Promise<string> {
  try { return (await RadarGuide.getMode()).value } catch { return '' }
}

/** Subscribe to the native rotation-vector compass (mirrored from the guide
 *  service, throttled): the on-screen scope's heading source in the shell,
 *  where the WebView's deviceorientation is not earth-referenced. Returns an
 *  unsubscribe fn; a shell without the event just never fires it. */
export function onRadarHeading(cb: (headingDeg: number, usable: boolean) => void): () => void {
  let removed = false
  let handle: { remove: () => Promise<void> } | null = null
  RadarGuide.addListener('heading', (d) => cb(d.headingDeg, d.usable))
    .then((h) => { if (removed) void h.remove().catch(() => { /* gone */ }); else handle = h })
    .catch(() => { /* old shell — no native compass mirror */ })
  return () => {
    removed = true
    void handle?.remove().catch(() => { /* already removed */ })
  }
}
