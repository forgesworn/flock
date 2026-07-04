import { describe, it, expect } from 'vitest'
import {
  WORD_INVITE,
  wordCodeFromEntropy,
  normaliseWordCode,
  deriveWordCodeSeed,
  wordInviteTag,
  wordInviteParkKey,
  buildWordInviteRef,
  readWordInviteRef,
  buildWordInviteDeletion,
  type WordInviteRef,
} from './wordcode'

describe('word-code invite — speakable code, secret never in the code', () => {
  it('turns entropy into N valid, deterministic words (no modulo bias: 65536 % 2048 = 0)', () => {
    const e = Uint8Array.from([0x00, 0x00, 0xff, 0xff, 0x12, 0x34, 0xab, 0xcd, 0x56, 0x78, 0x9a, 0xbc])
    const a = wordCodeFromEntropy(e)
    const b = wordCodeFromEntropy(e)
    expect(a).toEqual(b)
    expect(a).toHaveLength(WORD_INVITE.words)
    // 6 words (audit F4: bumped from 4 → 66 bits against a logging relay)
    expect(WORD_INVITE.words).toBe(6)
    // every word round-trips through normalisation (i.e. is in the wordlist)
    expect(() => normaliseWordCode(a)).not.toThrow()
  })

  it('normalises spacing/case/hyphens and rejects a non-word', () => {
    const words = wordCodeFromEntropy(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))
    const messy = `  ${words[0].toUpperCase()} ${words[1]}-${words[2]}, ${words[3]}  ${words[4]} ${words[5]}`
    expect(normaliseWordCode(messy)).toEqual(words)
    expect(() => normaliseWordCode('zznotaword banana apple cat dog fish')).toThrow()
  })

  it('derives a stable 64-hex seed per code; different code → different seed', async () => {
    const w1 = wordCodeFromEntropy(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))
    const w2 = wordCodeFromEntropy(Uint8Array.from([9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9]))
    const s1 = await deriveWordCodeSeed(w1)
    const s1again = await deriveWordCodeSeed(w1)
    const s2 = await deriveWordCodeSeed(w2)
    expect(s1).toMatch(/^[0-9a-f]{64}$/)
    expect(s1).toBe(s1again)
    expect(s1).not.toBe(s2)
  })

  it('tag is stable per seed and differs across seeds (so two codes never collide on the relay)', async () => {
    const s1 = await deriveWordCodeSeed(wordCodeFromEntropy(Uint8Array.from([1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6])))
    const s2 = await deriveWordCodeSeed(wordCodeFromEntropy(Uint8Array.from([5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10])))
    expect(wordInviteTag(s1)).toBe(wordInviteTag(s1))
    expect(wordInviteTag(s1)).not.toBe(wordInviteTag(s2))
  })
})

// Audit F4: the parked, code-protected event no longer carries the circle's
// real seed — only a one-time, disposable reference. The actual invite travels
// over the existing full-strength NIP-59 channel (invite.ts), addressed to
// that reference's pubkey. So even a successful offline brute-force of the
// spoken words yields only a handle to fetch ONE already-strongly-encrypted
// event, not the circle secret itself.
describe('buildWordInviteRef / readWordInviteRef — the reference, not the seed', () => {
  const REF = 'ab'.repeat(32)

  it('round-trips the reference: same code decrypts, wrong code cannot', async () => {
    const words = wordCodeFromEntropy(Uint8Array.from([2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24]))
    const seed = await deriveWordCodeSeed(words)
    const ev = await buildWordInviteRef(seed, REF, 1_000_000)
    expect(ev.kind).toBe(WORD_INVITE.kind)
    expect(ev.tags.find((t) => t[0] === 't')?.[1]).toBe(wordInviteTag(seed))
    expect(ev.tags.find((t) => t[0] === 'expiration')?.[1]).toBe(String(1_000_000 + WORD_INVITE.ttlSeconds))
    // the reference itself is not sitting in plaintext on the wire
    expect(ev.content).not.toContain(REF)

    const got: WordInviteRef = await readWordInviteRef(seed, ev)
    expect(got).toEqual({ v: 1, ref: REF })

    const wrongSeed = await deriveWordCodeSeed(wordCodeFromEntropy(Uint8Array.from([3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3])))
    await expect(readWordInviteRef(wrongSeed, ev)).rejects.toThrow()
  })

  it('rejects a malformed reference payload', async () => {
    const seed = await deriveWordCodeSeed(wordCodeFromEntropy(Uint8Array.from([7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7])))
    const ev = await buildWordInviteRef(seed, 'not-hex', 1_000_000)
    await expect(readWordInviteRef(seed, ev)).rejects.toThrow()
  })
})

describe('wordInviteParkKey — deterministic delete-on-fetch signing key', () => {
  it('is deterministic: the same code seed always reconstructs the same key', () => {
    const seed = 'cd'.repeat(32)
    const k1 = wordInviteParkKey(seed)
    const k2 = wordInviteParkKey(seed)
    expect(k1).toEqual(k2)
  })

  it('differs across code seeds (no cross-invite key reuse)', () => {
    const k1 = wordInviteParkKey('11'.repeat(32))
    const k2 = wordInviteParkKey('22'.repeat(32))
    expect(k1).not.toEqual(k2)
  })

  it('is a valid 32-byte secp256k1 scalar (nsec-tree guarantees this)', () => {
    const k = wordInviteParkKey('33'.repeat(32))
    expect(k).toHaveLength(32)
  })

  it('is domain-separated from the circle seed itself (never equals the raw seed bytes)', () => {
    const seed = '44'.repeat(32)
    const k = wordInviteParkKey(seed)
    expect(Buffer.from(k).toString('hex')).not.toBe(seed)
  })
})

describe('buildWordInviteDeletion — NIP-09 delete-on-fetch template', () => {
  it('builds an unsigned kind-5 request tagging the parked event id', () => {
    const tmpl = buildWordInviteDeletion('deadbeef'.repeat(8), 1_000_000)
    expect(tmpl.kind).toBe(5)
    expect(tmpl.created_at).toBe(1_000_000)
    expect(tmpl.tags).toEqual([['e', 'deadbeef'.repeat(8)]])
    expect(tmpl.content).toBe('')
  })
})
