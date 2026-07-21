// Rotating, members-only BLE advertising identity — the security keystone of the
// BLE-nearby transport (docs/plans/2026-07-04-ble-nearby-transport.md).
//
// A BLE advertisement with a STABLE identifier is a physical-world device tracker
// — worse than the relay flock exists to avoid. So the advertised 128-bit service
// UUID is derived from the circle seed and the current time window: only circle
// members can compute or recognise it, and to anyone without the seed it is a
// random value that rotates every window and is unlinkable across windows
// (HMAC-SHA256 keyed by the seed → unpredictable without it). Combined with the
// OS's own BLE MAC randomisation, there is no stable identifier at any layer.
//
// Pure + unit-tested; the native BLE plugin only advertises/scans the UUIDs this
// computes. This is exactly the piece meatchat left unsolved (its advert is a
// static UUID) — so it is deliberately NOT copied from there.

import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { fromHex } from './store'

const enc = new TextEncoder()

/** Advert-ID rotation window, seconds. 15 min balances discovery latency (a peer
 *  must land in a nearby window) against how long any single UUID is linkable.
 *  Members tolerate ±1 window for clock skew (see advertIdsToScan). */
export const BLE_WINDOW_SECONDS = 900

/** The window index for a unix-seconds timestamp. */
export function bleWindow(nowSec: number, windowSeconds = BLE_WINDOW_SECONDS): number {
  return Math.floor(nowSec / windowSeconds)
}

/** Milliseconds until the NEXT rotation-window boundary. Schedule the advert re-arm
 *  here so a member's advertId rotates on time — a STABLE UUID is a physical-world
 *  device tracker, worse than the relay this mode exists to avoid. */
export function msUntilNextWindow(nowSec: number, windowSeconds = BLE_WINDOW_SECONDS): number {
  return ((bleWindow(nowSec, windowSeconds) + 1) * windowSeconds - nowSec) * 1000
}

/** Format 16 bytes as a well-formed v4 UUID string (BLE stacks want valid UUIDs).
 *  Pinning 6 version/variant bits costs negligible entropy (122 bits remain). */
function toUuid(bytes: Uint8Array): string {
  const u = bytes.slice(0, 16)
  u[6] = (u[6] & 0x0f) | 0x40 // version 4
  u[8] = (u[8] & 0x3f) | 0x80 // variant 1 (RFC 4122)
  const h = Array.from(u, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

/** The BLE service UUID a member of `seedHex` advertises/recognises in `window`.
 *  Keyed by the circle seed, so only members can compute it and it is unlinkable
 *  across windows to anyone else. */
export function advertId(seedHex: string, window: number): string {
  const mac = hmac(sha256, fromHex(seedHex), enc.encode(`flock:ble-adv:v1:${window}`))
  return toUuid(mac)
}

/** What THIS device advertises now for a circle: the current window's UUID. */
export function advertIdNow(seedHex: string, nowSec: number, windowSeconds = BLE_WINDOW_SECONDS): string {
  return advertId(seedHex, bleWindow(nowSec, windowSeconds))
}

/** The UUIDs to scan-filter for: every circle seed × {t-1, t, t+1} (clock skew).
 *  A match means the peer is a member of that circle in a nearby window. */
export function advertIdsToScan(seedHexes: string[], nowSec: number, windowSeconds = BLE_WINDOW_SECONDS): string[] {
  const w = bleWindow(nowSec, windowSeconds)
  const ids = new Set<string>()
  for (const s of seedHexes) for (const dw of [-1, 0, 1]) ids.add(advertId(s, w + dw))
  return [...ids]
}

// ── Crowd-mesh discovery identity (the second mode) ───────────────────────────
// The rotating advertId above hides flock's presence but is members-only, so two
// people who share a circle yet scan different active circles never find each
// other, and a BLE advert can't carry every circle's UUID. Crowd mode (tied to
// festival "find each other") instead uses ONE common daily UUID so ANY two flock
// phones in range connect; messages stay opaque kind:1059 wraps that flood the
// crowd, and each device decrypts only the circles it's actually in. The cost —
// stated and accepted in the design doc — is a proximity-only presence signal (a
// passive scanner learns "a flock device is near", never who/which circle/what).

/** BLE-mesh discovery epoch, seconds. Daily — coarse enough that the common UUID
 *  is not a permanent beacon, fine enough that every co-located device computes
 *  the same one for the day. Deliberately keyless (crowd mode bridges circles
 *  that share no secret). */
export const BLE_MESH_EPOCH_SECONDS = 86_400

/** The window index for a unix-seconds timestamp, on the daily mesh epoch. */
export function meshEpoch(nowSec: number, epochSeconds = BLE_MESH_EPOCH_SECONDS): number {
  return Math.floor(nowSec / epochSeconds)
}

/** The common crowd-mesh discovery UUID for a daily epoch. No secret, so every
 *  flock device computes the same value for the same day — that is the point:
 *  crowd mode connects across circles that share no seed. Rotates daily (+ OS MAC
 *  randomisation) so it is discoverable-when-present, never a permanent beacon. */
export function meshUuid(epoch: number): string {
  return toUuid(sha256(enc.encode(`flock:ble-mesh:v1:${epoch}`)))
}

/** The crowd-mesh UUID to advertise/scan now (this device's current daily epoch). */
export function meshUuidNow(nowSec: number, epochSeconds = BLE_MESH_EPOCH_SECONDS): string {
  return meshUuid(meshEpoch(nowSec, epochSeconds))
}
