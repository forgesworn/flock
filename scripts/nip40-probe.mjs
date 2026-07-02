// Behavioural NIP-40 probe — flock now RELIES on relays honouring `expiration`
// (every gift wrap carries one; FLOCK.md §6.6), so claimed support (NIP-11) is
// not enough: this publishes two wrap-shaped events — one already expired, one
// expiring in an hour — then REQs both back. An honouring relay rejects or
// suppresses the expired one and returns the live one.
//
//   node scripts/nip40-probe.mjs [wss://relay.example]      (default: relay.trotters.cc)
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { Relay } from 'nostr-tools/relay'

const RELAY_URL = process.argv[2] ?? 'wss://relay.trotters.cc'
const now = Math.floor(Date.now() / 1000)
const sk = generateSecretKey()
const route = getPublicKey(generateSecretKey())

const make = (expiration, marker) =>
  finalizeEvent(
    {
      kind: 1059,
      content: `nip40-probe-${marker}`,
      tags: [['p', route], ['expiration', String(expiration)]],
      created_at: now - 60,
    },
    sk,
  )

const expired = make(now - 30, 'expired')
const live = make(now + 3600, 'live')

const relay = await Relay.connect(RELAY_URL)
const results = { expired: 'accepted', live: 'accepted' }
try {
  await relay.publish(expired)
} catch (e) {
  results.expired = `rejected at publish (${e.message ?? e})`
}
try {
  await relay.publish(live)
} catch (e) {
  results.live = `rejected at publish (${e.message ?? e})`
}

const returned = new Set()
await new Promise((resolve) => {
  const sub = relay.subscribe([{ ids: [expired.id, live.id] }], {
    onevent(e) {
      returned.add(e.id)
    },
    oneose() {
      sub.close()
      resolve()
    },
  })
  setTimeout(resolve, 5000)
})

console.log(`relay:         ${RELAY_URL}`)
console.log('expired event:', results.expired, '| returned by REQ:', returned.has(expired.id))
console.log('live event:   ', results.live, '| returned by REQ:', returned.has(live.id))
const honours = !returned.has(expired.id) && returned.has(live.id)
console.log(honours ? 'VERDICT: honours NIP-40 ✓' : 'VERDICT: does NOT honour NIP-40 ✗ — unsuitable for flock')
relay.close()
process.exit(honours ? 0 : 1)
