import { describe, it, expect } from 'vitest'
import { buildOffGridSignal, decryptOffGrid, isOffGrid, OFFGRID_SIGNAL_TYPE } from './offgrid.js'

const SEED = '0000000000000000000000000000000000000000000000000000000000000001'
const FROM = 'b'.repeat(64)

describe('off-grid signal', () => {
  it('round-trips as a kind-20078 offgrid signal', async () => {
    const event = await buildOffGridSignal({ groupId: 'g', seedHex: SEED, from: FROM, until: 2_000, timestamp: 1_000 })
    expect(event.kind).toBe(20_078)
    expect(event.tags.find((t) => t[0] === 't')?.[1]).toBe(OFFGRID_SIGNAL_TYPE)
    expect(await decryptOffGrid(SEED, event.content)).toEqual({ from: FROM, until: 2_000, timestamp: 1_000 })
  })

  it('carries an optional reason', async () => {
    const event = await buildOffGridSignal({ groupId: 'g', seedHex: SEED, from: FROM, until: 9, reason: 'flight', timestamp: 5 })
    expect((await decryptOffGrid(SEED, event.content)).reason).toBe('flight')
  })

  it('rejects a non-hex author', async () => {
    await expect(buildOffGridSignal({ groupId: 'g', seedHex: SEED, from: 'nope', until: 1 })).rejects.toThrow()
  })

  it('rejects a non-finite until', async () => {
    await expect(buildOffGridSignal({ groupId: 'g', seedHex: SEED, from: FROM, until: Number.NaN })).rejects.toThrow()
  })

  it('a wrong seed cannot decrypt', async () => {
    const event = await buildOffGridSignal({ groupId: 'g', seedHex: SEED, from: FROM, until: 1 })
    await expect(decryptOffGrid('f'.repeat(64), event.content)).rejects.toThrow()
  })

  it('isOffGrid is true only until the deadline passes', () => {
    const o = { from: FROM, until: 2_000, timestamp: 1_000 }
    expect(isOffGrid(o, 1_500)).toBe(true)
    expect(isOffGrid(o, 2_000)).toBe(false) // a cancel re-announces with until=now → back on grid
    expect(isOffGrid(o, 2_500)).toBe(false)
  })
})
