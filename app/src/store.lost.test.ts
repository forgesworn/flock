import { describe, it, expect } from 'vitest'
import { pruneLostByCircle } from './store'
import type { LostReport } from '@forgesworn/flock'

const report = (member: string, lost: boolean, timestamp: number): LostReport =>
  ({ member, by: 'reporter', lost, timestamp })

// Lost-phone flags are persisted so the standing state — and the newest-wins guard
// that rejects a replayed old report — survive a relaunch. Pruning keeps that cache
// honest: scoped to circles you still hold, and NEVER age-pruned (a lost flag stands
// until a "found" clears it, however long that takes).
describe('pruneLostByCircle', () => {
  it('keeps flags for a circle that still exists', () => {
    const out = pruneLostByCircle({ c1: [report('a', true, 100)] }, ['c1'])
    expect(out).toEqual({ c1: [report('a', true, 100)] })
  })

  it('drops flags for a circle that no longer exists (left / disbanded / reseeded)', () => {
    const out = pruneLostByCircle({ gone: [report('a', true, 100)] }, ['c1'])
    expect(out).toEqual({})
  })

  it('never age-prunes — an ancient uncleared "lost" is standing state, not noise', () => {
    const out = pruneLostByCircle({ c1: [report('a', true, 1)] }, ['c1'])
    expect(out.c1).toHaveLength(1)
  })

  it('drops an empty circle entry', () => {
    const out = pruneLostByCircle({ c1: [] }, ['c1'])
    expect(out).toEqual({})
  })

  it('is pure — does not mutate its input', () => {
    const input = { c1: [report('a', true, 100)] }
    const snapshot = JSON.parse(JSON.stringify(input))
    pruneLostByCircle(input, ['c1'])
    expect(input).toEqual(snapshot)
  })
})
