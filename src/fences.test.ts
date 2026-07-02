import { describe, it, expect } from 'vitest'
import { buildFencesSignal, decryptFences, isNewerFenceSet, FENCES_SIGNAL_TYPE, MAX_FENCES } from './fences.js'
import type { FenceSet } from './fences.js'
import type { Geofence } from './geofence.js'

const SEED = 'ab'.repeat(32)
const ALICE = 'a1'.repeat(32)
const BOB = 'b2'.repeat(32)
const circle: Geofence = { kind: 'circle', centre: { lat: 51.5074, lon: -0.1278 }, radiusMetres: 300 }
const polygon: Geofence = { kind: 'polygon', vertices: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 0 }] }
const set = (over: Partial<FenceSet> = {}): FenceSet => ({ fences: [circle], updatedAt: 1_000, by: ALICE, ...over })

describe('buildFencesSignal / decryptFences', () => {
  it('round-trips a fence set through the group envelope', async () => {
    const ev = await buildFencesSignal({ groupId: 'g1', seedHex: SEED, set: set({ fences: [circle, polygon] }) })
    expect(ev.kind).toBe(20_078)
    expect(ev.tags).toContainEqual(['t', FENCES_SIGNAL_TYPE])
    const out = await decryptFences(SEED, ev.content)
    expect(out).toEqual(set({ fences: [circle, polygon] }))
  })

  it('round-trips an EMPTY set (deleting the last safe place must sync too)', async () => {
    const ev = await buildFencesSignal({ groupId: 'g1', seedHex: SEED, set: set({ fences: [] }) })
    const out = await decryptFences(SEED, ev.content)
    expect(out.fences).toEqual([])
  })

  it('a different seed cannot decrypt it', async () => {
    const ev = await buildFencesSignal({ groupId: 'g1', seedHex: SEED, set: set() })
    await expect(decryptFences('cd'.repeat(32), ev.content)).rejects.toThrow()
  })

  it('rejects building with an invalid author or clock', async () => {
    await expect(buildFencesSignal({ groupId: 'g1', seedHex: SEED, set: set({ by: 'not-hex' }) })).rejects.toThrow(/by/)
    await expect(buildFencesSignal({ groupId: 'g1', seedHex: SEED, set: set({ updatedAt: Number.NaN }) })).rejects.toThrow(/updatedAt/)
  })

  it('rejects building with more than MAX_FENCES', async () => {
    const many = Array.from({ length: MAX_FENCES + 1 }, () => circle)
    await expect(buildFencesSignal({ groupId: 'g1', seedHex: SEED, set: set({ fences: many }) })).rejects.toThrow(/at most/)
  })

  it.each([
    ['unknown kind', { kind: 'square', centre: { lat: 0, lon: 0 }, radiusMetres: 10 }],
    ['non-positive radius', { kind: 'circle', centre: { lat: 0, lon: 0 }, radiusMetres: 0 }],
    ['out-of-range latitude', { kind: 'circle', centre: { lat: 91, lon: 0 }, radiusMetres: 10 }],
    ['too few vertices', { kind: 'polygon', vertices: [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }] }],
    ['malformed vertex', { kind: 'polygon', vertices: [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }, { lat: 2 }] }],
  ])('rejects a malformed fence on decrypt (%s) — a bad set must never replace a good one', async (_name, bad) => {
    const ev = await buildFencesSignal({ groupId: 'g1', seedHex: SEED, set: set() })
    // Simulate a malicious/buggy sender by bypassing build validation.
    const { deriveGroupKey, encryptEnvelope } = await import('canary-kit/sync')
    const content = await encryptEnvelope(deriveGroupKey(SEED), JSON.stringify({ fences: [bad], updatedAt: 1, by: ALICE }))
    await expect(decryptFences(SEED, content)).rejects.toThrow()
    void ev
  })
})

describe('isNewerFenceSet — latest-wins with a deterministic tie-break', () => {
  it('anything beats an empty slate', () => {
    expect(isNewerFenceSet({ updatedAt: 1, by: ALICE }, {})).toBe(true)
    expect(isNewerFenceSet({ updatedAt: 1, by: ALICE }, undefined)).toBe(true)
  })

  it('a newer clock wins; an older one loses', () => {
    expect(isNewerFenceSet({ updatedAt: 2, by: BOB }, { fencesUpdatedAt: 1, fencesBy: ALICE })).toBe(true)
    expect(isNewerFenceSet({ updatedAt: 1, by: ALICE }, { fencesUpdatedAt: 2, fencesBy: BOB })).toBe(false)
  })

  it('equal clocks: the lexicographically smaller author wins everywhere (convergence)', () => {
    expect(isNewerFenceSet({ updatedAt: 5, by: ALICE }, { fencesUpdatedAt: 5, fencesBy: BOB })).toBe(true)
    expect(isNewerFenceSet({ updatedAt: 5, by: BOB }, { fencesUpdatedAt: 5, fencesBy: ALICE })).toBe(false)
  })

  it('an exact echo (same clock, same author) is not newer — replay is a no-op', () => {
    expect(isNewerFenceSet({ updatedAt: 5, by: ALICE }, { fencesUpdatedAt: 5, fencesBy: ALICE })).toBe(false)
  })
})
