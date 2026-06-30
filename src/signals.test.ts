import { describe, it, expect } from 'vitest'
import {
  buildLocationSignal,
  buildHelpSignal,
  signalTypeForReason,
  SIGNAL_TYPES,
} from './signals.js'
import {
  deriveBeaconKey,
  decryptBeacon,
  deriveDuressKey,
  decryptDuressAlert,
} from 'canary-kit'

const SEED = '0000000000000000000000000000000000000000000000000000000000000001'
const MEMBER = 'a'.repeat(64)
const GROUP = 'flock-test'
const SIGNAL_KIND = 20_078

function tagValue(event: { tags: string[][] }, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1]
}

describe('signalTypeForReason', () => {
  it('maps each policy reason to a signal type', () => {
    expect(signalTypeForReason('nightout')).toBe(SIGNAL_TYPES.beacon)
    expect(signalTypeForReason('breach')).toBe(SIGNAL_TYPES.breach)
    expect(signalTypeForReason('pickup')).toBe(SIGNAL_TYPES.pickup)
    expect(signalTypeForReason('help')).toBe(SIGNAL_TYPES.help)
  })

  it('returns null when there is nothing to send', () => {
    expect(signalTypeForReason('none')).toBeNull()
    // @ts-expect-error — exercise the runtime fallthrough guard
    expect(signalTypeForReason('bogus')).toBeNull()
  })
})

describe('buildLocationSignal', () => {
  it('builds a kind-20078 signal with the right t-tag', async () => {
    const event = await buildLocationSignal({
      groupId: GROUP, seedHex: SEED, signalType: SIGNAL_TYPES.breach, geohash: 'gcpuuz', precision: 9,
    })
    expect(event.kind).toBe(SIGNAL_KIND)
    expect(tagValue(event, 't')).toBe('breach')
    expect(typeof event.content).toBe('string')
    expect(event.content.length).toBeGreaterThan(0)
  })

  it('round-trips the location through the beacon key', async () => {
    const event = await buildLocationSignal({
      groupId: GROUP, seedHex: SEED, signalType: SIGNAL_TYPES.pickup, geohash: 'gcpuuz', precision: 6,
    })
    const payload = await decryptBeacon(deriveBeaconKey(SEED), event.content)
    expect(payload.geohash).toBe('gcpuuz')
    expect(payload.precision).toBe(6)
  })
})

describe('buildHelpSignal', () => {
  it('builds a help signal carrying a decryptable duress alert', async () => {
    const event = await buildHelpSignal({
      groupId: GROUP, seedHex: SEED, member: MEMBER,
      location: { geohash: 'gcpuuz', precision: 11, locationSource: 'beacon' },
    })
    expect(event.kind).toBe(SIGNAL_KIND)
    expect(tagValue(event, 't')).toBe('help')

    const alert = await decryptDuressAlert(deriveDuressKey(SEED), event.content)
    expect(alert.type).toBe('duress')
    expect(alert.member).toBe(MEMBER)
    expect(alert.geohash).toBe('gcpuuz')
    expect(alert.locationSource).toBe('beacon')
    expect(alert.scope).toBe('group') // default
  })

  it('supports a location-less alert', async () => {
    const event = await buildHelpSignal({
      groupId: GROUP, seedHex: SEED, member: MEMBER, location: null,
    })
    const alert = await decryptDuressAlert(deriveDuressKey(SEED), event.content)
    expect(alert.locationSource).toBe('none')
    expect(alert.geohash).toBe('')
  })

  it('honours scope and originGroupId', async () => {
    const event = await buildHelpSignal({
      groupId: GROUP, seedHex: SEED, member: MEMBER, location: null,
      scope: 'master', originGroupId: 'origin-group',
    })
    const alert = await decryptDuressAlert(deriveDuressKey(SEED), event.content)
    expect(alert.scope).toBe('master')
    expect(alert.originGroupId).toBe('origin-group')
  })

  it('rejects an invalid member pubkey', async () => {
    await expect(buildHelpSignal({
      groupId: GROUP, seedHex: SEED, member: 'tooshort', location: null,
    })).rejects.toThrow()
  })
})
