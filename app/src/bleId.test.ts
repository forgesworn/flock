import { describe, it, expect } from 'vitest'
import {
  advertId,
  advertIdNow,
  advertIdsToScan,
  bleWindow,
  BLE_WINDOW_SECONDS,
  BLE_MESH_EPOCH_SECONDS,
  meshEpoch,
  meshUuid,
  meshUuidNow,
} from './bleId'

const SEED_A = 'a'.repeat(64)
const SEED_B = 'b'.repeat(64)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// The rotating, members-only BLE advertising identity — the security keystone of
// the BLE-nearby transport. A STABLE advert would be a physical-world tracker, so
// these tests assert the properties that keep it from becoming one: derived from
// the circle seed (members-only), rotating per window (unlinkable across time),
// and unpredictable without the seed.
describe('advertId', () => {
  it('is a well-formed v4 UUID', () => {
    expect(advertId(SEED_A, 100)).toMatch(UUID_RE)
  })

  it('is deterministic for the same seed + window (both members compute it)', () => {
    expect(advertId(SEED_A, 100)).toBe(advertId(SEED_A, 100))
  })

  // Rotation: a device is a different UUID each window → not linkable across time.
  it('changes every window', () => {
    expect(advertId(SEED_A, 100)).not.toBe(advertId(SEED_A, 101))
  })

  // Members-only: without the circle seed you cannot compute or recognise it.
  it('differs by circle seed', () => {
    expect(advertId(SEED_A, 100)).not.toBe(advertId(SEED_B, 100))
  })

  // A wrong seed can't produce a member's id (unpredictable without the secret) —
  // sampled across many windows to make an accidental collision astronomically
  // unlikely rather than relying on one draw.
  it('a non-member seed never matches a member id across a window sweep', () => {
    for (let w = 0; w < 500; w++) expect(advertId(SEED_B, w)).not.toBe(advertId(SEED_A, w))
  })
})

describe('bleWindow', () => {
  it('buckets unix seconds into the rotation window', () => {
    expect(bleWindow(0)).toBe(0)
    expect(bleWindow(BLE_WINDOW_SECONDS - 1)).toBe(0)
    expect(bleWindow(BLE_WINDOW_SECONDS)).toBe(1)
  })
})

describe('advertIdNow / advertIdsToScan', () => {
  const now = 5_000_000

  it('advertIdNow is the current window s id', () => {
    expect(advertIdNow(SEED_A, now)).toBe(advertId(SEED_A, bleWindow(now)))
  })

  it('scans the current window plus ±1 for clock skew (3 ids per seed)', () => {
    const w = bleWindow(now)
    const ids = advertIdsToScan([SEED_A], now)
    expect(ids).toHaveLength(3)
    expect(ids).toContain(advertId(SEED_A, w - 1))
    expect(ids).toContain(advertId(SEED_A, w))
    expect(ids).toContain(advertId(SEED_A, w + 1))
  })

  it('covers every circle seed', () => {
    const ids = advertIdsToScan([SEED_A, SEED_B], now)
    expect(ids).toContain(advertIdNow(SEED_A, now))
    expect(ids).toContain(advertIdNow(SEED_B, now))
    expect(ids).toHaveLength(6)
  })

  // The point of ±1: a scanner one window behind an advertiser still discovers it.
  it('tolerates a one-window clock skew between advertiser and scanner', () => {
    const advertising = advertIdNow(SEED_A, now)
    const scannerOneWindowAhead = advertIdsToScan([SEED_A], now + BLE_WINDOW_SECONDS)
    expect(scannerOneWindowAhead).toContain(advertising)
  })
})

// The common crowd-mesh discovery UUID — the deliberate opposite of advertId: NOT
// members-only, so any two flock phones in a crowd connect and flood opaque wraps
// across overlapping circles. These tests pin the properties that keep it a
// daily-rotating proximity signal rather than a permanent, circle-linked tracker.
describe('meshUuid / meshUuidNow', () => {
  it('is a well-formed v4 UUID', () => {
    expect(meshUuid(19_000)).toMatch(UUID_RE)
  })

  // Keyless + deterministic: every flock device computes the SAME UUID per day
  // (that is the whole point — crowd mode spans circles that share no secret).
  it('is deterministic per epoch across devices', () => {
    expect(meshUuid(19_000)).toBe(meshUuid(19_000))
  })

  // Daily rotation: not a permanent beacon.
  it('rotates every epoch', () => {
    expect(meshUuid(19_000)).not.toBe(meshUuid(19_001))
  })

  // It takes no seed at all — it must not coincide with any circle's advertId.
  it('is independent of any circle seed', () => {
    expect(meshUuid(19_000)).not.toBe(advertId(SEED_A, 19_000))
    expect(meshUuid(19_000)).not.toBe(advertId(SEED_B, 19_000))
  })

  it('meshEpoch buckets unix seconds into the daily epoch', () => {
    expect(meshEpoch(0)).toBe(0)
    expect(meshEpoch(BLE_MESH_EPOCH_SECONDS - 1)).toBe(0)
    expect(meshEpoch(BLE_MESH_EPOCH_SECONDS)).toBe(1)
  })

  it('meshUuidNow is the current epoch s UUID', () => {
    const now = 19_000 * BLE_MESH_EPOCH_SECONDS + 5
    expect(meshUuidNow(now)).toBe(meshUuid(19_000))
  })
})
