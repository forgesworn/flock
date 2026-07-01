import { describe, it, expect } from 'vitest'
import { formatCountdown } from './countdown.js'

// The live rendezvous countdown. Pure — it can't read the clock; the caller passes
// the remaining seconds each tick, so the same input always renders the same text.
describe('formatCountdown', () => {
  it('shows M:SS below an hour', () => {
    expect(formatCountdown(90)).toBe('1:30')
    expect(formatCountdown(59)).toBe('0:59')
    expect(formatCountdown(600)).toBe('10:00')
  })

  it('shows H:MM:SS from an hour up, zero-padding minutes and seconds', () => {
    expect(formatCountdown(3600)).toBe('1:00:00')
    expect(formatCountdown(3661)).toBe('1:01:01')
    expect(formatCountdown(7325)).toBe('2:02:05')
  })

  it('clamps at zero — a passed deadline never shows negative time', () => {
    expect(formatCountdown(0)).toBe('0:00')
    expect(formatCountdown(-5)).toBe('0:00')
    expect(formatCountdown(-3600)).toBe('0:00')
  })

  it('floors fractional seconds, so it ticks down cleanly (no rounding a second early)', () => {
    expect(formatCountdown(90.9)).toBe('1:30')
    expect(formatCountdown(59.999)).toBe('0:59')
  })
})
