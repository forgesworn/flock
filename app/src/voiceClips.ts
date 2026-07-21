// Radar voice — pre-baked clip vocabulary + selection (radar-v2 voice channel).
//
// The voice lines are a small, ENUMERABLE vocabulary, so we bake them ONCE with
// a good TTS voice (scripts/gen-voice-clips.mjs → app/public/voice/<id>.mp3) and
// ship them in the app. Playback is then fully on-device: zero network, works
// on a locked phone, in a field, on GrapheneOS — the blindfold/pocket-walk
// acceptance tests. On-device speechSynthesis / Android TextToSpeech is the
// graceful fallback if a clip is ever missing (see radarMode.ts / RadarGuideService).
//
// This module is pure presentation: it maps a voice EVENT to a sequence of clip
// ids, reusing the pinned pure-core copy functions (clockHour) so a spoken line
// is exactly "<distance> <clock direction>", back to back. v2.1 (field test
// 2026-07-21): directions are clock-face ("at your 3 o'clock"), and the range
// ladder covers every speakableDistanceMetres step so the minute-cadence line
// is always clip-composable.

import { clockHour, SPEAKABLE_DISTANCES_METRES, type RadarMode, type RadarState } from '@forgesworn/flock'

/** Speakable range (metres) → its clip id. Every SPEAKABLE_DISTANCES_METRES
 *  step has one (asserted by voiceClips.test.ts). */
const DIST_CLIP: Record<number, string> = {
  10: 'dist-10m', 15: 'dist-15m', 20: 'dist-20m', 25: 'dist-25m', 30: 'dist-30m',
  40: 'dist-40m', 50: 'dist-50m', 75: 'dist-75m', 100: 'dist-100m', 150: 'dist-150m',
  200: 'dist-200m', 250: 'dist-250m', 300: 'dist-300m', 400: 'dist-400m', 500: 'dist-500m',
  750: 'dist-750m', 1000: 'dist-1km', 1500: 'dist-1-5km', 2000: 'dist-2km',
  3000: 'dist-3km', 4000: 'dist-4km', 5000: 'dist-5km', 10_000: 'dist-10km',
}

/** Every clip id we ship (must equal the keys of scripts/voice-clips.json —
 *  enforced by voiceClips.test.ts). */
export const VOICE_CLIP_IDS = [
  ...Array.from({ length: 12 }, (_, i) => `clock-${i + 1}`),
  ...SPEAKABLE_DISTANCES_METRES.map((m) => DIST_CLIP[m]),
  'state-arrived', 'mode-vector', 'mode-seek', 'mode-homing', 'state-compass-unreliable',
  'state-stale', 'state-coarse', 'state-no-fix', 'state-unavailable',
] as const

/** A relative bearing → its clock-face clip id, or null (no honest bearing). */
export function clockClip(relativeBearingDeg: number | null): string | null {
  const h = clockHour(relativeBearingDeg)
  return h === null ? null : `clock-${h}`
}

/** The events the voice channel announces. Distances are the ROUND milestone /
 *  speakable value just crossed or measured, so the clip is one of the
 *  enumerable set. */
export type VoiceClipEvent =
  | { kind: 'arrived' }
  | { kind: 'mode'; mode: RadarMode }
  | { kind: 'compass-unreliable' }
  | { kind: 'degraded'; state: RadarState }
  | { kind: 'milestone'; milestoneMetres: number; relativeBearingDeg: number | null }
  | { kind: 'bearing-change'; relativeBearingDeg: number | null }
  /** The minute-cadence range + clock line (v2.1). `relativeBearingDeg` is
   *  pre-gated by the caller: null whenever the bearing isn't honestly usable. */
  | { kind: 'periodic'; roundedMetres: number; relativeBearingDeg: number | null }

/** "<range clip>, <clock clip>" — the clock rides only an honest bearing. */
function rangeSeq(metres: number, relativeBearingDeg: number | null): string[] {
  const dist = DIST_CLIP[metres]
  const dir = clockClip(relativeBearingDeg)
  return [dist, ...(dir ? [dir] : [])].filter(Boolean)
}

/** Event → the clip ids to play back to back (empty when nothing to say). */
export function voiceClipSeq(ev: VoiceClipEvent): string[] {
  switch (ev.kind) {
    case 'arrived':
      return ['state-arrived']
    case 'mode':
      return [`mode-${ev.mode}`]
    case 'compass-unreliable':
      return ['state-compass-unreliable']
    case 'degraded':
      return ev.state === 'stale' || ev.state === 'coarse' || ev.state === 'no-fix' || ev.state === 'unavailable'
        ? [`state-${ev.state}`]
        : []
    case 'milestone':
      return rangeSeq(ev.milestoneMetres, ev.relativeBearingDeg)
    case 'periodic':
      return rangeSeq(ev.roundedMetres, ev.relativeBearingDeg)
    case 'bearing-change': {
      const dir = clockClip(ev.relativeBearingDeg)
      return dir ? [dir] : []
    }
  }
}
