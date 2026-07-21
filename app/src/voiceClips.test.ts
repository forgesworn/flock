import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VOICE_CLIP_IDS, voiceClipSeq, directionClip } from './voiceClips'

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
    ]
    for (const ev of events) for (const id of voiceClipSeq(ev)) expect(known.has(id)).toBe(true)
  })
})

describe('voiceClipSeq', () => {
  it('a milestone reads distance THEN direction, back to back', () => {
    expect(voiceClipSeq({ kind: 'milestone', milestoneMetres: 1000, relativeBearingDeg: -45 }))
      .toEqual(['dist-1km', 'dir-ahead-left'])
  })

  it('dead-ahead still speaks the "straight ahead" clip after the distance', () => {
    expect(voiceClipSeq({ kind: 'milestone', milestoneMetres: 500, relativeBearingDeg: 0 }))
      .toEqual(['dist-500m', 'dir-straight-ahead'])
  })

  it('with no heading (null bearing) a milestone drops the bare "ahead" clip', () => {
    expect(voiceClipSeq({ kind: 'milestone', milestoneMetres: 500, relativeBearingDeg: null }))
      .toEqual(['dist-500m'])
  })

  it('mode + arrival + degradation map to their single clips', () => {
    expect(voiceClipSeq({ kind: 'mode', mode: 'vector' })).toEqual(['mode-vector'])
    expect(voiceClipSeq({ kind: 'arrived' })).toEqual(['state-arrived'])
    expect(voiceClipSeq({ kind: 'degraded', state: 'stale' })).toEqual(['state-stale'])
  })

  it('direction clips follow the same left/right thresholds as the phrasing', () => {
    expect(directionClip(0)).toBe('dir-straight-ahead')
    expect(directionClip(90)).toBe('dir-right')
    expect(directionClip(-45)).toBe('dir-ahead-left')
    expect(directionClip(175)).toBe('dir-behind')
    expect(directionClip(null)).toBeNull()
  })
})
