import { describe, it, expect } from 'vitest'
import { buildJoinedSignal, decryptJoined, JOINED_SIGNAL_TYPE, type Joined } from './joined.js'

const SEED = '0000000000000000000000000000000000000000000000000000000000000001'
const OTHER_SEED = '0000000000000000000000000000000000000000000000000000000000000002'
const A = 'a'.repeat(64)

describe('buildJoinedSignal / decryptJoined', () => {
  it('round-trips a joined announcement', async () => {
    const event = await buildJoinedSignal({ groupId: 'g', seedHex: SEED, member: A, timestamp: 42 })
    expect(event.kind).toBe(20_078)
    expect(event.tags.find((t) => t[0] === 't')?.[1]).toBe(JOINED_SIGNAL_TYPE)

    const back = await decryptJoined(SEED, event.content)
    expect(back).toEqual<Joined>({ member: A, timestamp: 42 })
  })

  it('defaults the timestamp to now', async () => {
    const before = Math.floor(Date.now() / 1000)
    const event = await buildJoinedSignal({ groupId: 'g', seedHex: SEED, member: A })
    const back = await decryptJoined(SEED, event.content)
    expect(back.timestamp).toBeGreaterThanOrEqual(before)
  })

  it('rejects a malformed member key', async () => {
    await expect(buildJoinedSignal({ groupId: 'g', seedHex: SEED, member: 'npub1notahexkey' })).rejects.toThrow(/member/)
  })

  it('does not decrypt under a different seed', async () => {
    const event = await buildJoinedSignal({ groupId: 'g', seedHex: SEED, member: A, timestamp: 1 })
    await expect(decryptJoined(OTHER_SEED, event.content)).rejects.toThrow()
  })

  it('rejects a payload whose member is not a valid key', async () => {
    const { deriveGroupKey, encryptEnvelope } = await import('canary-kit/sync')
    const content = await encryptEnvelope(deriveGroupKey(SEED), JSON.stringify({ member: 'not-a-key', timestamp: 1 }))
    await expect(decryptJoined(SEED, content)).rejects.toThrow(/member/)
  })
})
