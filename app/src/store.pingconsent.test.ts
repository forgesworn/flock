import { describe, it, expect } from 'vitest'
import { withPingConsentDefault } from './store'
import type { Circle } from './store'

const circle = (id: string, extra: Partial<Circle> = {}): Circle =>
  ({ id, seedHex: 'ab'.repeat(32), name: id, mode: 'family', ...extra })

// "Let my circle find my phone" is on by default now, but existing circles
// (from before this default existed) must actually pick it up too — not just
// circles created from here on.
describe('withPingConsentDefault', () => {
  it('turns pingConsent on for a circle that never set it', () => {
    const out = withPingConsentDefault([circle('a')])
    expect(out[0].pingConsent).toBe(true)
  })

  it('never overwrites an explicit choice, including a deliberate opt-out', () => {
    expect(withPingConsentDefault([circle('a', { pingConsent: false })])[0].pingConsent).toBe(false)
    expect(withPingConsentDefault([circle('a', { pingConsent: true })])[0].pingConsent).toBe(true)
  })

  it('leaves everything else about the circle untouched', () => {
    const out = withPingConsentDefault([circle('a', { members: ['x'] })])
    expect(out[0].members).toEqual(['x'])
  })
})
