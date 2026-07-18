// flock — Nostr transport round-trip smoke test.
//
// Proves the full path that matters: a member builds a flock signal, signs it
// (nostr-tools), and a second member verifies the signature and decrypts the
// payload with the flock/canary-kit library — for both a help/duress alert and
// a location beacon.
//
//   npm run smoke                     # in-process round-trip (no network)
//   FLOCK_RELAY=wss://relay.damus.io npm run smoke   # also via a live relay
//
// Run after `npm run build` (the npm script does this for you).

import {
  buildHelpSignal,
  buildLocationSignal,
  buildCheckInSignal,
  decryptCheckIn,
  deriveBeaconKey,
  decryptBeacon,
  deriveDuressKey,
  decryptDuressAlert,
  hashGroupId,
} from '@forgesworn/flock'
import { finalizeEvent, verifyEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { wrapEvent, unwrapEvent } from 'nostr-tools/nip59'

const randHex = (n) =>
  [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('')

function assert(cond, label) {
  if (!cond) { console.error(`✗ ${label}`); process.exit(1) }
  console.log(`✓ ${label}`)
}

const seedHex = randHex(32)
const groupId = 'smoke-circle'
const tTag = (e) => e.tags.find((x) => x[0] === 't')?.[1]

// Two parties.
const skA = generateSecretKey()
const pkA = getPublicKey(skA)

console.log('— in-process round-trip —')

// 1. Help / duress alert with location.
{
  const tmpl = await buildHelpSignal({
    groupId, seedHex, member: pkA,
    location: { geohash: 'gcpuuz', precision: 11, locationSource: 'beacon' },
  })
  const signed = finalizeEvent(tmpl, skA)
  assert(verifyEvent(signed), 'help: signature verifies')
  assert(signed.kind === 20_078 && tTag(signed) === 'help', 'help: kind 20078, t=help')
  const alert = await decryptDuressAlert(deriveDuressKey(seedHex), signed.content)
  assert(alert.member === pkA && alert.geohash === 'gcpuuz' && alert.precision === 11, 'help: decrypts to original alert')
}

// 2. Location beacon (pick-me-up).
{
  const tmpl = await buildLocationSignal({ groupId, seedHex, signalType: 'pickup', geohash: 'gcpuv0', precision: 9 })
  const signed = finalizeEvent(tmpl, skA)
  assert(verifyEvent(signed), 'pickup: signature verifies')
  assert(tTag(signed) === 'pickup', 'pickup: t=pickup')
  const beacon = await decryptBeacon(deriveBeaconKey(seedHex), signed.content)
  assert(beacon.geohash === 'gcpuv0' && beacon.precision === 9, 'pickup: beacon decrypts to original location')
}

// 3. A wrong group seed must NOT decrypt (key isolation).
{
  const tmpl = await buildLocationSignal({ groupId, seedHex, signalType: 'beacon', geohash: 'gcpuuz', precision: 6 })
  const signed = finalizeEvent(tmpl, skA)
  let failed = false
  try { await decryptBeacon(deriveBeaconKey(randHex(32)), signed.content) } catch { failed = true }
  assert(failed, 'wrong seed cannot decrypt the beacon')
}

// 4. Check-in / dead-man's-switch round-trip.
{
  const tmpl = await buildCheckInSignal({ groupId, seedHex, member: pkA, intervalSeconds: 1800, timestamp: 42 })
  const signed = finalizeEvent(tmpl, skA)
  assert(tTag(signed) === 'checkin', 'checkin: t=checkin')
  const ci = await decryptCheckIn(seedHex, signed.content)
  assert(ci.member === pkA && ci.intervalSeconds === 1800 && ci.timestamp === 42, 'checkin: decrypts to original')
}

// 5. Gift-wrapped invite (NIP-59): only the recipient can open the seed.
{
  const skB = generateSecretKey(); const pkB = getPublicKey(skB)
  const payload = { t: 'invite', id: groupId, s: seedHex, n: 'Smoke', m: 'family' }
  const wrap = wrapEvent({ kind: 14, content: JSON.stringify(payload), tags: [] }, skA, pkB)
  assert(wrap.kind === 1059, 'invite: gift wrap is kind 1059')
  const got = JSON.parse(unwrapEvent(wrap, skB).content)
  assert(got.s === seedHex && got.id === groupId, 'invite: recipient unwraps the seed')
  let denied = false
  try { unwrapEvent(wrap, generateSecretKey()) } catch { denied = true }
  assert(denied, 'invite: a non-recipient CANNOT unwrap the seed')
}

// 4. Optional: live relay round-trip.
const relay = process.env.FLOCK_RELAY
if (relay) {
  console.log(`— live relay round-trip (${relay}) —`)
  const { SimplePool } = await import('nostr-tools/pool')
  const pool = new SimplePool()
  const dTag = `ssg/${hashGroupId(groupId)}`
  const tmpl = await buildHelpSignal({
    groupId, seedHex, member: pkA,
    location: { geohash: 'u10hb', precision: 5, locationSource: 'beacon' },
  })
  const signed = finalizeEvent(tmpl, skA)

  const received = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 9000)
    const sub = pool.subscribeMany([relay], { kinds: [20_078], '#d': [dTag], ids: [signed.id] }, {
      onevent: (e) => { clearTimeout(timer); sub.close(); resolve(e) },
    })
    // Give the subscription a moment to register, then publish.
    setTimeout(() => { pool.publish([relay], signed) }, 500)
  })
  // gift-wrap-everything: confirm the relay forwards kind:1059 by #p (the transport
  // every flock signal now rides).
  {
    const skB = generateSecretKey(); const pkB = getPublicKey(skB)
    const gw = wrapEvent({ kind: 14, content: 'hello-inbox', tags: [] }, skA, pkB)
    const got = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 9000)
      const sub = pool.subscribeMany([relay], { kinds: [1059], '#p': [pkB], ids: [gw.id] }, {
        onevent: (e) => { clearTimeout(timer); sub.close(); resolve(e) },
      })
      setTimeout(() => { pool.publish([relay], gw) }, 500)
    })
    if (!got) console.warn('⚠ live relay: kind:1059 #p not received (relay may not forward gift wraps)')
    else {
      const r = unwrapEvent(got, skB)
      assert(r.content === 'hello-inbox', 'live relay: gift-wrap (kind:1059) round-trips by #p — gift-wrap-everything transport OK')
    }
  }

  pool.close([relay])

  if (!received) {
    console.warn('⚠ live relay: no event received within timeout (relay may drop ephemeral kinds, or network is blocked). In-process path is proven above.')
  } else {
    assert(received.id === signed.id, 'live relay: round-tripped our event')
    const alert = await decryptDuressAlert(deriveDuressKey(seedHex), received.content)
    assert(alert.geohash === 'u10hb', 'live relay: payload decrypts after round-trip')
  }
}

console.log('\n✓ smoke test passed')
process.exit(0)
