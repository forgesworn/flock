import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MESH_SYNC_KIND } from 'mesh-kit'

const sharedBle = vi.hoisted(() => ({
  listeners: new Map<string, (event: any) => void>(),
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  broadcast: vi.fn(async () => ({ queuedPeers: 0 })),
  send: vi.fn(async () => ({ queuedPeers: 0 })),
  getStatus: vi.fn(async () => ({})),
  startRssiSampling: vi.fn(async () => {}),
  stopRssiSampling: vi.fn(async () => {}),
  addListener: vi.fn(async (event: string, listener: (value: any) => void) => {
    sharedBle.listeners.set(event, listener)
    return { remove: async () => void sharedBle.listeners.delete(event) }
  }),
}))

vi.mock('capacitor-mesh-ble', () => ({ MeshBle: sharedBle }))

import {
  armRssiWindow,
  bleMeshRelaying,
  broadcastBle,
  decodeBleReliabilityFrame,
  encodeBleReliabilityFrame,
  flockMeshReliabilityPolicy,
  startBle,
  stopBle,
} from './ble'

const wrap = (idChar: string) => JSON.stringify({
  id: idChar.repeat(64),
  pubkey: 'b'.repeat(64),
  content: 'opaque-nip59-ciphertext',
  sig: 'c'.repeat(128),
})

describe('Flock BLE reconciliation adapter', () => {
  beforeEach(async () => {
    await stopBle()
    vi.clearAllMocks()
    sharedBle.listeners.clear()
  })

  it('keeps deployed gift-wrap bytes unchanged and reserves framing for sync controls', () => {
    const raw = wrap('a')
    expect(encodeBleReliabilityFrame({ kind: 'flock-gift-wrap', payload: raw })).toBe(raw)
    expect(decodeBleReliabilityFrame(raw, 'alice')).toEqual({
      kind: 'flock-gift-wrap',
      payload: raw,
      from: 'alice',
    })

    const encoded = encodeBleReliabilityFrame({ kind: MESH_SYNC_KIND, payload: { v: 1 } })
    expect(JSON.parse(encoded)).toMatchObject({
      _flockMeshSync: 1,
      frame: { kind: MESH_SYNC_KIND, payload: { v: 1 } },
    })
    expect(decodeBleReliabilityFrame(encoded, 'bob')).toEqual({
      kind: MESH_SYNC_KIND,
      payload: { v: 1 },
      from: 'bob',
    })
  })

  it('retains only valid opaque gift wraps and scopes inventory by rotating room', () => {
    const a = flockMeshReliabilityPolicy('room-a')
    const b = flockMeshReliabilityPolicy('room-b')
    const frame = { kind: 'flock-gift-wrap', payload: wrap('d') }
    const id = a.frameId(frame)
    expect(id).toBe('d'.repeat(64))
    expect(a.retention(frame, { direction: 'inbound' })).toEqual({ ttlSeconds: 900 })
    expect(a.inventoryToken?.(id!)).toMatch(/^[0-9a-f]{64}$/)
    expect(a.inventoryToken?.(id!)).not.toBe(b.inventoryToken?.(id!))
    expect(a.retention({ kind: 'presence', payload: '{}' }, { direction: 'inbound' })).toBeNull()
  })

  it('passes a wider scan set to the plugin while advertising only the current UUID', async () => {
    const scanUuids = ['uuid-prev', 'uuid-now', 'uuid-next']
    await startBle({ room: 'uuid-now', selfId: 'alice', serviceUuid: 'uuid-now', scanUuids, hops: 0 }, () => {})
    expect(sharedBle.start).toHaveBeenCalledOnce()
    const opts = (sharedBle.start.mock.calls[0] as unknown as [Record<string, unknown>])[0]
    expect(opts.serviceUuid).toBe('uuid-now') // we advertise only the current window
    expect(opts.scanUuids).toEqual(scanUuids) // but scan the neighbouring windows too
  })

  it('omits scanUuids entirely when none is given (classic single-UUID scan)', async () => {
    await startBle({ room: 'svc', selfId: 'alice', serviceUuid: 'svc' }, () => {})
    const opts = (sharedBle.start.mock.calls[0] as unknown as [Record<string, unknown>])[0]
    expect('scanUuids' in opts).toBe(false)
  })

  it('reconciles on the learned peer route while old clients still receive raw wraps', async () => {
    const received: string[] = []
    await startBle(
      { room: 'room-a', selfId: 'alice', serviceUuid: 'service', hops: 3, reconcileGiftWraps: true },
      (data) => received.push(data),
    )
    const mine = wrap('e')
    await broadcastBle(mine)
    expect(sharedBle.broadcast).toHaveBeenCalledWith({ data: mine })

    sharedBle.listeners.get('peer')?.({ peer: 'bob', connected: true })
    expect(sharedBle.send).toHaveBeenCalledOnce()
    const sendCalls = sharedBle.send.mock.calls as unknown as Array<[{ peer: string; data: string }]>
    expect(sendCalls[0]![0].peer).toBe('bob')
    expect(JSON.parse(sendCalls[0]![0].data)).toMatchObject({
      _flockMeshSync: 1,
      frame: {
        kind: MESH_SYNC_KIND,
        payload: { v: 1, t: 'manifest', ids: [expect.stringMatching(/^[0-9a-f]{64}$/)] },
      },
    })

    const legacyPeerWrap = wrap('f')
    sharedBle.listeners.get('frame')?.({ from: 'old-client', data: legacyPeerWrap })
    expect(received).toEqual([legacyPeerWrap])
  })

  describe('RSSI proximity honesty gate', () => {
    it('does not arm sampling — and never binds the rssi listener — while relaying (crowd/mesh mode)', async () => {
      await startBle({ room: 'mesh', selfId: 'alice', serviceUuid: 'mesh', hops: 3 }, () => {})
      expect(bleMeshRelaying()).toBe(true)
      const w = await armRssiWindow('bob')
      expect(w).toBeNull() // attribution isn't honest across relays — read as "no band"
      expect(sharedBle.startRssiSampling).not.toHaveBeenCalled()
      expect(sharedBle.listeners.has('rssi')).toBe(false)
    })

    it('arms a peer-filtered window on a direct, non-relaying link (discreet mode)', async () => {
      await startBle({ room: 'svc', selfId: 'alice', serviceUuid: 'svc', hops: 0 }, () => {})
      expect(bleMeshRelaying()).toBe(false)
      const w = await armRssiWindow('bob')
      expect(w).not.toBeNull()
      expect(sharedBle.startRssiSampling).toHaveBeenCalledOnce()
      // The window only surfaces samples attributed to the requested peer.
      sharedBle.listeners.get('rssi')?.({ peer: 'carol', address: 'MAC-C', rssi: -50, source: 'gatt', at: Date.now() })
      sharedBle.listeners.get('rssi')?.({ peer: 'bob', address: 'MAC-B', rssi: -55, source: 'gatt', at: Date.now() })
      expect(w!.values()).toEqual([-55])
      w!.stop()
    })

    it('is inert with the mesh off', async () => {
      expect(bleMeshRelaying()).toBe(false)
      expect(await armRssiWindow('bob')).toBeNull() // not running → no band
    })
  })
})
