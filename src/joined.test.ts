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

  it('round-trips an optional handle, trimmed', async () => {
    const event = await buildJoinedSignal({ groupId: 'g', seedHex: SEED, member: A, timestamp: 1, handle: '  Dave  ' })
    const back = await decryptJoined(SEED, event.content)
    expect(back.handle).toBe('Dave')
  })

  it('omits an empty handle', async () => {
    const event = await buildJoinedSignal({ groupId: 'g', seedHex: SEED, member: A, timestamp: 1, handle: '   ' })
    const back = await decryptJoined(SEED, event.content)
    expect(back.handle).toBeUndefined()
  })

  it('rejects an overlong handle on build and on decrypt', async () => {
    await expect(buildJoinedSignal({ groupId: 'g', seedHex: SEED, member: A, handle: 'x'.repeat(41) })).rejects.toThrow(/handle/)
    const { deriveGroupKey, encryptEnvelope } = await import('canary-kit/sync')
    const content = await encryptEnvelope(deriveGroupKey(SEED), JSON.stringify({ member: A, timestamp: 1, handle: 'x'.repeat(200) }))
    const back = await decryptJoined(SEED, content)
    expect(back.handle).toBeUndefined() // malformed extra field is dropped, not fatal
  })
})
