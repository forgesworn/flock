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
// ids, reusing the pinned pure-core copy functions (vectorDirectionPhrase) so a
// milestone line is exactly "<distance> <direction>", back to back.

import { vectorDirectionPhrase, type RadarMode, type RadarState } from '@forgesworn/flock'

/** Every clip id we ship (must equal the keys of scripts/voice-clips.json —
 *  enforced by voiceClips.test.ts). */
export const VOICE_CLIP_IDS = [
  'dir-straight-ahead', 'dir-ahead-left', 'dir-ahead-right', 'dir-left', 'dir-right',
  'dir-behind-left', 'dir-behind-right', 'dir-behind',
  'dist-2km', 'dist-1km', 'dist-500m', 'dist-250m', 'dist-100m',
  'state-arrived', 'mode-vector', 'mode-seek', 'mode-homing', 'state-compass-unreliable',
  'state-stale', 'state-coarse', 'state-no-fix', 'state-unavailable',
] as const

/** `vectorDirectionPhrase` output → the matching direction clip (null = the
 *  bare "ahead" fallback, which gets no clip). */
const DIRECTION_CLIP: Record<string, string> = {
  'straight ahead': 'dir-straight-ahead',
  'ahead on your left': 'dir-ahead-left',
  'ahead on your right': 'dir-ahead-right',
  'to your left': 'dir-left',
  'to your right': 'dir-right',
  'behind you on your left': 'dir-behind-left',
  'behind you on your right': 'dir-behind-right',
  'behind you': 'dir-behind',
}

/** Milestone metres (RADAR.voiceMilestonesMetres) → distance clip. */
const MILESTONE_CLIP: Record<number, string> = {
  2000: 'dist-2km', 1000: 'dist-1km', 500: 'dist-500m', 250: 'dist-250m', 100: 'dist-100m',
}

/** A relative bearing → its direction clip id, or null (dead ahead fallback). */
export function directionClip(relativeBearingDeg: number | null): string | null {
  return DIRECTION_CLIP[vectorDirectionPhrase(relativeBearingDeg)] ?? null
}

/** The events the voice channel announces. Distances are the ROUND milestone
 *  value just crossed, so the clip is one of the enumerable set. */
export type VoiceClipEvent =
  | { kind: 'arrived' }
  | { kind: 'mode'; mode: RadarMode }
  | { kind: 'compass-unreliable' }
  | { kind: 'degraded'; state: RadarState }
  | { kind: 'milestone'; milestoneMetres: number; relativeBearingDeg: number | null }
  | { kind: 'bearing-change'; relativeBearingDeg: number | null }

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
    case 'milestone': {
      const dist = MILESTONE_CLIP[ev.milestoneMetres]
      const dir = directionClip(ev.relativeBearingDeg)
      return [dist, ...(dir ? [dir] : [])].filter(Boolean)
    }
    case 'bearing-change': {
      const dir = directionClip(ev.relativeBearingDeg)
      return dir ? [dir] : []
    }
  }
}
