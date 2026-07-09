import { describe, it, expect } from 'vitest'
import { memberHue, nameInitials } from './avatar'

describe('memberHue', () => {
  it('is stable for a pubkey and in hue range', () => {
    const pk = 'a3f1c2d4'.padEnd(64, '0')
    const h = memberHue(pk)
    expect(h).toBe(memberHue(pk))
    expect(h).toBeGreaterThanOrEqual(0)
    expect(h).toBeLessThan(360)
  })

  it('differs for different pubkeys (the point: tellable apart)', () => {
    const a = memberHue('00000001'.padEnd(64, '0'))
    const b = memberHue('80000000'.padEnd(64, '0'))
    expect(a).not.toBe(b)
  })

  it('survives a malformed key with a sane default', () => {
    expect(memberHue('zzzz')).toBe(210)
  })
})

describe('nameInitials', () => {
  it('takes first letters of the first two words', () => {
    expect(nameInitials('Amy Winter', 'A3')).toBe('AW')
  })

  it('takes the first two characters of a single word', () => {
    expect(nameInitials('Rover', 'A3')).toBe('RO')
  })

  it('upper-cases and trims', () => {
    expect(nameInitials('  jo  bloggs ', 'A3')).toBe('JB')
  })

  // SAFETY: unnamed members must stay tellable apart — the fallback is per-
  // member (pubkey pair), never initials of a shared placeholder label.
  it('falls back to the per-member fallback when no real name is known', () => {
    expect(nameInitials('', 'A3')).toBe('A3')
    expect(nameInitials('   ', '7F')).toBe('7F')
  })
})
