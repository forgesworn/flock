import { describe, it, expect } from 'vitest'
import { postureOf } from './store'

// postureOf is the single source of the location-posture default. Every path that
// decides "does this circle beacon continuously?" — the foreground autoEmit, the
// native background publisher, the Home share bar, the Circle settings chips —
// reads through it, so the default must be pinned here: a pre-feature circle with
// no stored choice has to stay 'always' (continuous), or old circles would go
// silently dark on upgrade.
describe('postureOf', () => {
  it("defaults to 'always' when unset — back-compat with pre-feature circles", () => {
    expect(postureOf({ trackingDefault: undefined })).toBe('always')
    expect(postureOf({})).toBe('always')
  })

  it('reads an explicit choice through unchanged', () => {
    expect(postureOf({ trackingDefault: 'private' })).toBe('private')
    expect(postureOf({ trackingDefault: 'always' })).toBe('always')
  })

  it('is null/undefined-safe — no circle in focus falls back to the same default', () => {
    expect(postureOf(null)).toBe('always')
    expect(postureOf(undefined)).toBe('always')
  })
})
