import { describe, it, expect } from 'vitest'
import { deriveGroupKey, encryptEnvelope } from 'canary-kit/sync'
import { buildPinSignal, decryptPin, withPin, PIN_SIGNAL_TYPE, pinLabel, isPinKind, PIN_KINDS, PIN_KIND_LIST, type Pin } from './pin'

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

  it('every vocabulary kind is well-formed and self-guarding', () => {
    // The picker and the map draw straight from this table, so each entry must
    // carry a non-empty glyph + label and pass its own kind guard — a malformed
    // entry would render a blank chip / blank map badge with no other signal.
    expect(PIN_KIND_LIST.length).toBeGreaterThanOrEqual(7)
    expect(new Set(PIN_KIND_LIST).size).toBe(PIN_KIND_LIST.length) // no dup keys
    const glyphs = new Set<string>()
    for (const k of PIN_KIND_LIST) {
      expect(isPinKind(k)).toBe(true)
      const { glyph, label } = PIN_KINDS[k]
      expect(glyph.length).toBeGreaterThan(0)
      expect(label.trim().length).toBeGreaterThan(0)
      expect(pinLabel(k)).toBe(`${glyph} ${label}`)
      glyphs.add(glyph)
    }
    // Distinct glyphs — two kinds sharing an icon would be indistinguishable on the map.
    expect(glyphs.size).toBe(PIN_KIND_LIST.length)
  })

  it('round-trips the newer vocabulary kinds on the wire', async () => {
    for (const kind of ['meet', 'parking', 'food', 'toilet', 'firstaid'] as const) {
      const event = await buildPinSignal({ groupId: 'g', seedHex: SEED, id: ID, from: A, kind, geohash: 'gcpvj0', precision: 9, timestamp: 42 })
      expect((await decryptPin(SEED, event.content)).kind).toBe(kind)
    }
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

    // A tombstone is RETAINED as an entry (display layers filter `removed`) —
    // it must keep outranking the drop on every future replay.
    const removed = withPin(list, { ...car, timestamp: 30, removed: true })
    expect(removed.find((p) => p.id === car.id)?.removed).toBe(true)
    expect(removed).toHaveLength(2)
  })

  it('a replayed drop never resurrects a removed pin', () => {
    const car: Pin = { id: '1'.repeat(8), from: A, kind: 'car', geohash: 'g', precision: 9, timestamp: 10 }
    const tomb: Pin = { ...car, timestamp: 30, removed: true }

    // Relays replay wraps in arbitrary order (gift-wrap timestamps are smeared).
    // Drop → tombstone → drop replay: still removed.
    let list = withPin(withPin(withPin(undefined, car), tomb), car)
    expect(list.find((p) => p.id === car.id)?.removed).toBe(true)

    // Tombstone FIRST (before its drop ever arrives), then the drop: never lands.
    list = withPin(withPin(undefined, tomb), car)
    expect(list.find((p) => p.id === car.id)?.removed).toBe(true)

    // A genuinely NEWER re-drop of the same id (a move after removal) does land.
    const reDropped = withPin(list, { ...car, geohash: 'z', timestamp: 40 })
    expect(reDropped.find((p) => p.id === car.id)?.removed).toBeUndefined()
    expect(reDropped.find((p) => p.id === car.id)?.geohash).toBe('z')
  })

  it("another member's tombstone lands on the pin (removal is by id, signed as the remover)", () => {
    // Receivers bind `from` to the wrap's seal signer, so B removes A's pin by
    // sending a tombstone with from=B — same id, newer timestamp.
    const car: Pin = { id: '1'.repeat(8), from: A, kind: 'car', geohash: 'g', precision: 9, timestamp: 10 }
    const list = withPin(withPin(undefined, car), { ...car, from: B, timestamp: 30, removed: true })
    const entry = list.find((p) => p.id === car.id)
    expect(entry?.removed).toBe(true)
    expect(entry?.from).toBe(B)
    // And A's original drop replaying later still loses.
    expect(withPin(list, car)).toBe(list)
  })
})
