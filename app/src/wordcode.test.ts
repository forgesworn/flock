import { describe, it, expect } from 'vitest'
import {
  WORD_INVITE,
  wordCodeFromEntropy,
  normaliseWordCode,
  deriveWordCodeSeed,
  wordInviteTag,
  buildWordInvite,
  readWordInvite,
  type WordInvitePayload,
} from './wordcode'

const payload = (): WordInvitePayload => ({ v: 1, id: 'b1b06b12982bb8ed', s: 'a'.repeat(64), n: 'Gaytards', m: 'nightout' })

describe('word-code invite — speakable code, secret never in the code', () => {
  it('turns entropy into N valid, deterministic words (no modulo bias: 65536 % 2048 = 0)', () => {
    const e = Uint8Array.from([0x00, 0x00, 0xff, 0xff, 0x12, 0x34, 0xab, 0xcd])
    const a = wordCodeFromEntropy(e)
    const b = wordCodeFromEntropy(e)
    expect(a).toEqual(b)
    expect(a).toHaveLength(WORD_INVITE.words)
    // every word round-trips through normalisation (i.e. is in the wordlist)
    expect(() => normaliseWordCode(a)).not.toThrow()
  })

  it('normalises spacing/case/hyphens and rejects a non-word', () => {
    const words = wordCodeFromEntropy(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))
    const messy = `  ${words[0].toUpperCase()} ${words[1]}-${words[2]}, ${words[3]}  `
    expect(normaliseWordCode(messy)).toEqual(words)
    expect(() => normaliseWordCode('zznotaword banana apple cat')).toThrow()
  })

  it('derives a stable 64-hex seed per code; different code → different seed', async () => {
    const w1 = wordCodeFromEntropy(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))
    const w2 = wordCodeFromEntropy(Uint8Array.from([9, 9, 9, 9, 9, 9, 9, 9]))
    const s1 = await deriveWordCodeSeed(w1)
    const s1again = await deriveWordCodeSeed(w1)
    const s2 = await deriveWordCodeSeed(w2)
    expect(s1).toMatch(/^[0-9a-f]{64}$/)
    expect(s1).toBe(s1again)
    expect(s1).not.toBe(s2)
  })

  it('round-trips a circle invite: same code decrypts, wrong code cannot', async () => {
    const words = wordCodeFromEntropy(Uint8Array.from([2, 4, 6, 8, 10, 12, 14, 16]))
    const seed = await deriveWordCodeSeed(words)
    const ev = await buildWordInvite(seed, payload(), 1_000_000)
    expect(ev.kind).toBe(WORD_INVITE.kind)
    // parked under a privacy-preserving tag + carries a NIP-40 expiration
    expect(ev.tags.find((t: string[]) => t[0] === 't')?.[1]).toBe(wordInviteTag(seed))
    expect(ev.tags.find((t: string[]) => t[0] === 'expiration')?.[1]).toBe(String(1_000_000 + WORD_INVITE.ttlSeconds))
    // the seed is NOT recoverable from the ciphertext or the tag
    expect(ev.content).not.toContain(payload().s)

    const got = await readWordInvite(seed, ev)
    expect(got).toEqual(payload())

    const wrongSeed = await deriveWordCodeSeed(wordCodeFromEntropy(Uint8Array.from([3, 3, 3, 3, 3, 3, 3, 3])))
    await expect(readWordInvite(wrongSeed, ev)).rejects.toThrow()
  })

  it('tag is stable per seed and differs across seeds (so two codes never collide on the relay)', async () => {
    const s1 = await deriveWordCodeSeed(wordCodeFromEntropy(Uint8Array.from([1, 1, 2, 2, 3, 3, 4, 4])))
    const s2 = await deriveWordCodeSeed(wordCodeFromEntropy(Uint8Array.from([5, 5, 6, 6, 7, 7, 8, 8])))
    expect(wordInviteTag(s1)).toBe(wordInviteTag(s1))
    expect(wordInviteTag(s1)).not.toBe(wordInviteTag(s2))
  })
})
