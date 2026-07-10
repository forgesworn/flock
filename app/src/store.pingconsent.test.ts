import { describe, it, expect } from 'vitest'
import { withPingConsentDefault } from './store'
import type { Circle } from './store'

const circle = (id: string, extra: Partial<Circle> = {}): Circle =>
  ({ id, seedHex: 'ab'.repeat(32), name: id, mode: 'family', ...extra })

// A remote exact-location request is standing consent, so missing legacy state
// must migrate to OFF. Existing explicit choices remain authoritative.
describe('withPingConsentDefault', () => {
  it('turns pingConsent off for a circle that never set it', () => {
    const out = withPingConsentDefault([circle('a')])
    expect(out[0].pingConsent).toBe(false)
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
