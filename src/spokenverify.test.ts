import { describe, it, expect } from 'vitest'
import { deriveVerificationWord } from 'canary-kit'
import {
  spokenWordsFor,
  checkSpokenWord,
  spokenCounter,
  estimateSpokenVerificationRisk,
  SPOKEN_VERIFY,
} from './spokenverify.js'

// Deterministic fixtures — patterned hex is valid HMAC input (no curve check).
const SEED = 'a'.repeat(64)
const ALICE = '11'.repeat(32)
const BOB = '22'.repeat(32)
const CAROL = '33'.repeat(32)
const MEMBERS = [ALICE, BOB, CAROL] as const
const C = 1000

describe('spokenWordsFor', () => {
  it('the verify word is the circle verification word for that counter', () => {
    expect(spokenWordsFor(SEED, ALICE, C, MEMBERS).verify).toBe(deriveVerificationWord(SEED, C))
  })

  it('the duress word is distinct from the verify word', () => {
    const w = spokenWordsFor(SEED, ALICE, C, MEMBERS)
    expect(w.duress).not.toBe(w.verify)
  })

  it('a member can round-trip their own duress word to a duress verdict', () => {
    const spoken = spokenWordsFor(SEED, ALICE, C, MEMBERS).duress
    expect(checkSpokenWord(spoken, SEED, MEMBERS, C).status).toBe('duress')
  })
})

describe('checkSpokenWord', () => {
  it('verifies the current verification word', () => {
    const r = checkSpokenWord(deriveVerificationWord(SEED, C), SEED, MEMBERS, C)
    expect(r.status).toBe('verified')
    expect(r.duressMembers).toEqual([])
  })

  it('flags a member’s duress word and attributes it to that member', () => {
    const spoken = spokenWordsFor(SEED, BOB, C, MEMBERS).duress
    const r = checkSpokenWord(spoken, SEED, MEMBERS, C)
    expect(r.status).toBe('duress')
    expect(r.duressMembers).toContain(BOB)
  })

  it('catches a duress word from ANY member, including the last in the roster (CANARY-DURESS)', () => {
    const spoken = spokenWordsFor(SEED, CAROL, C, MEMBERS).duress
    const r = checkSpokenWord(spoken, SEED, MEMBERS, C)
    expect(r.status).toBe('duress')
    expect(r.duressMembers).toContain(CAROL)
  })

  it('rejects an unknown word', () => {
    const r = checkSpokenWord('notacirclewordatall', SEED, MEMBERS, C)
    expect(r.status).toBe('failed')
    expect(r.duressMembers).toEqual([])
  })

  it('is case-insensitive and trims surrounding whitespace', () => {
    const spoken = `  ${deriveVerificationWord(SEED, C).toUpperCase()}  `
    expect(checkSpokenWord(spoken, SEED, MEMBERS, C).status).toBe('verified')
  })

  it('tolerates a single counter of clock drift (still proves the seed)', () => {
    const spoken = deriveVerificationWord(SEED, C) // shown at C
    const r = checkSpokenWord(spoken, SEED, MEMBERS, C + 1) // verifier a beat ahead
    expect(r.status).not.toBe('failed')
    expect(['verified', 'stale']).toContain(r.status)
  })

  it('rejects a word from far outside the tolerance window', () => {
    const spoken = deriveVerificationWord(SEED, C)
    expect(checkSpokenWord(spoken, SEED, MEMBERS, C + 50).status).toBe('failed')
  })

  it('an empty or blank input never verifies', () => {
    expect(checkSpokenWord('', SEED, MEMBERS, C).status).toBe('failed')
    expect(checkSpokenWord('   ', SEED, MEMBERS, C).status).toBe('failed')
  })

  // ── Security invariants — the whole point of the feature ─────────────────────
  it('SAFETY: every member’s duress word reads as duress, never plain verified (the silent alarm must survive)', () => {
    for (const m of MEMBERS) {
      const d = spokenWordsFor(SEED, m, C, MEMBERS).duress
      expect(checkSpokenWord(d, SEED, MEMBERS, C).status).toBe('duress')
    }
  })

  it('SAFETY: the verification word never reads as duress (no false alarm)', () => {
    expect(checkSpokenWord(deriveVerificationWord(SEED, C), SEED, MEMBERS, C).status).not.toBe('duress')
  })
})

describe('spokenCounter', () => {
  it('is floor(now / rotationSeconds), so both devices in the same window agree', () => {
    const r = SPOKEN_VERIFY.rotationSeconds
    expect(spokenCounter(100 * r)).toBe(100)
    expect(spokenCounter(100 * r + r - 1)).toBe(100) // anywhere in the window → same counter
    expect(spokenCounter(101 * r)).toBe(101) // next window
  })

  it('two clocks a few seconds apart in the same window derive the same word', () => {
    const t = 5_000 * SPOKEN_VERIFY.rotationSeconds + 12
    const a = spokenWordsFor(SEED, ALICE, spokenCounter(t), MEMBERS).verify
    const b = spokenWordsFor(SEED, ALICE, spokenCounter(t + 8), MEMBERS).verify
    expect(a).toBe(b)
  })

  it('does not rotate faster than flock’s fixed period (not canary’s 7-day default)', () => {
    expect(SPOKEN_VERIFY.rotationSeconds).toBe(3600)
  })
})

describe('SPOKEN_VERIFY parameters', () => {
  it('fixes a single word and a symmetric drift tolerance in one place', () => {
    expect(SPOKEN_VERIFY.wordCount).toBe(1)
    expect(SPOKEN_VERIFY.tolerance).toBeGreaterThanOrEqual(1)
  })

  it('locks the accepted candidate budget for the current circle roster', () => {
    const risk = estimateSpokenVerificationRisk(MEMBERS)
    expect(risk.candidates).toBe(21)
    expect(risk.groupCandidates).toBe(3)
    expect(risk.normalIdentityCandidates).toBe(9)
    expect(risk.duressCandidates).toBe(9)
    expect(risk.tokenSpace).toBe(2048)
    expect(risk.singleAttemptSuccessProbability).toBeLessThan(0.011)
  })

  it('shows why very large one-word rosters need app-level throttling or longer phrases', () => {
    const risk = estimateSpokenVerificationRisk(100)
    expect(risk.candidates).toBe(603)
    expect(risk.singleAttemptSuccessProbability).toBeGreaterThan(0.25)
    expect(risk.singleAttemptSuccessProbability).toBeLessThan(0.26)
  })
})
