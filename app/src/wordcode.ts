// Speakable invite codes — a 6-word code you can read down the phone or send
// over Signal, without the secret ever living in the code.
//
// The problem: a circle invite carries the 256-bit circle SEED. That can't fit
// in something a human says aloud. So the code is NOT the secret — it's a
// rendezvous token. The inviter parks a one-time REFERENCE, ENCRYPTED, on the
// private relay under a tag only the code can compute; the joiner types the
// code, finds it, and decrypts it. The code stretches (scrypt) into a seed that
// keys canary-kit's audited group crypto (the same AES-256-GCM circles already
// use).
//
// Audit F4 hardening (2026-07-04): the parked event used to carry the real
// circle seed directly, protected only by the code's own entropy — a captured
// ciphertext was brute-forceable offline at leisure, and the 15-min expiry
// defends nothing against a relay that just logs it. Now:
//   1. 6 words (was 4) — 66 bits (was 44) against a logging relay.
//   2. Costlier scrypt — N doubled, so each guess costs twice as much memory/time.
//   3. The parked event carries a fresh, disposable ONE-TIME REFERENCE keypair's
//      secret — never the circle seed. The actual invite (the real seed) travels
//      separately over the EXISTING full-strength NIP-59 gift-wrap channel
//      (app/src/invite.ts), addressed to the reference's pubkey — 256-bit ECDH
//      security that brute-forcing the spoken code does nothing to weaken.
//   4. Delete-on-fetch: the parked reference event's signing key is derived
//      DETERMINISTICALLY from the code seed (wordInviteParkKey), so the joiner —
//      who computes the same code seed from the same spoken words — can
//      reconstruct it and sign a valid NIP-09 deletion for the exact event the
//      inviter published. A relay honouring NIP-09 drops it the moment the
//      legitimate joiner claims it, closing the window an eventual (now far
//      costlier) brute-force could otherwise exploit — legitimate use is a race
//      it wins by seconds, not by cryptographic strength.
// Guessing the tag reveals nothing (a hash); the reference is never derivable
// from the tag or the ciphertext, and even a recovered reference only unlocks
// ONE already-strongly-encrypted, likely-already-deleted event. This is a
// deliberately weaker-but-adequate channel than the 256-bit QR/link — offer both.
//
// Pure + unit-tested (mirrors bleId.ts): callers supply randomness and `now`; the
// app owns signing + transport.

import { scryptAsync } from '@noble/hashes/scrypt.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { getWord, indexOf, WORDLIST, WORDLIST_SIZE } from 'canary-kit'
import { deriveGroupKey, encryptEnvelope, decryptEnvelope, hashGroupTag } from 'canary-kit/sync'
import { derive, fromNsec } from 'nsec-tree'
import { fromHex } from './store'

const enc = new TextEncoder()

export const WORD_INVITE = {
  /** Words in a code. 6 × log2(2048) = 66 bits (audit F4: was 4 words/44 bits). */
  words: 6,
  /** Kind for the parked, code-addressed reference — a plain (not gift-wrapped)
   *  event found by its `t` tag.
   *
   *  Audit F4 correctness fix (2026-07-04): the ORIGINAL kind, 20079, sits in
   *  NIP-01's ephemeral range (20000–29999) — a spec-compliant relay accepts it
   *  (`OK … true`) but never stores it, so a joiner's later REQ finds nothing
   *  (confirmed against the live relay: publish succeeds, a REQ seconds later
   *  for the same `#t` tag returns only EOSE, no event). The NIP-40 `expiration`
   *  tag only means anything for a STORED event, which is exactly the tell that
   *  this was a latent bug, not a design choice. 8078 is a REGULAR kind
   *  (1 ≤ n < 10000, outside the 5000–7000 DVM range) — relays store it like any
   *  other short-lived event and prune it via its own `expiration`, same as
   *  every gift wrap (kind 1059, also regular). Distinct from circle signals
   *  (20078, deliberately ephemeral — a live subscriber is always expected). */
  kind: 8078,
  /** How long the parked reference is valid (NIP-40 expiration). */
  ttlSeconds: 15 * 60,
} as const

// scrypt cost: N=2^17 (~128 MB, audit F4: doubled from 2^16) is memory-hard
// enough to make brute-forcing a 66-bit code impractical, yet completes in
// well under a couple of seconds for the one legitimate derivation. r/p
// standard; 32-byte output keys the parked-reference envelope.
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, dkLen: 32 } as const
// Domain-separated, fixed salt — this KDF has one purpose (mirrors the versioned
// context strings in bleId.ts). Distinct from every circle/beacon/duress key.
const SALT = sha256(enc.encode('flock:wordcode:v1'))

/** Map entropy → `count` words. Reads 2 bytes per word; 65536 % 2048 === 0, so
 *  the modulo is bias-free. Caller supplies crypto-random bytes (>= count*2). */
export function wordCodeFromEntropy(entropy: Uint8Array, count = WORD_INVITE.words): string[] {
  if (entropy.length < count * 2) throw new Error('not enough entropy for the code')
  const words: string[] = []
  for (let i = 0; i < count; i++) {
    words.push(getWord((((entropy[i * 2] << 8) | entropy[i * 2 + 1]) >>> 0) % WORDLIST_SIZE))
  }
  return words
}

/** A fresh code from the platform CSPRNG. */
export function newWordCode(count = WORD_INVITE.words): string[] {
  return wordCodeFromEntropy(crypto.getRandomValues(new Uint8Array(count * 2)), count)
}

/** Words starting with `prefix` — powers a type-ahead so joining only needs a
 *  few letters per word, not the exact full spelling recalled from memory
 *  (mirrors a BIP39 recovery phrase's UX). This wordlist isn't guaranteed
 *  unique at 4 letters the way BIP39's own list is (a handful of pairs like
 *  "beach"/"beacon" share a prefix) — an empty prefix suggests nothing at all
 *  rather than dumping all 2048 words. */
export function suggestWords(prefix: string, limit = 6): string[] {
  const p = prefix.trim().toLowerCase()
  if (!p) return []
  const out: string[] = []
  for (const w of WORDLIST) {
    if (w.startsWith(p)) { out.push(w); if (out.length >= limit) break }
  }
  return out
}

/** Lowercase, split on spaces/commas/hyphens, and validate every word is in the
 *  list. Throws (naming the bad word) so the caller can guide a mistyped code. */
export function normaliseWordCode(input: string | string[]): string[] {
  const words = (Array.isArray(input) ? input : input.split(/[\s,-]+/))
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean)
  if (!words.length) throw new Error('Type the invite words first.')
  for (const w of words) if (indexOf(w) < 0) throw new Error(`"${w}" isn't one of the invite words — check the spelling.`)
  return words
}

/** Stretch a code into a 64-hex group seed (scrypt). Async — the cost is the point. */
export async function deriveWordCodeSeed(words: string | string[]): Promise<string> {
  const canonical = normaliseWordCode(words).join(' ')
  return bytesToHex(await scryptAsync(enc.encode(canonical), SALT, SCRYPT))
}

/** The public relay tag the invite is parked under — a hash of the code seed, so
 *  it reveals nothing and two codes never collide. */
export function wordInviteTag(codeSeedHex: string): string {
  return hashGroupTag(codeSeedHex)
}

/** The ONLY thing parked under the low-entropy spoken code (audit F4): a fresh,
 *  one-time reference key — unrelated to the circle's real seed. `ref` is that
 *  key's raw secret (64-hex); the real invite travels separately, gift-wrapped
 *  to its public key (see app/src/invite.ts's `buildInviteWrap`/`readInviteViaRef`). */
export interface WordInviteRef {
  v: 1
  ref: string
}

/** Build the parked, encrypted, expiring REFERENCE event (unsigned — the caller
 *  signs it with {@link wordInviteParkKey} and publishes to private relays). */
export async function buildWordInviteRef(
  codeSeedHex: string,
  refSkHex: string,
  nowSec: number,
): Promise<{ kind: number; created_at: number; content: string; tags: string[][] }> {
  const payload: WordInviteRef = { v: 1, ref: refSkHex }
  const content = await encryptEnvelope(deriveGroupKey(codeSeedHex), JSON.stringify(payload))
  return {
    kind: WORD_INVITE.kind,
    created_at: nowSec,
    content,
    tags: [
      ['t', wordInviteTag(codeSeedHex)],
      ['expiration', String(nowSec + WORD_INVITE.ttlSeconds)],
    ],
  }
}

/** Decrypt + validate a fetched parked reference. Throws if the code is wrong
 *  (the decrypt fails) or the payload is malformed. */
export async function readWordInviteRef(codeSeedHex: string, event: { content: string }): Promise<WordInviteRef> {
  const json = await decryptEnvelope(deriveGroupKey(codeSeedHex), event.content)
  const o = JSON.parse(json) as WordInviteRef
  if (o.v !== 1 || typeof o.ref !== 'string' || !/^[0-9a-f]{64}$/.test(o.ref)) {
    throw new Error('That invite code is not valid.')
  }
  return o
}

/** Deterministic signing key for the PARKED reference event only — never used
 *  for anything else. Derived from the CODE seed (not the circle seed), so the
 *  joiner — who computes the same code seed from the same spoken words — can
 *  reconstruct it and sign a valid NIP-09 delete-on-fetch for the exact event
 *  the inviter published (see {@link buildWordInviteDeletion}). */
export function wordInviteParkKey(codeSeedHex: string): Uint8Array {
  return derive(fromNsec(fromHex(codeSeedHex)), 'flock:wordcode:parksig:v1').privateKey
}

/** The NIP-09 delete-on-fetch request for the parked reference event — unsigned;
 *  the caller signs it with {@link wordInviteParkKey} and publishes once the real
 *  invite is safely in hand. Best-effort hygiene: a relay that ignores NIP-09
 *  simply leaves the event to expire on its own 15-minute TTL regardless. */
export function buildWordInviteDeletion(
  eventId: string,
  nowSec: number,
): { kind: number; created_at: number; content: string; tags: string[][] } {
  return { kind: 5, created_at: nowSec, content: '', tags: [['e', eventId]] }
}
