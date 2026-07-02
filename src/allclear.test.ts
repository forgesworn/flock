import { describe, it, expect } from 'vitest'
import { buildAllClearSignal, decryptAllClear, ALLCLEAR_SIGNAL_TYPE, type AllClear } from './allclear.js'

const SEED = '0000000000000000000000000000000000000000000000000000000000000001'
const A = 'a'.repeat(64)

describe('buildAllClearSignal / decryptAllClear', () => {
  it('round-trips a genuine stand-down', async () => {
    const event = await buildAllClearSignal({ groupId: 'g', seedHex: SEED, member: A, timestamp: 42 })
    expect(event.kind).toBe(20_078)
    expect(event.tags.find((t) => t[0] === 't')?.[1]).toBe(ALLCLEAR_SIGNAL_TYPE)

    const back = await decryptAllClear(SEED, event.content)
    expect(back).toEqual<AllClear>({ member: A, timestamp: 42 })
    expect(back.coerced).toBeUndefined() // genuine by default — the common case
  })

  it('a coerced stand-down carries the flag INSIDE the encryption only', async () => {
    const event = await buildAllClearSignal({ groupId: 'g', seedHex: SEED, member: A, timestamp: 7, coerced: true })
    // Wire image identical in shape: same type tag, no plaintext hint.
    expect(event.tags.find((t) => t[0] === 't')?.[1]).toBe(ALLCLEAR_SIGNAL_TYPE)
    expect(event.content).not.toContain('coerced')
    expect(event.content).not.toContain(A)

    const back = await decryptAllClear(SEED, event.content)
    expect(back.coerced).toBe(true)
    expect(back.member).toBe(A)
  })

  it('a wrong seed cannot decrypt', async () => {
    const event = await buildAllClearSignal({ groupId: 'g', seedHex: SEED, member: A, timestamp: 1 })
    await expect(decryptAllClear('f'.repeat(64), event.content)).rejects.toThrow()
  })

  it('rejects a malformed member', async () => {
    await expect(buildAllClearSignal({ groupId: 'g', seedHex: SEED, member: 'nope', timestamp: 1 })).rejects.toThrow()
  })

  it('rejects a tampered payload on decrypt', async () => {
    const { encryptEnvelope, deriveGroupKey } = await import('canary-kit/sync')
    const bad = await encryptEnvelope(deriveGroupKey(SEED), JSON.stringify({ member: 'not-a-key', timestamp: 'soon' }))
    await expect(decryptAllClear(SEED, bad)).rejects.toThrow()
  })
})
