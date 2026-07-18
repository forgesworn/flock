import { describe, it, expect } from 'vitest'
import { rotationDue, refreshDue, ROTATION_PERIOD_SEC, ROTATION_STAGGER_SEC, ROTATION_REFRESH_SEC } from '@forgesworn/roost-kit'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)

const T0 = 1_700_000_000

describe('rotationDue', () => {
  const circle = { reseededAt: T0, members: [B, A, C] } // unsorted on purpose

  it('is not due before the period elapses', () => {
    expect(rotationDue(circle, A, T0 + ROTATION_PERIOD_SEC - 1)).toBe(false)
  })

  it('falls due for the first-ranked member exactly at the period', () => {
    expect(rotationDue(circle, A, T0 + ROTATION_PERIOD_SEC)).toBe(true)
  })

  it('staggers later-ranked members by a day each', () => {
    const due = T0 + ROTATION_PERIOD_SEC
    expect(rotationDue(circle, B, due)).toBe(false)
    expect(rotationDue(circle, B, due + ROTATION_STAGGER_SEC)).toBe(true)
    expect(rotationDue(circle, C, due + ROTATION_STAGGER_SEC)).toBe(false)
    expect(rotationDue(circle, C, due + 2 * ROTATION_STAGGER_SEC)).toBe(true)
  })

  it('ranks a member missing from its own roster copy last', () => {
    const partial = { reseededAt: T0, members: [A, B] } // C not in its own copy
    const due = T0 + ROTATION_PERIOD_SEC
    expect(rotationDue(partial, C, due + ROTATION_STAGGER_SEC)).toBe(false)
    expect(rotationDue(partial, C, due + 2 * ROTATION_STAGGER_SEC)).toBe(true)
  })

  it('a solo circle rotates at the period (rank 0)', () => {
    expect(rotationDue({ reseededAt: T0, members: [A] }, A, T0 + ROTATION_PERIOD_SEC)).toBe(true)
  })

  it('never rotates a transient circle', () => {
    const transient = { reseededAt: T0, expiresAt: T0 + 999_999_999, members: [A] }
    expect(rotationDue(transient, A, T0 + 10 * ROTATION_PERIOD_SEC)).toBe(false)
  })

  it('never rotates a circle of unknown seed age', () => {
    expect(rotationDue({ members: [A] }, A, T0 + 10 * ROTATION_PERIOD_SEC)).toBe(false)
  })
})

describe('refreshDue', () => {
  const circle = { reseededAt: T0, members: [B, A] }

  it('only the first-ranked member refreshes', () => {
    const t = T0 + ROTATION_REFRESH_SEC
    expect(refreshDue(circle, A, undefined, t)).toBe(true)
    expect(refreshDue(circle, B, undefined, t)).toBe(false)
  })

  it('is not due within a week of the seed being set', () => {
    expect(refreshDue(circle, A, undefined, T0 + ROTATION_REFRESH_SEC - 1)).toBe(false)
  })

  it('throttles on the last refresh time', () => {
    const last = T0 + ROTATION_REFRESH_SEC
    expect(refreshDue(circle, A, last, last + ROTATION_REFRESH_SEC - 1)).toBe(false)
    expect(refreshDue(circle, A, last, last + ROTATION_REFRESH_SEC)).toBe(true)
  })

  it('a stale lastRefresh from before the rotation clamps to reseededAt', () => {
    const rotated = { reseededAt: T0 + ROTATION_PERIOD_SEC, members: [A] }
    const staleRefresh = T0 // refreshed before the rotation happened
    expect(refreshDue(rotated, A, staleRefresh, T0 + ROTATION_PERIOD_SEC + ROTATION_REFRESH_SEC - 1)).toBe(false)
    expect(refreshDue(rotated, A, staleRefresh, T0 + ROTATION_PERIOD_SEC + ROTATION_REFRESH_SEC)).toBe(true)
  })

  it('never refreshes transient or unknown-age circles', () => {
    expect(refreshDue({ reseededAt: T0, expiresAt: T0 + 9_999_999, members: [A] }, A, undefined, T0 + ROTATION_REFRESH_SEC)).toBe(false)
    expect(refreshDue({ members: [A] }, A, undefined, T0 + ROTATION_REFRESH_SEC)).toBe(false)
  })
})
