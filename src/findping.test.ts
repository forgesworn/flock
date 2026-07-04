import { describe, it, expect } from 'vitest'
import { buildFindPingSignal, decryptFindPing, FIND_PING_SIGNAL_TYPE } from './findping.js'

const SEED = 'a'.repeat(64)
const FROM = '1'.repeat(64)
const TARGET = '2'.repeat(64)

describe('findreq (remote exact ping — the ask)', () => {
  it('builds a kind-20078 signal tagged findreq', async () => {
    const ev = await buildFindPingSignal({ groupId: 'g', seedHex: SEED, from: FROM, target: TARGET })
    expect(ev.kind).toBe(20078)
    expect(ev.tags.find((t: string[]) => t[0] === 't')?.[1]).toBe(FIND_PING_SIGNAL_TYPE)
  })

  it('round-trips from/target/timestamp through the group envelope', async () => {
    const ev = await buildFindPingSignal({ groupId: 'g', seedHex: SEED, from: FROM, target: TARGET, timestamp: 1234 })
    const p = await decryptFindPing(SEED, ev.content)
    expect(p).toEqual({ from: FROM, target: TARGET, timestamp: 1234 })
  })

  it('a different seed cannot decrypt the ask', async () => {
    const ev = await buildFindPingSignal({ groupId: 'g', seedHex: SEED, from: FROM, target: TARGET })
    await expect(decryptFindPing('b'.repeat(64), ev.content)).rejects.toThrow()
  })

  it('rejects a non-hex from/target at build time', async () => {
    await expect(buildFindPingSignal({ groupId: 'g', seedHex: SEED, from: 'nope', target: TARGET })).rejects.toThrow()
    await expect(buildFindPingSignal({ groupId: 'g', seedHex: SEED, from: FROM, target: 'nope' })).rejects.toThrow()
  })

  it('rejects a malformed payload on decrypt', async () => {
    const { encryptEnvelope } = await import('canary-kit/sync')
    const { deriveGroupKey } = await import('canary-kit/sync')
    const bad = await encryptEnvelope(deriveGroupKey(SEED), JSON.stringify({ from: FROM }))
    await expect(decryptFindPing(SEED, bad)).rejects.toThrow()
  })
})
