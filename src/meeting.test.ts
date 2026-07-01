import { describe, it, expect } from 'vitest'
import {
  buildMeetingRequestSignal,
  decryptMeetingRequest,
  buildMeetingShareSignal,
  decryptMeetingShare,
  MEETING_REQUEST_TYPE,
  MEETING_SHARE_TYPE,
  type MeetingRequest,
  type MeetingShare,
} from './meeting.js'

const SEED = '0000000000000000000000000000000000000000000000000000000000000001'
const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const NOW = 1_700_000_000

const req = (o: Partial<MeetingRequest> = {}): MeetingRequest => ({
  id: 'mtg-1', setBy: A, mode: 'walk', maxTimeMinutes: 30, createdAt: NOW, ...o,
})
const share = (o: Partial<MeetingShare> = {}): MeetingShare => ({
  requestId: 'mtg-1', member: B, geohash: 'gcpvj0', precision: 6, mode: 'cycle', timestamp: NOW, ...o,
})

describe('meeting-point signals round-trip', () => {
  it('a meeting request is a kind-20078 mtg-req signal that round-trips', async () => {
    const r = req()
    const event = await buildMeetingRequestSignal({ groupId: 'g', seedHex: SEED, request: r })
    expect(event.kind).toBe(20_078)
    expect(event.tags.find((t) => t[0] === 't')?.[1]).toBe(MEETING_REQUEST_TYPE)
    expect(await decryptMeetingRequest(SEED, event.content)).toEqual(r)
  })

  it('a meeting share is a kind-20078 mtg-loc signal that round-trips', async () => {
    const s = share()
    const event = await buildMeetingShareSignal({ groupId: 'g', seedHex: SEED, share: s })
    expect(event.tags.find((t) => t[0] === 't')?.[1]).toBe(MEETING_SHARE_TYPE)
    expect(await decryptMeetingShare(SEED, event.content)).toEqual(s)
  })

  it('a share carries only a coarse geohash — never raw coordinates', async () => {
    const s = share({ geohash: 'gcpvj0', precision: 6 })
    const event = await buildMeetingShareSignal({ groupId: 'g', seedHex: SEED, share: s })
    // The ciphertext is opaque, but the decrypted payload must not smuggle lat/lon.
    const decrypted = await decryptMeetingShare(SEED, event.content)
    expect(decrypted).not.toHaveProperty('lat')
    expect(decrypted).not.toHaveProperty('lon')
    expect(decrypted.geohash).toBe('gcpvj0')
  })

  it('the wrong group seed cannot decrypt either signal', async () => {
    const reqEvent = await buildMeetingRequestSignal({ groupId: 'g', seedHex: SEED, request: req() })
    const shareEvent = await buildMeetingShareSignal({ groupId: 'g', seedHex: SEED, share: share() })
    await expect(decryptMeetingRequest('f'.repeat(64), reqEvent.content)).rejects.toThrow()
    await expect(decryptMeetingShare('f'.repeat(64), shareEvent.content)).rejects.toThrow()
  })

  it('rejects an invalid meeting request', async () => {
    await expect(buildMeetingRequestSignal({ groupId: 'g', seedHex: SEED, request: req({ setBy: 'nope' }) })).rejects.toThrow(/setBy/)
    await expect(buildMeetingRequestSignal({ groupId: 'g', seedHex: SEED, request: req({ mode: 'teleport' as MeetingRequest['mode'] }) })).rejects.toThrow(/mode/)
    await expect(buildMeetingRequestSignal({ groupId: 'g', seedHex: SEED, request: req({ maxTimeMinutes: 0 }) })).rejects.toThrow(/maxTimeMinutes/)
  })

  it('rejects an invalid meeting share', async () => {
    await expect(buildMeetingShareSignal({ groupId: 'g', seedHex: SEED, share: share({ member: 'nope' }) })).rejects.toThrow(/member/)
    await expect(buildMeetingShareSignal({ groupId: 'g', seedHex: SEED, share: share({ geohash: '' }) })).rejects.toThrow(/geohash/)
    await expect(buildMeetingShareSignal({ groupId: 'g', seedHex: SEED, share: share({ precision: 0 }) })).rejects.toThrow(/precision/)
    await expect(buildMeetingShareSignal({ groupId: 'g', seedHex: SEED, share: share({ precision: 12 }) })).rejects.toThrow(/precision/)
  })
})
