// BLE-nearby transport bridge (Capacitor shell) — first rung of the off-relay
// ladder (docs/plans/2026-07-04-ble-nearby-transport.md).
//
// flock's signals are opaque NIP-59 gift wraps (kind:1059). This moves those wrap
// bytes phone-to-phone over Bluetooth LE when circle members are co-located — no
// relay, no internet. It is STRICTLY ADDITIVE: the app only ever calls this from
// inside the native shell with the opt-in flag on, and the relay path never
// depends on it (see app.ts). The shared capacitor-mesh-ble package does
// discovery, GATT, chunking and dedup; this is Flock's thin policy seam.
//
// Discovery identity: the app passes a ROTATING, circle-seed-derived UUID as both
// `serviceUuid` (advertised) and `room` (so the plugin's room-hash advert bytes
// also rotate) — nothing static ever hits the air (app/src/bleId.ts).

import { MeshBle } from 'capacitor-mesh-ble'
import type { MeshBleRssiSample, MeshBleStartRssiSamplingOptions } from 'capacitor-mesh-ble'
import type { PluginListenerHandle } from '@capacitor/core'
import {
  MESH_SYNC_KIND,
  meshScopedToken,
  withMeshReliability,
  type MeshFrame,
  type MeshReliabilityPolicy,
  type MeshReliabilityStats,
  type RunningMeshReliability,
} from 'mesh-kit'

let frameHandle: PluginListenerHandle | null = null
let peerHandle: PluginListenerHandle | null = null
let reliability: RunningMeshReliability | null = null
let reliabilitySubscription: { close(): void } | null = null
let running = false

const GIFT_WRAP_KIND = 'flock-gift-wrap'
const RELIABILITY_WIRE_KEY = '_flockMeshSync'

interface ReliabilityWireFrame {
  _flockMeshSync: 1
  frame: MeshFrame
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function wrapId(frame: MeshFrame): string | null {
  if (frame.kind !== GIFT_WRAP_KIND || typeof frame.payload !== 'string') return null
  try {
    const event = JSON.parse(frame.payload) as Record<string, unknown>
    return typeof event.id === 'string' && /^[0-9a-f]{64}$/.test(event.id) ? event.id : null
  } catch {
    return null
  }
}

/** Exported for compatibility tests; product policy remains encrypted-wrap only. */
export function flockMeshReliabilityPolicy(room: string): MeshReliabilityPolicy {
  return {
    frameId: wrapId,
    retention: (frame) => wrapId(frame) === null ? null : { ttlSeconds: 15 * 60 },
    inventoryToken: (id) => meshScopedToken(`flock/reliability-room/v1:${room}`, id),
  }
}

/**
 * Preserve the deployed v1 gift-wrap wire exactly. Only mesh-kit controls use
 * the reserved wrapper, so an older client ignores them yet still receives
 * every normal NIP-59 event byte-for-byte.
 */
export function encodeBleReliabilityFrame(frame: MeshFrame): string {
  if (frame.kind === GIFT_WRAP_KIND && typeof frame.payload === 'string') return frame.payload
  return JSON.stringify({ [RELIABILITY_WIRE_KEY]: 1, frame } satisfies ReliabilityWireFrame)
}

/** Decode a v2 control, or treat any legacy/raw payload as a normal gift wrap. */
export function decodeBleReliabilityFrame(data: string, from: string): MeshFrame {
  try {
    const wire = record(JSON.parse(data))
    const frame = record(wire?.[RELIABILITY_WIRE_KEY] === 1 ? wire.frame : null)
    if (frame?.kind === MESH_SYNC_KIND && typeof frame.kind === 'string') {
      return { kind: frame.kind, payload: frame.payload, from }
    }
  } catch {
    // Raw legacy gift wraps are handled below.
  }
  return { kind: GIFT_WRAP_KIND, payload: data, from }
}

/** Start BLE-nearby. `serviceUuid === room ===` the discovery UUID — the rotating
 *  members-only advertId (discreet mode) or the common daily meshUuid (crowd mode);
 *  either way the advert and its room-hash rotate together and nothing static hits
 *  the air. `scanUuids` (optional) widens only the SCAN filter to the neighbouring
 *  windows ({t-1, t, t+1}) so a member whose clock or rotation boundary sits a window
 *  away is still found — we still advertise just `serviceUuid`. `selfId` = my pubkey
 *  (only ever sent inside an established GATT link).
 *  `hops` is the mesh flood budget: 0 (default) = discreet single-hop, >0 = crowd
 *  mesh flood/relay. `onFrame` gets each reassembled wrap payload. Throws if BLE is
 *  unavailable/denied — the caller treats that as "BLE off" and uses the relay. */
export async function startBle(
  opts: {
    room: string
    selfId: string
    serviceUuid: string
    scanUuids?: string[]
    hops?: number
    reconcileGiftWraps?: boolean
  },
  onFrame: (data: string, from: string) => void,
): Promise<void> {
  await stopBle()
  const handlers = new Set<(frame: MeshFrame) => void>()
  const rawTransport = {
    broadcast(frame: MeshFrame): void {
      void MeshBle.broadcast({ data: encodeBleReliabilityFrame(frame) }).catch(() => {})
    },
    send(peer: string, frame: MeshFrame): void {
      void MeshBle.send({ peer, data: encodeBleReliabilityFrame(frame) }).catch(() => {})
    },
    subscribe(handler: (frame: MeshFrame) => void): { close(): void } {
      handlers.add(handler)
      return { close: () => void handlers.delete(handler) }
    },
  }

  if (opts.reconcileGiftWraps) {
    reliability = withMeshReliability({
      selfId: opts.selfId,
      transport: rawTransport,
      policy: flockMeshReliabilityPolicy(opts.room),
      bufferOptions: { maxEntries: 200, ttlSeconds: 15 * 60 },
    })
    reliabilitySubscription = reliability.subscribe((frame) => {
      if (frame.kind === GIFT_WRAP_KIND && typeof frame.payload === 'string') onFrame(frame.payload, frame.from ?? '')
    })
  } else {
    handlers.add((frame) => {
      if (frame.kind === GIFT_WRAP_KIND && typeof frame.payload === 'string') onFrame(frame.payload, frame.from ?? '')
    })
  }

  try {
    frameHandle = await MeshBle.addListener('frame', (event) => {
      if (!event || typeof event.data !== 'string') return
      const frame = decodeBleReliabilityFrame(event.data, typeof event.from === 'string' ? event.from : '')
      for (const handler of [...handlers]) handler(frame)
    })
    if (reliability) {
      peerHandle = await MeshBle.addListener('peer', (event) => {
        if (event.connected && typeof event.peer === 'string') reliability?.sync(event.peer)
      })
    }
    await MeshBle.start({
      room: opts.room,
      selfId: opts.selfId,
      serviceUuid: opts.serviceUuid,
      // Scan a wider window set than we advertise, so a member a rotation window
      // away (clock skew / boundary) is still discovered. The plugin always
      // includes serviceUuid, so passing undefined is the classic single-UUID scan.
      ...(opts.scanUuids && opts.scanUuids.length > 0 ? { scanUuids: opts.scanUuids } : {}),
      ...(opts.hops !== undefined ? { hops: opts.hops } : {}),
    })
    running = true
  } catch (error) {
    await stopBle()
    throw error
  }
}

/** Tear BLE down (idempotent; never throws). */
export async function stopBle(): Promise<void> {
  running = false
  try { await frameHandle?.remove() } catch { /* already gone */ }
  try { await peerHandle?.remove() } catch { /* already gone */ }
  frameHandle = null
  peerHandle = null
  reliabilitySubscription?.close()
  reliabilitySubscription = null
  reliability?.close()
  reliability = null
  try { await MeshBle.stop() } catch { /* not started / older shell */ }
}

/** Broadcast an opaque wrap to in-range circle members. Best-effort, never throws. */
export async function broadcastBle(data: string): Promise<void> {
  if (!running) return
  if (reliability) {
    reliability.broadcast({ kind: GIFT_WRAP_KIND, payload: data })
    return
  }
  try { await MeshBle.broadcast({ data }) } catch { /* no peers / adapter off */ }
}

export function bleRunning(): boolean {
  return running
}

// ── Observability seam (diagnostics) ─────────────────────────────────────────
// The shared plugin already tracks advertise/scan/GATT state, peer links and
// per-frame TX/RX counts; the product path never needed to read them, but the
// BLE diagnostics screen (app/src/ble-diagnostics.ts) does. These are thin,
// additive reads over the same MeshBle instance — no product behaviour changes.

/** Snapshot the live transport status (fields per capacitor-mesh-ble's getStatus). */
export async function getBleStatus(): Promise<Record<string, unknown>> {
  return (await MeshBle.getStatus()) as unknown as Record<string, unknown>
}

/** Subscribe to plugin status pushes. Returns a handle; call `.remove()` to stop. */
export async function addBleStatusListener(
  onStatus: (status: Record<string, unknown>) => void,
): Promise<PluginListenerHandle> {
  return MeshBle.addListener('status', (e) => onStatus(e as unknown as Record<string, unknown>))
}

/** Directed send to a single peer id. Diagnostics only — the product path floods
 *  via broadcastBle; this exercises the plugin's point-to-point write. Never throws. */
export async function sendBle(peer: string, data: string): Promise<void> {
  if (!running) return
  if (reliability) {
    reliability.send(peer, { kind: GIFT_WRAP_KIND, payload: data })
    return
  }
  try { await MeshBle.send({ peer, data }) } catch { /* no such peer / adapter off */ }
}

export function getBleReliabilityStats(): MeshReliabilityStats | null {
  return reliability?.stats() ?? null
}

// ── RSSI proximity (radar Phase 3) ───────────────────────────────────────────
// Off by default (battery cost) — a caller (radarMode.ts) turns sampling on
// only while it has an identified member target to attribute samples to, and
// stops it unconditionally when done. Samples are attributed by the plugin
// ONLY to a peer id already bound by a prior in-room frame exchange — never
// to a raw, unauthenticated advert.

/** Turn on periodic RSSI sampling. Idempotent (re-calling just updates the
 *  interval); a no-op on iOS/web/older shells. */
export async function startRssiSampling(opts: MeshBleStartRssiSamplingOptions = {}): Promise<void> {
  try { await MeshBle.startRssiSampling(opts) } catch { /* android only / older shell */ }
}

/** Stop RSSI sampling. Idempotent — safe even if never started. */
export async function stopRssiSampling(): Promise<void> {
  try { await MeshBle.stopRssiSampling() } catch { /* not running */ }
}

/** Subscribe to attributed RSSI samples. Returns a handle; call `.remove()` to
 *  stop. A shell without the event simply never fires it. */
export async function addRssiListener(
  onRssi: (sample: MeshBleRssiSample) => void,
): Promise<PluginListenerHandle> {
  return MeshBle.addListener('rssi', (e) => onRssi(e))
}
