import { describe, it, expect } from 'vitest'
import { deriveCircleSeed } from './keys'

const ROOT = '11'.repeat(32)
const ROOT2 = '22'.repeat(32)

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
