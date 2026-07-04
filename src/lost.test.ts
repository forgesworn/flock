import { describe, it, expect } from 'vitest'
import {
  buildLostSignal,
  decryptLost,
  LOST_SIGNAL_TYPE,
  type LostReport,
} from './lost.js'

const SEED = '0000000000000000000000000000000000000000000000000000000000000001'
const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

describe('buildLostSignal / decryptLost', () => {
  it('round-trips a peer report (B reports A\'s phone lost)', async () => {
    const event = await buildLostSignal({ groupId: 'g', seedHex: SEED, member: A, by: B, lost: true, timestamp: 42 })
    expect(event.kind).toBe(20_078)
    expect(event.tags.find((t) => t[0] === 't')?.[1]).toBe(LOST_SIGNAL_TYPE)

    const back = await decryptLost(SEED, event.content)
    expect(back).toEqual<LostReport>({ member: A, by: B, lost: true, timestamp: 42 })
  })

  it('round-trips an all-clear ("found it"), including self-clearing', async () => {
    const event = await buildLostSignal({ groupId: 'g', seedHex: SEED, member: A, by: A, lost: false, timestamp: 7 })
    const back = await decryptLost(SEED, event.content)
    expect(back.lost).toBe(false)
    expect(back.member).toBe(A)
    expect(back.by).toBe(A)
  })

  it('stamps now when no timestamp is given', async () => {
    const before = Math.floor(Date.now() / 1000)
    const event = await buildLostSignal({ groupId: 'g', seedHex: SEED, member: A, by: B, lost: true })
    const back = await decryptLost(SEED, event.content)
    expect(back.timestamp).toBeGreaterThanOrEqual(before)
  })

  it('a wrong seed cannot decrypt', async () => {
    const event = await buildLostSignal({ groupId: 'g', seedHex: SEED, member: A, by: B, lost: true })
    await expect(decryptLost('f'.repeat(64), event.content)).rejects.toThrow()
  })

  it('rejects a malformed member', async () => {
    await expect(buildLostSignal({ groupId: 'g', seedHex: SEED, member: 'nope', by: B, lost: true })).rejects.toThrow()
  })

  it('rejects a malformed reporter', async () => {
    await expect(buildLostSignal({ groupId: 'g', seedHex: SEED, member: A, by: 'nope', lost: true })).rejects.toThrow()
  })

  it('rejects a tampered payload on decrypt', async () => {
    const event = await buildLostSignal({ groupId: 'g', seedHex: SEED, member: A, by: B, lost: true })
    // Any bit-flip must fail authenticated decryption, not yield a mangled report.
    const corrupted = event.content.slice(0, -4) + (event.content.endsWith('AAAA') ? 'BBBB' : 'AAAA')
    await expect(decryptLost(SEED, corrupted)).rejects.toThrow()
  })

  it('round-trips an optional message from the reporter', async () => {
    const event = await buildLostSignal({ groupId: 'g', seedHex: SEED, member: A, by: B, lost: true, message: 'left in the blue Uber' })
    const back = await decryptLost(SEED, event.content)
    expect(back.message).toBe('left in the blue Uber')
  })

  it('trims the message and omits it when blank', async () => {
    const event = await buildLostSignal({ groupId: 'g', seedHex: SEED, member: A, by: B, lost: true, message: '  on the 08:15 to Leeds  ' })
    expect((await decryptLost(SEED, event.content)).message).toBe('on the 08:15 to Leeds')

    const blank = await buildLostSignal({ groupId: 'g', seedHex: SEED, member: A, by: B, lost: true, message: '   ' })
    expect((await decryptLost(SEED, blank.content)).message).toBeUndefined()
  })

  it('a report with no message round-trips without one (backward compatible)', async () => {
    const event = await buildLostSignal({ groupId: 'g', seedHex: SEED, member: A, by: B, lost: true })
    const back = await decryptLost(SEED, event.content)
    expect(back).toEqual<LostReport>({ member: A, by: B, lost: true, timestamp: back.timestamp })
    expect(back.message).toBeUndefined()
  })

  it('caps an overlong message', async () => {
    const long = 'x'.repeat(300)
    const event = await buildLostSignal({ groupId: 'g', seedHex: SEED, member: A, by: B, lost: true, message: long })
    const back = await decryptLost(SEED, event.content)
    expect(back.message?.length).toBe(200)
  })
})
