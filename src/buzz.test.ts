import { describe, it, expect } from 'vitest'
import {
  buildBuzzSignal,
  decryptBuzz,
  BUZZ_SIGNAL_TYPE,
  DEFAULT_BUZZ_REASONS,
  type Buzz,
} from './buzz.js'

const SEED = '0000000000000000000000000000000000000000000000000000000000000001'
const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

describe('DEFAULT_BUZZ_REASONS', () => {
  it('provides some presets', () => {
    expect(DEFAULT_BUZZ_REASONS.length).toBeGreaterThan(0)
    expect(DEFAULT_BUZZ_REASONS).toContain('Come home')
  })
})

describe('buildBuzzSignal / decryptBuzz', () => {
  it('round-trips a broadcast buzz', async () => {
    const event = await buildBuzzSignal({ groupId: 'g', seedHex: SEED, from: A, reason: 'Come home', timestamp: 42 })
    expect(event.kind).toBe(20_078)
    expect(event.tags.find((t) => t[0] === 't')?.[1]).toBe(BUZZ_SIGNAL_TYPE)

    const back = await decryptBuzz(SEED, event.content)
    expect(back).toEqual<Buzz>({ from: A, reason: 'Come home', timestamp: 42 })
  })

  it('round-trips a targeted buzz (parent → child)', async () => {
    const event = await buildBuzzSignal({ groupId: 'g', seedHex: SEED, from: A, reason: 'Dinner', target: B, timestamp: 7 })
    const back = await decryptBuzz(SEED, event.content)
    expect(back.target).toBe(B)
    expect(back.from).toBe(A)
    expect(back.reason).toBe('Dinner')
  })

  it('trims the reason', async () => {
    const event = await buildBuzzSignal({ groupId: 'g', seedHex: SEED, from: A, reason: '  Call me  ' })
    expect((await decryptBuzz(SEED, event.content)).reason).toBe('Call me')
  })

  it('a wrong seed cannot decrypt', async () => {
    const event = await buildBuzzSignal({ groupId: 'g', seedHex: SEED, from: A, reason: 'Come home' })
    await expect(decryptBuzz('f'.repeat(64), event.content)).rejects.toThrow()
  })

  it('rejects an empty reason', async () => {
    await expect(buildBuzzSignal({ groupId: 'g', seedHex: SEED, from: A, reason: '   ' })).rejects.toThrow()
  })

  it('rejects a malformed sender', async () => {
    await expect(buildBuzzSignal({ groupId: 'g', seedHex: SEED, from: 'nope', reason: 'hi' })).rejects.toThrow()
  })

  it('rejects a malformed target', async () => {
    await expect(buildBuzzSignal({ groupId: 'g', seedHex: SEED, from: A, reason: 'hi', target: 'nope' })).rejects.toThrow()
  })

  it('round-trips a location roll-call ask (check-in)', async () => {
    const event = await buildBuzzSignal({ groupId: 'g', seedHex: SEED, from: A, reason: 'Check in', ask: 'location', timestamp: 9 })
    const back = await decryptBuzz(SEED, event.content)
    expect(back.ask).toBe('location')
    expect(back.reason).toBe('Check in')
  })

  it('a plain buzz carries no ask', async () => {
    const event = await buildBuzzSignal({ groupId: 'g', seedHex: SEED, from: A, reason: 'Come home' })
    expect((await decryptBuzz(SEED, event.content)).ask).toBeUndefined()
  })

  it('rejects an unknown ask on build', async () => {
    await expect(buildBuzzSignal({ groupId: 'g', seedHex: SEED, from: A, reason: 'hi', ask: 'battery' as never })).rejects.toThrow()
  })

  it('drops (never throws on) an unknown ask when decrypting — forwards-compatible', async () => {
    // Hand-roll a payload a FUTURE client might send: today's client must keep
    // the human-readable buzz and simply ignore the ask it doesn't know.
    const { deriveGroupKey, encryptEnvelope } = await import('canary-kit/sync')
    const content = await encryptEnvelope(deriveGroupKey(SEED), JSON.stringify({ from: A, reason: 'hi', timestamp: 1, ask: 'battery' }))
    const back = await decryptBuzz(SEED, content)
    expect(back.reason).toBe('hi')
    expect(back.ask).toBeUndefined()
  })
})
