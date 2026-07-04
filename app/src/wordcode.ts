// Speakable invite codes — a 4-word code you can read down the phone or send
// over Signal, without the secret ever living in the code.
//
// The problem: a circle invite carries the 256-bit circle SEED. That can't fit
// in something a human says aloud. So the code is NOT the secret — it's a
// rendezvous token. The inviter parks the real invite, ENCRYPTED, on the private
// relay under a tag only the code can compute; the joiner types the code, finds
// it, and decrypts it. The code stretches (scrypt) into a seed that keys
// canary-kit's audited group crypto (the same AES-256-GCM circles already use).
//
// Secrecy: 4 words from the 2048-word spoken-token list = 44 bits. On its own
// that's guessable, so three things guard it: (1) scrypt (memory-hard) makes each
// guess expensive, (2) the parked invite carries a NIP-40 15-min expiry and is
// single-use, (3) it goes ONLY to no-log private relays (see the relay strategy),
// so the ciphertext isn't there to harvest. Guessing the tag reveals nothing (a
// hash); the seed is never derivable from the tag or the ciphertext. This is a
// deliberately weaker-but-adequate channel than the 256-bit QR/link — offer both.
//
// Pure + unit-tested (mirrors bleId.ts): callers supply randomness and `now`; the
// app owns signing + transport.

import { scryptAsync } from '@noble/hashes/scrypt.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { getWord, indexOf, WORDLIST_SIZE } from 'canary-kit'
import { deriveGroupKey, encryptEnvelope, decryptEnvelope, hashGroupTag } from 'canary-kit/sync'

const enc = new TextEncoder()

export const WORD_INVITE = {
  /** Words in a code. 4 × log2(2048) = 44 bits. */
  words: 4,
  /** Kind for the parked, code-addressed invite — a plain (not gift-wrapped)
   *  event found by its `t` tag. Distinct from circle signals (20078). */
  kind: 20_079,
  /** How long the parked invite is valid (NIP-40 expiration). */
  ttlSeconds: 15 * 60,
} as const

// scrypt cost: N=2^16 (~64 MB) is memory-hard enough to make brute-forcing a
// 44-bit code impractical, yet completes in well under a second for the one
// legitimate derivation. r/p standard; 32-byte output = a group seed.
const SCRYPT = { N: 2 ** 16, r: 8, p: 1, dkLen: 32 } as const
// Domain-separated, fixed salt — this KDF has one purpose (mirrors the versioned
// context strings in bleId.ts). Distinct from every circle/beacon/duress key.
const SALT = sha256(enc.encode('flock:wordcode:v1'))

/** The circle facts a code hands over — the same shape as a link/QR invite. */
export interface WordInvitePayload {
  v: 1
  id: string
  /** Circle seed (64-hex). */
  s: string
  n: string
  m: string
  x?: number
}

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

/** Build the parked, encrypted, expiring invite event (unsigned — the app signs
 *  it with a throwaway key and publishes to private relays). */
export async function buildWordInvite(
  codeSeedHex: string,
  payload: WordInvitePayload,
  nowSec: number,
): Promise<{ kind: number; created_at: number; content: string; tags: string[][] }> {
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

/** Decrypt + validate a fetched parked invite. Throws if the code is wrong (the
 *  decrypt fails) or the payload is malformed. */
export async function readWordInvite(codeSeedHex: string, event: { content: string }): Promise<WordInvitePayload> {
  const json = await decryptEnvelope(deriveGroupKey(codeSeedHex), event.content)
  const o = JSON.parse(json) as WordInvitePayload
  if (o.v !== 1 || typeof o.s !== 'string' || o.s.length !== 64 || typeof o.id !== 'string') {
    throw new Error('That invite code is not valid.')
  }
  return o
}
