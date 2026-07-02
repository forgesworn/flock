/**
 * flock quick start — the geofence → policy → signal pipeline, plus a
 * night-out group, presence, and a dead-man's-switch check-in.
 *
 * The library is pure: it decides policy and builds UNSIGNED events. The
 * caller encodes geohashes (geohash-kit), signs (NIP-01, e.g. nostr-tools
 * `finalizeEvent`) and publishes. Run `npm run build` first — the
 * `@forgesworn/flock/*` self-referencing imports resolve to `dist/`.
 */
import { isBreach, type Geofence, type LatLng } from '@forgesworn/flock/geofence'
import { decideEmission, isWithinAnyFence } from '@forgesworn/flock/policy'
import { buildHelpSignal, buildLocationSignal, signalTypeForReason } from '@forgesworn/flock/signals'
import {
  buildNightOutGroupEvent,
  classifyPresence,
  nightOutExpiry,
  stillOut,
  type MemberBeacon,
} from '@forgesworn/flock/nightout'
import { buildCheckInSignal, classifyCheckins, type CheckIn } from '@forgesworn/flock/checkin'
import { encode } from 'geohash-kit'

// Stand-ins for real values: the group id and seed come from canary-kit's
// group lifecycle (`createGroup`, re-exported at the package root); member
// pubkeys are 64-char lowercase hex (nostr).
const groupId = 'demo-circle'
const seedHex = 'a'.repeat(64)
const member = 'b'.repeat(64)

// ── 1. Safe zones — evaluated on-device, coordinates never leave ─────────────
const home: Geofence = {
  kind: 'circle',
  centre: { lat: 51.5074, lon: -0.1278 },
  radiusMetres: 250,
}
const school: Geofence = {
  kind: 'polygon',
  vertices: [
    { lat: 51.5205, lon: -0.13 },
    { lat: 51.5215, lon: -0.13 },
    { lat: 51.521, lon: -0.128 },
  ],
}
const safeZones = [home, school]

// ── 2. A fix arrives ──────────────────────────────────────────────────────────
const fix: LatLng = { lat: 51.5405, lon: -0.1435 }
console.log('breached home fence:', isBreach(fix, home)) // one fence
console.log('inside any safe zone:', isWithinAnyFence(fix, safeZones)) // all fences

// ── 3. The disclosure-on-event decision ───────────────────────────────────────
// Withhold by default; disclose only on breach / pickup / help. An imprecise
// fix near a fence edge never fires a false breach (accuracy-aware).
const plan = decideEmission({
  mode: 'family',
  position: fix,
  geofences: safeZones,
  trigger: 'none',
  accuracyMetres: 15,
})
console.log('plan:', plan) // { action: 'full', precision: 9, reason: 'breach' }

// ── 4. Build the (unsigned) signal the plan calls for ─────────────────────────
const signalType = signalTypeForReason(plan.reason)
if (plan.action !== 'withhold' && signalType && signalType !== 'help') {
  const breachEvent = await buildLocationSignal({
    groupId,
    seedHex,
    signalType, // 'beacon' | 'breach' | 'pickup'
    geohash: encode(fix.lat, fix.lon, plan.precision), // caller encodes
    precision: plan.precision,
  })
  console.log('unsigned kind-%d breach signal ready', breachEvent.kind)
  // → finalizeEvent(breachEvent, secretKey) with nostr-tools, then NIP-59
  //   gift-wrap it (MANDATORY — FLOCK.md §3.3; the PWA uses app/src/giftwrap.ts,
  //   external consumers can use nostr-tools' nip59), then publish the wrap.
}

// ── 5. SOS / help — distinct duress key, maximum precision ────────────────────
const helpEvent = await buildHelpSignal({
  groupId,
  seedHex,
  member,
  location: { geohash: encode(fix.lat, fix.lon, 11), precision: 11, locationSource: 'beacon' },
  // location: null is valid too — a location-less alert still fires.
})
console.log('unsigned help signal ready (kind %d)', helpEvent.kind)

// ── 6. Night out — ephemeral group, presence derived from beacon staleness ────
const startedAt = 1_780_000_000 // unix seconds
const durationSeconds = 6 * 60 * 60
const groupEvent = buildNightOutGroupEvent({
  groupId,
  members: [member],
  encryptedContent: '<caller-encrypted group config (NIP-44)>',
  startedAt,
  durationSeconds,
})
console.log('night-out group expires at', nightOutExpiry(startedAt, durationSeconds))
console.log('group event NIP-40 tags:', groupEvent.tags)

// "Gone home" is derived, not set: a member reads as stale once no beacon has
// been seen for 600 s (default) — indistinguishable from choosing to stop.
const beacons: MemberBeacon[] = [
  { member, timestamp: startedAt + 3_600, geohash: 'gcpvj0', precision: 6 },
]
const presence = classifyPresence(beacons, startedAt + 4_000)
console.log('still out:', stillOut(presence).length, 'of', presence.length)

// ── 7. Dead-man's-switch check-in ─────────────────────────────────────────────
const checkinEvent = await buildCheckInSignal({
  groupId,
  seedHex,
  member,
  intervalSeconds: 30 * 60, // "expect me every 30 minutes"; <= 0 stands down
  timestamp: startedAt,
})
console.log('unsigned check-in ready (kind %d)', checkinEvent.kind)

const seen: CheckIn[] = [{ member, timestamp: startedAt, intervalSeconds: 30 * 60 }]
const states = classifyCheckins(seen, startedAt + 45 * 60)
console.log('check-in status:', states[0]?.status) // 'overdue' (within 300 s grace → then 'missed')
