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
import type { PluginListenerHandle } from '@capacitor/core'

let frameHandle: PluginListenerHandle | null = null
let running = false

/** Start BLE-nearby. `serviceUuid === room ===` the discovery UUID — the rotating
 *  members-only advertId (discreet mode) or the common daily meshUuid (crowd mode);
 *  either way the advert and its room-hash rotate together and nothing static hits
 *  the air. `selfId` = my pubkey (only ever sent inside an established GATT link).
 *  `hops` is the mesh flood budget: 0 (default) = discreet single-hop, >0 = crowd
 *  mesh flood/relay. `onFrame` gets each reassembled wrap payload. Throws if BLE is
 *  unavailable/denied — the caller treats that as "BLE off" and uses the relay. */
export async function startBle(
  opts: { room: string; selfId: string; serviceUuid: string; hops?: number },
  onFrame: (data: string, from: string) => void,
): Promise<void> {
  await stopBle()
  frameHandle = await MeshBle.addListener('frame', (e) => {
    if (e && typeof e.data === 'string') onFrame(e.data, typeof e.from === 'string' ? e.from : '')
  })
  await MeshBle.start(opts)
  running = true
}

/** Tear BLE down (idempotent; never throws). */
export async function stopBle(): Promise<void> {
  running = false
  try { await frameHandle?.remove() } catch { /* already gone */ }
  frameHandle = null
  try { await MeshBle.stop() } catch { /* not started / older shell */ }
}

/** Broadcast an opaque wrap to in-range circle members. Best-effort, never throws. */
export async function broadcastBle(data: string): Promise<void> {
  if (!running) return
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
  try { await MeshBle.send({ peer, data }) } catch { /* no such peer / adapter off */ }
}
