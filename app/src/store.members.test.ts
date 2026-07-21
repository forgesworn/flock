import { describe, it, expect } from 'vitest'
import { withNewMember, JOIN_GRACE_SEC, type Circle } from './store'

const NOW = 1_760_000_000
const circle = (over: Partial<Circle> = {}): Circle => ({
  id: 'c1',
  seedHex: '11'.repeat(32),
  name: 'The Smiths',
  mode: 'family',
  members: ['aa'.repeat(32)],
  ...over,
})

describe('withNewMember — the "new phone joined" notice (audit Slice 7)', () => {
  it('a genuinely new pubkey joins the roster AND the unseen list', () => {
    const pk = 'bb'.repeat(32)
    const patch = withNewMember(circle(), pk, NOW)
    expect(patch?.members).toEqual(['aa'.repeat(32), pk])
    expect(patch?.unseenMembers).toEqual([pk])
  })

  it('an already-known pubkey is a no-op — a reseed re-add or signal echo must not re-fire', () => {
    expect(withNewMember(circle(), 'aa'.repeat(32), NOW)).toBeNull()
  })

  it('an expected addition (self, or an invite this user sent) is silent', () => {
    const pk = 'bb'.repeat(32)
    const patch = withNewMember(circle(), pk, NOW, { expected: true })
    expect(patch?.members).toContain(pk)
    expect(patch?.unseenMembers).toBeUndefined()
  })

  it('the existing roster replaying just after WE joined is not news (join grace)', () => {
    const inGrace = withNewMember(circle({ joinedAt: NOW - 5 }), 'bb'.repeat(32), NOW)
    expect(inGrace?.members).toContain('bb'.repeat(32))
    expect(inGrace?.unseenMembers).toBeUndefined()

    const afterGrace = withNewMember(circle({ joinedAt: NOW - JOIN_GRACE_SEC - 1 }), 'bb'.repeat(32), NOW)
    expect(afterGrace?.unseenMembers).toEqual(['bb'.repeat(32)])
  })

  it('unseen additions accumulate until acknowledged', () => {
    const pk = 'cc'.repeat(32)
    const patch = withNewMember(circle({ unseenMembers: ['bb'.repeat(32)] }), pk, NOW)
    expect(patch?.unseenMembers).toEqual(['bb'.repeat(32), pk])
  })

  it('an evicted member is NOT silently re-added — the removal tombstone holds', () => {
    const evicted = 'ee'.repeat(32)
    // Even an "expected" add (e.g. a rotated seed reaching them via a stale-roster
    // refresh elsewhere) must be refused while the pubkey is tombstoned.
    expect(withNewMember(circle({ removed: [evicted] }), evicted, NOW)).toBeNull()
    expect(withNewMember(circle({ removed: [evicted] }), evicted, NOW, { expected: true })).toBeNull()
    // A different, non-evicted pubkey still joins normally.
    expect(withNewMember(circle({ removed: [evicted] }), 'bb'.repeat(32), NOW)?.members)
      .toEqual(['aa'.repeat(32), 'bb'.repeat(32)])
  })
})
