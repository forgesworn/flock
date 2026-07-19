import { describe, it, expect } from 'vitest'
import { deriveGroupKey, encryptEnvelope } from 'canary-kit/sync'
import { buildPinSignal, decryptPin, withPin, PIN_SIGNAL_TYPE, pinLabel, isPinKind, type Pin } from './pin'

const SEED = '0000000000000000000000000000000000000000000000000000000000000001'
const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const ID = 'deadbeefcafef00d'

const enc = (payload: Record<string, unknown>): Promise<string> =>
  encryptEnvelope(deriveGroupKey(SEED), JSON.stringify(payload))

describe('pin wire', () => {
  it('round-trips a fixed-kind pin', async () => {
    const event = await buildPinSignal({ groupId: 'g', seedHex: SEED, id: ID, from: A, kind: 'car', geohash: 'gcpvj0', precision: 9, timestamp: 42 })
    expect(event.kind).toBe(20_078)
    expect(event.tags.find((t) => t[0] === 't')?.[1]).toBe(PIN_SIGNAL_TYPE)
    expect(await decryptPin(SEED, event.content)).toEqual<Pin>({ id: ID, from: A, kind: 'car', geohash: 'gcpvj0', precision: 9, timestamp: 42 })
  })

  it('carries a removal tombstone', async () => {
    const event = await buildPinSignal({ groupId: 'g', seedHex: SEED, id: ID, from: A, kind: 'picnic', geohash: 'gcpvj0', precision: 9, timestamp: 7, removed: true })
    expect((await decryptPin(SEED, event.content)).removed).toBe(true)
  })

  it('rejects an unknown kind, bad geohash, and a wrong seed', async () => {
    await expect(buildPinSignal({ groupId: 'g', seedHex: SEED, id: ID, from: A, kind: 'nope' as never, geohash: 'gcpvj0', precision: 9 })).rejects.toThrow()
    await expect(decryptPin(SEED, await enc({ id: ID, from: A, kind: 'lol', geohash: 'gcpvj0', precision: 9, timestamp: 1 }))).rejects.toThrow(/kind/i)
    await expect(decryptPin(SEED, await enc({ id: ID, from: A, kind: 'car', geohash: 'NOT A GEOHASH', precision: 9, timestamp: 1 }))).rejects.toThrow(/geohash/i)
    const ok = await buildPinSignal({ groupId: 'g', seedHex: SEED, id: ID, from: A, kind: 'car', geohash: 'gcpvj0', precision: 9 })
    await expect(decryptPin('f'.repeat(64), ok.content)).rejects.toThrow()
  })

  it('labels from the fixed vocabulary and guards the kind', () => {
    expect(pinLabel('car')).toContain('Car')
    expect(isPinKind('car')).toBe(true)
    expect(isPinKind('meet at the corner')).toBe(false)
  })

  it('merges latest-wins per id and applies tombstones', () => {
    const car: Pin = { id: '1'.repeat(8), from: A, kind: 'car', geohash: 'g', precision: 9, timestamp: 10 }
    const carMoved: Pin = { ...car, geohash: 'h', timestamp: 20 }
    const other: Pin = { id: '2'.repeat(8), from: B, kind: 'water', geohash: 'k', precision: 9, timestamp: 5 }

    let list = withPin(undefined, car)
    list = withPin(list, other)
    expect(list).toHaveLength(2)

    // A newer drop of the same id replaces it; an older one is ignored.
    expect(withPin(list, carMoved).find((p) => p.id === car.id)?.geohash).toBe('h')
    expect(withPin(list, { ...car, geohash: 'x', timestamp: 1 })).toBe(list)

    // A tombstone removes it.
    const removed = withPin(list, { ...car, timestamp: 30, removed: true })
    expect(removed.find((p) => p.id === car.id)).toBeUndefined()
    expect(removed).toHaveLength(1)
  })
})
