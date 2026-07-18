// Public compatibility vectors for the native (Kotlin) publish pipeline. Deterministic
// pieces are byte-compared by the Kotlin tests; randomised pieces (AES-GCM,
// NIP-44, full wraps) are verified in the decrypt direction. Regenerate with
// `npm run gen:vectors` ONLY when the wire format deliberately changes.
import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveBeaconKey, encryptBeacon, decryptBeacon } from 'canary-kit'
import { hashGroupId } from 'canary-kit/nostr'
import { encode } from 'geohash-kit'
import { fromNsec, derive } from 'nsec-tree'
import { getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { getConversationKey, encrypt as nip44encrypt, decrypt as nip44decrypt } from 'nostr-tools/nip44'
import { giftWrap, giftUnwrap, rawNip44Decrypt } from '../../app/src/giftwrap'
import { deriveInbox } from '../../app/src/keys'
import { buildLocationSignal } from '@forgesworn/flock'

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), 'vectors.json')
const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const fromHex = (h: string): Uint8Array => Uint8Array.from(h.match(/.{1,2}/g) ?? [], (x) => parseInt(x, 16))

// Fixed inputs — NEVER real keys. Deliberately memorable filler.
const identitySkHex = '0101010101010101010101010101010101010101010101010101010101010101'
const seedHex = '0202020202020202020202020202020202020202020202020202020202020202'
const circleId = 'a1b2c3d4'

const GEOHASH_CASES = [
  { lat: 51.5007, lon: -0.1246, precision: 6 },
  { lat: 51.5007, lon: -0.1246, precision: 9 },
  { lat: -33.8568, lon: 151.2153, precision: 7 },
  { lat: 0, lon: 0, precision: 3 },
  { lat: 89.999, lon: 179.999, precision: 8 },
]
const DERIVE_CASES = [
  { purpose: 'flock:inbox', index: 0 },
  { purpose: 'flock:circle:a1b2c3d4', index: 0 },
  { purpose: 'flock:circle:a1b2c3d4', index: 3 },
]

async function build(): Promise<Record<string, unknown>> {
  const identityPkHex = getPublicKey(fromHex(identitySkHex))
  const inbox = deriveInbox(seedHex)
  const root = fromNsec(fromHex(seedHex))
  const signer = {
    pubkey: identityPkHex,
    nip44Encrypt: (peerPk: string, plaintext: string) =>
      nip44encrypt(plaintext, getConversationKey(fromHex(identitySkHex), peerPk)),
    signEvent: (tmpl: { kind: number; content: string; tags: string[][]; created_at: number }) =>
      finalizeEvent(tmpl, fromHex(identitySkHex)),
  }
  const unsigned = await buildLocationSignal({ groupId: circleId, seedHex, signalType: 'beacon', geohash: 'gcpuvp', precision: 6 })
  const wrap = await giftWrap(signer as never, inbox.pk, unsigned)
  return {
    identitySkHex, identityPkHex, seedHex, circleId,
    inbox: { skHex: toHex(inbox.sk), pkHex: inbox.pk },
    beaconKeyHex: toHex(deriveBeaconKey(seedHex)),
    groupIdHash: hashGroupId(circleId),
    geohash: GEOHASH_CASES.map((c) => ({ ...c, expected: encode(c.lat, c.lon, c.precision) })),
    derive: DERIVE_CASES.map((c) => {
      const id = derive(root, c.purpose, c.index)
      return { ...c, skHex: toHex(id.privateKey), pkHex: toHex(id.publicKey) }
    }),
    beaconCiphertexts: await (async () => {
      // encryptBeacon stamps its own Date.now() timestamp — decrypt to learn it
      // so the committed vector self-describes the expected payload exactly.
      const key = deriveBeaconKey(seedHex)
      const ciphertextB64 = await encryptBeacon(key, 'gcpuvp', 6)
      const payload = await decryptBeacon(key, ciphertextB64)
      return [{ geohash: 'gcpuvp', precision: 6, timestamp: payload.timestamp, ciphertextB64 }]
    })(),
    nip44: [{
      senderSkHex: identitySkHex, recipientPkHex: inbox.pk, plaintext: 'flock vector',
      ciphertext: nip44encrypt('flock vector', getConversationKey(fromHex(identitySkHex), inbox.pk)),
    }],
    wraps: [{ wrapJson: wrap, expect: { rumorKind: 20078, rumorPubkey: identityPkHex, geohash: 'gcpuvp', precision: 6 } }],
  }
}

describe('native golden vectors', () => {
  it('generates or verifies vectors.json', async () => {
    const fresh = await build()
    if (process.env.FLOCK_GEN_VECTORS === '1' || !existsSync(OUT)) {
      writeFileSync(OUT, JSON.stringify(fresh, null, 2) + '\n')
    }
    const v = JSON.parse(readFileSync(OUT, 'utf8')) as typeof fresh & Record<string, never>
    // Deterministic pieces must still match the JS implementations exactly.
    expect(v.inbox).toEqual(fresh.inbox)
    expect(v.beaconKeyHex).toEqual(fresh.beaconKeyHex)
    expect(v.groupIdHash).toEqual(fresh.groupIdHash)
    expect(v.geohash).toEqual(fresh.geohash)
    expect(v.derive).toEqual(fresh.derive)
    // Randomised pieces: the committed samples must still decrypt via JS.
    const beaconKey = deriveBeaconKey(seedHex)
    for (const b of v.beaconCiphertexts as { ciphertextB64: string; geohash: string; precision: number; timestamp: number }[]) {
      const p = await decryptBeacon(beaconKey, b.ciphertextB64)
      expect(p).toEqual({ geohash: b.geohash, precision: b.precision, timestamp: b.timestamp })
    }
    for (const n of v.nip44 as { senderSkHex: string; recipientPkHex: string; plaintext: string; ciphertext: string }[]) {
      expect(nip44decrypt(n.ciphertext, getConversationKey(fromHex(n.senderSkHex), n.recipientPkHex))).toBe(n.plaintext)
    }
    for (const w of v.wraps as { wrapJson: { pubkey: string; content: string }; expect: { rumorKind: number; rumorPubkey: string } }[]) {
      const inboxSk = fromHex((v.inbox as { skHex: string }).skHex)
      const rumor = await giftUnwrap(rawNip44Decrypt(inboxSk), w.wrapJson)
      expect(rumor?.kind).toBe(w.expect.rumorKind)
      expect(rumor?.pubkey).toBe(w.expect.rumorPubkey)
    }
  })
})
