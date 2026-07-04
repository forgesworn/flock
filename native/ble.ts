// BLE-nearby transport bridge (Capacitor shell) — first rung of the off-relay
// ladder (docs/plans/2026-07-04-ble-nearby-transport.md).
//
// flock's signals are opaque NIP-59 gift wraps (kind:1059). This moves those wrap
// bytes phone-to-phone over Bluetooth LE when circle members are co-located — no
// relay, no internet. It is STRICTLY ADDITIVE: the app only ever calls this from
// inside the native shell with the opt-in flag on, and the relay path never
// depends on it (see app.ts). The native FlockBle plugin (ported from meatchat)
// does discovery, GATT, chunking and dedup; this is the thin JS seam.
//
// Discovery identity: the app passes a ROTATING, circle-seed-derived UUID as both
// `serviceUuid` (advertised) and `room` (so the plugin's room-hash advert bytes
// also rotate) — nothing static ever hits the air (app/src/bleId.ts).

import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'

interface FlockBlePlugin {
  start(opts: { room: string; selfId: string; serviceUuid: string; hops?: number }): Promise<void>
  stop(): Promise<void>
  broadcast(opts: { data: string }): Promise<{ queuedPeers?: number }>
  send(opts: { peer: string; data: string }): Promise<void>
  getStatus(): Promise<Record<string, unknown>>
  addListener(event: 'frame', cb: (e: { from: string; data: string }) => void): Promise<PluginListenerHandle>
  addListener(event: 'status', cb: (e: Record<string, unknown>) => void): Promise<PluginListenerHandle>
}

const FlockBle = registerPlugin<FlockBlePlugin>('FlockBle')

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
  frameHandle = await FlockBle.addListener('frame', (e) => {
    if (e && typeof e.data === 'string') onFrame(e.data, typeof e.from === 'string' ? e.from : '')
  })
  await FlockBle.start(opts)
  running = true
}

/** Tear BLE down (idempotent; never throws). */
export async function stopBle(): Promise<void> {
  running = false
  try { await frameHandle?.remove() } catch { /* already gone */ }
  frameHandle = null
  try { await FlockBle.stop() } catch { /* not started / older shell */ }
}

/** Broadcast an opaque wrap to in-range circle members. Best-effort, never throws. */
export async function broadcastBle(data: string): Promise<void> {
  if (!running) return
  try { await FlockBle.broadcast({ data }) } catch { /* no peers / adapter off */ }
}

export function bleRunning(): boolean {
  return running
}
