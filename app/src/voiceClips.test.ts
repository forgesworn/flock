import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SPEAKABLE_DISTANCES_METRES, speakableDistanceMetres } from '@forgesworn/flock'
import { VOICE_CLIP_IDS, voiceClipSeq, clockClip } from './voiceClips'

const vocab = (): Record<string, string> => {
  const p = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/voice-clips.json')
  const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, string>
  delete raw._comment
  return raw
}

describe('voice clip vocabulary', () => {
  // The generator (scripts/gen-voice-clips.mjs) bakes exactly the vocab JSON;
  // playback references VOICE_CLIP_IDS — they must be the same set or a clip
  // silently 404s at runtime.
  it('the shipped ids exactly match the canonical vocabulary JSON', () => {
    expect([...VOICE_CLIP_IDS].sort()).toEqual(Object.keys(vocab()).sort())
  })

  it('every clip id referenced by the selector exists', () => {
    const known = new Set<string>(VOICE_CLIP_IDS)
    const events: Parameters<typeof voiceClipSeq>[0][] = [
      { kind: 'arrived' },
      { kind: 'mode', mode: 'vector' }, { kind: 'mode', mode: 'seek' }, { kind: 'mode', mode: 'homing' },
      { kind: 'compass-unreliable' },
      { kind: 'degraded', state: 'stale' }, { kind: 'degraded', state: 'coarse' },
      { kind: 'degraded', state: 'no-fix' }, { kind: 'degraded', state: 'unavailable' },
      { kind: 'milestone', milestoneMetres: 1000, relativeBearingDeg: -45 },
      { kind: 'milestone', milestoneMetres: 100, relativeBearingDeg: 0 },
      { kind: 'bearing-change', relativeBearingDeg: 90 },
      ...SPEAKABLE_DISTANCES_METRES.map((m) => ({ kind: 'periodic' as const, roundedMetres: m, relativeBearingDeg: 45 })),
    ]
    for (const ev of events) for (const id of voiceClipSeq(ev)) expect(known.has(id)).toBe(true)
  })

  it('every speakable range step resolves to a distance clip', () => {
    for (const m of SPEAKABLE_DISTANCES_METRES) {
      const seq = voiceClipSeq({ kind: 'periodic', roundedMetres: m, relativeBearingDeg: null })
      expect(seq, `no clip for ${m} m`).toHaveLength(1)
      expect(seq[0]).toMatch(/^dist-/)
    }
    // …and rounding always lands ON a step, so the periodic line never misses.
    expect(SPEAKABLE_DISTANCES_METRES).toContain(speakableDistanceMetres(337))
  })
})

describe('voiceClipSeq', () => {
  it('a milestone reads distance THEN clock direction, back to back', () => {
    expect(voiceClipSeq({ kind: 'milestone', milestoneMetres: 1000, relativeBearingDeg: -45 }))
      .toEqual(['dist-1km', 'clock-11'])
  })

  it("dead-ahead speaks the 12 o'clock clip after the distance", () => {
    expect(voiceClipSeq({ kind: 'milestone', milestoneMetres: 500, relativeBearingDeg: 0 }))
      .toEqual(['dist-500m', 'clock-12'])
  })

  it('with no heading (null bearing) a range line is distance-only', () => {
    expect(voiceClipSeq({ kind: 'milestone', milestoneMetres: 500, relativeBearingDeg: null }))
      .toEqual(['dist-500m'])
    expect(voiceClipSeq({ kind: 'periodic', roundedMetres: 250, relativeBearingDeg: null }))
      .toEqual(['dist-250m'])
  })

  it('the periodic line reads distance THEN clock direction', () => {
    expect(voiceClipSeq({ kind: 'periodic', roundedMetres: 300, relativeBearingDeg: 90 }))
      .toEqual(['dist-300m', 'clock-3'])
  })

  it('mode + arrival + degradation map to their single clips', () => {
    expect(voiceClipSeq({ kind: 'mode', mode: 'vector' })).toEqual(['mode-vector'])
    expect(voiceClipSeq({ kind: 'arrived' })).toEqual(['state-arrived'])
    expect(voiceClipSeq({ kind: 'degraded', state: 'stale' })).toEqual(['state-stale'])
  })

  it('clock clips follow the 30° hour sectors', () => {
    expect(clockClip(0)).toBe('clock-12')
    expect(clockClip(90)).toBe('clock-3')
    expect(clockClip(-90)).toBe('clock-9')
    expect(clockClip(180)).toBe('clock-6')
    expect(clockClip(-16)).toBe('clock-11')
    expect(clockClip(null)).toBeNull()
  })
})
