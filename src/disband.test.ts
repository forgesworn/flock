import { describe, it, expect } from 'vitest'
import { buildDisbandSignal, decryptDisband, DISBAND_SIGNAL_TYPE } from './disband.js'

const SEED = '0000000000000000000000000000000000000000000000000000000000000001'
const BY = 'a'.repeat(64)

describe('disband signal', () => {
  it('round-trips through the group envelope as a kind-20078 disband', async () => {
    const event = await buildDisbandSignal({ groupId: 'g', seedHex: SEED, by: BY, timestamp: 1_000_000 })
    expect(event.kind).toBe(20_078)
    expect(event.tags.find((t) => t[0] === 't')?.[1]).toBe(DISBAND_SIGNAL_TYPE)
    expect(await decryptDisband(SEED, event.content)).toEqual({ groupId: 'g', by: BY, timestamp: 1_000_000 })
  })

  it('carries an optional reason', async () => {
    const event = await buildDisbandSignal({ groupId: 'g', seedHex: SEED, by: BY, reason: 'trip over', timestamp: 5 })
    expect((await decryptDisband(SEED, event.content)).reason).toBe('trip over')
  })

  it('rejects a non-hex author', async () => {
    await expect(buildDisbandSignal({ groupId: 'g', seedHex: SEED, by: 'nope' })).rejects.toThrow()
  })

  it('a wrong seed cannot decrypt', async () => {
    const event = await buildDisbandSignal({ groupId: 'g', seedHex: SEED, by: BY })
    await expect(decryptDisband('f'.repeat(64), event.content)).rejects.toThrow()
  })
})
