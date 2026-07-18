import { describe, it, expect } from 'vitest'
import { deriveCircleSeed, personalInboxTag } from '@forgesworn/covey-kit'

const ROOT = '11'.repeat(32)
const ROOT2 = '22'.repeat(32)
const PK_A = 'a'.repeat(64)
const PK_B = 'b'.repeat(64)

describe('deriveCircleSeed (nsec-tree)', () => {
  it('is deterministic for the same root/circle/epoch', () => {
    expect(deriveCircleSeed(ROOT, 'circle-1', 0)).toBe(deriveCircleSeed(ROOT, 'circle-1', 0))
  })

  it('produces a 64-char lowercase hex seed', () => {
    expect(deriveCircleSeed(ROOT, 'circle-1', 0)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rotates on an epoch bump (reseed)', () => {
    expect(deriveCircleSeed(ROOT, 'circle-1', 0)).not.toBe(deriveCircleSeed(ROOT, 'circle-1', 1))
  })

  it('differs per circle', () => {
    expect(deriveCircleSeed(ROOT, 'circle-1', 0)).not.toBe(deriveCircleSeed(ROOT, 'circle-2', 0))
  })

  it('differs per root — circles are unlinkable across roots', () => {
    expect(deriveCircleSeed(ROOT, 'c', 0)).not.toBe(deriveCircleSeed(ROOT2, 'c', 0))
  })
})

describe('personalInboxTag (invite/reseed routing tag — hides the real npub from the relay)', () => {
  it('produces a 64-char lowercase hex tag', () => {
    expect(personalInboxTag(PK_A)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic — a sender can recompute it from the recipient npub', () => {
    expect(personalInboxTag(PK_A)).toBe(personalInboxTag(PK_A))
  })

  it('is NOT the pubkey itself — the real key never lands on the #p tag', () => {
    expect(personalInboxTag(PK_A)).not.toBe(PK_A)
  })

  it('differs per pubkey', () => {
    expect(personalInboxTag(PK_A)).not.toBe(personalInboxTag(PK_B))
  })

  it('is case-insensitive on the input pubkey', () => {
    expect(personalInboxTag(PK_A.toUpperCase())).toBe(personalInboxTag(PK_A))
  })
})
