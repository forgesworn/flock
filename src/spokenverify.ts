/**
 * Spoken pick-up verification — "is this really my parent, and are they safe?"
 *
 * A face-to-face, on-device, **zero-relay** identity check for a pick-up. Both
 * people derive the same rotating word from the shared circle seed + a time-based
 * counter (canary-kit / spoken-token), so the collector reads a word aloud and the
 * child's phone verifies it locally — nothing is published, no metadata, no battery
 * (squarely on the minimal-footprint north star). An impostor who lacks the seed
 * cannot produce the word.
 *
 * Coercion resistance: every member also has a *duress* word, collision-avoided so
 * it can never equal a verification word. Under coercion the collector reads their
 * duress word instead; it is indistinguishable from an ordinary word to an onlooker,
 * but the verifier's app recognises it and can silently raise the circle's `help`
 * alarm — naming who is under duress — while showing the coercer an ordinary "✓".
 *
 * Pure and framework-free (mirrors `policy.ts`): the caller supplies the current
 * `counter` — from canary `getCounter()` at the edge — and the circle roster; this
 * module only derives and classifies words and never touches the network. The
 * duress → alarm transport reuses the existing `help` signal path (distinct duress
 * key), keeping encryption and transport at the edge.
 */

import { deriveVerificationWord, deriveDuressWord, verifyWord, getCounter, type VerifyStatus } from 'canary-kit'

/**
 * flock's spoken-verify parameters, fixed in ONE audited place.
 *
 * `rotationSeconds` is how often the word changes; both devices derive the same
 * counter from it (see {@link spokenCounter}), so it must be identical on both — a
 * per-flock constant, deliberately NOT canary's 7-day default. An ephemeral,
 * device-derived word can't be extracted from a child in advance ("what's your
 * family's safe word?"), which is the whole coercion-resistance point; an hour is
 * fresh yet stable across a "prove it's me → walk over → check" pick-up.
 *
 * `tolerance` is the counter drift accepted between two phones' clocks (±1 interval,
 * i.e. ±1 hour — generous for clock skew). It MUST be identical on the derive side
 * (duress-word collision avoidance) and the verify side, or a duress word could
 * collide with a normal one at an adjacent counter and the silent alarm would be
 * suppressed (see canary `deriveDuressToken`). Both sides below read it from here.
 */
export const SPOKEN_VERIFY = {
  /** Single word — quick and unambiguous to say at a door. */
  wordCount: 1,
  /** Accept ±1 rotation interval of clock skew between the two devices. */
  tolerance: 1,
  /** Word rotation period (seconds). One hour — fresh, but stable across a pick-up. */
  rotationSeconds: 3600,
} as const

/**
 * The counter both devices derive from `now` (unix seconds) using flock's fixed
 * rotation period — so a shower and a checker agree without any round-trip. Pure
 * (mirrors how `policy.ts` takes `now`); the caller supplies the clock.
 */
export function spokenCounter(nowSec: number): number {
  return getCounter(nowSec, SPOKEN_VERIFY.rotationSeconds)
}

/** The pair of words a member can read aloud to prove who they are. */
export interface SpokenWords {
  /** Read this when it is safe — the shared verification word for this moment. */
  verify: string
  /** Read this INSTEAD under coercion — ordinary-looking, silently raises the alarm. */
  duress: string
}

/**
 * Derive the current verification and duress words for `memberPubkey` in a circle.
 *
 * `memberPubkeys` is the full roster, needed so the duress word avoids colliding
 * with any member's tokens. The same `counter` on both devices yields the same
 * verification word (all members derive it identically).
 */
export function spokenWordsFor(
  seedHex: string,
  memberPubkey: string,
  counter: number,
  memberPubkeys: readonly string[],
): SpokenWords {
  return {
    verify: deriveVerificationWord(seedHex, counter),
    duress: deriveDuressWord(seedHex, memberPubkey, counter, SPOKEN_VERIFY.tolerance, [...memberPubkeys]),
  }
}

/** The outcome of checking a word someone spoke during a pick-up. */
export interface SpokenCheck {
  /**
   * - `verified` — the current word; this is really them.
   * - `stale`    — a correct word from an adjacent time window (clocks a beat apart);
   *                still proves they hold the seed, so the UI should treat it as a pass.
   * - `duress`   — a member's duress word: they are being coerced. The UI MUST look
   *                identical to `verified`; raise `help` for {@link duressMembers} silently.
   * - `failed`   — no match; they cannot prove they belong to the circle.
   */
  status: VerifyStatus
  /** On `duress`, the member(s) whose duress word matched — raise help for these. Empty otherwise. */
  duressMembers: string[]
}

/**
 * Classify a word someone spoke against the circle.
 *
 * ALWAYS checks the full roster so a duress word from ANY member is caught
 * (CANARY-DURESS: never short-circuit on the first match). The caller must pass
 * every member, not a subset — a missing member is a duress word that would go
 * undetected.
 */
export function checkSpokenWord(
  spoken: string,
  seedHex: string,
  memberPubkeys: readonly string[],
  counter: number,
): SpokenCheck {
  const result = verifyWord(
    spoken,
    seedHex,
    [...memberPubkeys],
    counter,
    SPOKEN_VERIFY.wordCount,
    SPOKEN_VERIFY.tolerance,
  )
  return { status: result.status, duressMembers: result.members ?? [] }
}
