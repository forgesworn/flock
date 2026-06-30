import { describe, it, expect } from 'vitest'
import {
  etaSeconds,
  assessArrival,
  buildRendezvousSignal,
  decryptRendezvous,
  buildRendezvousStatusSignal,
  decryptRendezvousStatus,
  SPEED_KMH,
  RENDEZVOUS_SIGNAL_TYPE,
  RENDEZVOUS_STATUS_TYPE,
  type Rendezvous,
  type RendezvousStatus,
} from './rendezvous.js'

const SEED = '0000000000000000000000000000000000000000000000000000000000000001'
const A = 'a'.repeat(64)
const PLACE = { lat: 51.5074, lon: -0.1278, label: 'The Park' }
const FAR = { lat: 51.5164, lon: -0.1278 } // ~1 km north of PLACE
const NOW = 1_000_000

function rzv(deadline: number): Rendezvous {
  return { id: 'rzv-1', place: PLACE, deadline, mode: 'be-back', setBy: A, createdAt: NOW }
}

describe('etaSeconds', () => {
  it('scales with travel mode (walk slower than drive)', () => {
    expect(etaSeconds(1000, 'walk')).toBeGreaterThan(etaSeconds(1000, 'drive'))
  })
  it('matches distance ÷ speed', () => {
    expect(etaSeconds(1000, 'walk')).toBeCloseTo(1000 / ((SPEED_KMH.walk * 1000) / 3600), 5)
  })
  it('rejects a bad distance', () => {
    expect(() => etaSeconds(-1, 'walk')).toThrow()
  })
})

describe('assessArrival', () => {
  it('marks arrival within the radius', () => {
    const p = assessArrival(rzv(NOW + 3600), A, PLACE, 'walk', NOW)
    expect(p.status).toBe('arrived')
    expect(p.distanceMetres).toBeLessThan(60)
  })

  it('marks at-risk when projected arrival is after the deadline', () => {
    const p = assessArrival(rzv(NOW + 60), A, FAR, 'walk', NOW) // ~12 min walk, 1 min deadline
    expect(p.status).toBe('at-risk')
    expect(p.slackSeconds).toBeLessThan(0)
  })

  it('marks en-route when on track, with a leave-by time', () => {
    const p = assessArrival(rzv(NOW + 3600), A, FAR, 'walk', NOW)
    expect(p.status).toBe('enroute')
    expect(p.slackSeconds).toBeGreaterThan(0)
    expect(p.leaveBy).toBeGreaterThan(NOW)
    expect(p.distanceMetres).toBeGreaterThan(900)
    expect(p.distanceMetres).toBeLessThan(1100)
  })
})

describe('rendezvous signals round-trip', () => {
  it('definition round-trips through the group envelope', async () => {
    const r = rzv(NOW + 1800)
    const event = await buildRendezvousSignal({ groupId: 'g', seedHex: SEED, rendezvous: r })
    expect(event.kind).toBe(20_078)
    expect(event.tags.find((t) => t[0] === 't')?.[1]).toBe(RENDEZVOUS_SIGNAL_TYPE)
    expect(await decryptRendezvous(SEED, event.content)).toEqual(r)
  })

  it('status round-trips and is typed rzv-status', async () => {
    const status: RendezvousStatus = { rendezvousId: 'rzv-1', member: A, status: 'enroute', etaSeconds: 540, timestamp: NOW }
    const event = await buildRendezvousStatusSignal({ groupId: 'g', seedHex: SEED, status })
    expect(event.tags.find((t) => t[0] === 't')?.[1]).toBe(RENDEZVOUS_STATUS_TYPE)
    expect(await decryptRendezvousStatus(SEED, event.content)).toEqual(status)
  })

  it('a wrong seed cannot decrypt', async () => {
    const event = await buildRendezvousSignal({ groupId: 'g', seedHex: SEED, rendezvous: rzv(NOW) })
    await expect(decryptRendezvous('f'.repeat(64), event.content)).rejects.toThrow()
  })

  it('rejects a malformed rendezvous', async () => {
    const bad = { ...rzv(NOW), setBy: 'nope' } as unknown as Rendezvous
    await expect(buildRendezvousSignal({ groupId: 'g', seedHex: SEED, rendezvous: bad })).rejects.toThrow()
  })
})
