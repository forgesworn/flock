// Reverse golden-vector stage: wraps built by the KOTLIN pipeline must decrypt
// through the untouched JS path with zero special-casing (the design doc's
// criterion). Skips when the Kotlin artefact hasn't been generated
// (`npm run test:native` produces it).
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { giftUnwrap, rawNip44Decrypt } from '../../app/src/giftwrap'
import { deriveBeaconKey, decryptBeacon } from 'canary-kit'

const here = dirname(fileURLToPath(import.meta.url))
const WRAPS = resolve(here, 'kotlin-wraps.json')
const VECTORS = resolve(here, 'vectors.json')
const fromHex = (h: string): Uint8Array => Uint8Array.from(h.match(/.{1,2}/g) ?? [], (x) => parseInt(x, 16))

describe.skipIf(!existsSync(WRAPS))('kotlin-built wraps decrypt via the JS pipeline', () => {
  it('unwraps and decrypts every emitted wrap', async () => {
    const v = JSON.parse(readFileSync(VECTORS, 'utf8'))
    const wraps = JSON.parse(readFileSync(WRAPS, 'utf8')) as {
      wrapJson: { pubkey: string; content: string; kind: number; tags: string[][] }
      expect: { geohash: string; precision: number; t?: string }
    }[]
    expect(wraps.length).toBeGreaterThan(0)
    const inboxSk = fromHex(v.inbox.skHex)
    const beaconKey = deriveBeaconKey(v.seedHex)
    for (const w of wraps) {
      expect(w.wrapJson.kind).toBe(1059)
      const rumor = await giftUnwrap(rawNip44Decrypt(inboxSk), w.wrapJson)
      expect(rumor, 'giftUnwrap returned null — NIP-44 or seal mismatch').not.toBeNull()
      expect(rumor!.kind).toBe(20078)
      expect(rumor!.pubkey).toBe(v.identityPkHex)
      const t = w.expect.t ?? 'beacon'
      expect(rumor!.tags).toEqual([['d', `ssg/${v.groupIdHash}`], ['t', t]])
      // A cover decoy carries only encrypted random filler — a receiver matches no
      // handler for t=cover and drops it WITHOUT decrypting (signals.ts), so we
      // don't decryptBeacon it here either (the filler isn't a valid geohash).
      if (t === 'cover') continue
      const payload = await decryptBeacon(beaconKey, rumor!.content)
      expect(payload.geohash).toBe(w.expect.geohash)
      expect(payload.precision).toBe(w.expect.precision)
    }
  })
})
