# Radar session — consented liveliness for an active approach

**Date:** 2026-07-21 · **Status:** design · **Owner:** flock-kit (pure session rules) + flock app + native

> **Addendum 2026-07-22 — precision lift SHIPPED.** The first cut lifted cadence
> only, which left a default-precision pair (neighbourhood, ~610 m) reading "rough
> area only" for the whole session — the consent pill promised "share exactly" but
> the radar never got a bearing. Resolved in favour of §"What a session is" (both
> devices publish **Exact**): accepting a session is explicit, informed consent to
> be navigated to (the pill says "share exactly"), so it lifts precision to Exact
> for the window, exactly like the one-shot "come to me" share — implemented as a
> `pickup`-trigger emission at full precision in `autoEmit` (JS) and
> `effectivePrecision` (native), both gated by `sessionUntilSec`. A live session
> also re-tiers the location watch to **high-accuracy GPS** (`desiredHighAccuracy`
> +`syncWatch` on start/end) — without it the lifted precision-9 geohash would
> encode a low-power network fix (precise-looking, imprecise in truth), and a
> default-precision member on `pollLocation` would not even sample promptly enough
> to feel live. Every geography
> cap still applies (a no-report **coarse** zone re-coarsens the lift back to the
> base share, a **withhold** zone withholds, a private posture never beacons). The
> §"Publisher integration" line below about honouring a lowered slider as a ceiling
> is superseded for the ambient slider; an **optional explicit hard cap** ("never
> share finer than X even in live nav") remains a clean future addition and is the
> right home for the "Street-precision member" posture test.
**Parent:** `2026-07-21-radar-worlds-best.md` item B · **Consent posture:** the v1 goal doc's
"Optional active radar session", unchanged: *explicit, time-boxed, visible on the other
device* — radar remains a better way to consume a permitted disclosure, never a new
power to obtain one.

## The problem, precisely

The v2.1 field test's first finding: "the screen doesn't update as they move."
The pipeline is event-driven and correct — but beacons are deliberately
cell-gated and rate-floored (≥ 45 s even at Exact), so between disclosures the
scope only moves with the watcher's own motion. For a passive glance at the map
that is the right privacy trade. For two people actively walking toward each
other it reads as broken, and it is the one axis where every mainstream
competitor (Zenly-style apps, Life360, Totem's ~1 Hz gadget) beats us — see the
competitive landscape doc §8.

The addendum called it correctly: this is a **cadence-policy decision, not a
radar one**. The radar consumes whatever lands; the fix is a consented way to
make more land, briefly.

## What a session is

A **mutual, time-boxed cadence lift between exactly two members**: the seeker
(running radar) and the target. While a session is live, BOTH devices publish
Exact-precision beacons on a session cadence (default floor **5 s**,
movement-triggered above it) to the circle path they already share — nothing
new is published anywhere else, and nothing about the session is visible to the
relay beyond the same gift-wrapped events as ever.

Both sides lift, not just the target: an approach is symmetric (the target's
radar can guide them toward the seeker too — the "come to me" meetup is the
same session viewed from the other end).

## Consent flow

1. **Ask.** From radar (or the member sheet), "Ask for live navigation" sends a
   session *request* — a gift-wrapped signal on the existing pair path carrying
   the proposed TTL (default 15 min). Rate-limited: one open request per pair;
   a new ask replaces, never stacks.
2. **Answer.** The target sees who is asking and for how long. Accept starts
   the session on both ends. **Ignore is the only other action** — there is no
   decline button and no "seen" receipt.
3. **Live.** Both devices show a persistent session pill ("Live with Alex ·
   12 min left · Stop") — the session is never invisible on either device.
   The radar's freshness line reflects the lifted cadence honestly.
4. **End.** Expiry, either side's Stop, or either side going stale ends the
   session. Both ends return to their prior precision/cadence with no residue.

### The coercion analysis (why ignore-only, why no reasons)

The flock principle — *withholding must be indistinguishable from sharing* —
applies to sessions with force, because "answer me" is exactly what a coercive
requester demands:

- **No decline signal.** An ignored request simply expires on the requester's
  side ("no answer"), indistinguishable from a phone in a pocket, a dead
  battery, or no data. Saying no must look identical to not seeing it.
- **No stop reasons.** The requester's UI shows "session ended" identically
  for expiry, the target's Stop, and staleness. Stopping early must not be a
  confession.
- **No-report zones still cap.** A session lifts cadence, never geography
  policy: inside a no-report zone the beacons stay capped/withheld exactly as
  without a session, and the radar keeps saying "private area" honestly.
- **No history.** Requests and sessions leave no log on either device beyond
  the transient state; NIP-40 expirations on every session event.
- **Pre-authorisation is circle-scoped and time-boxed.** A "meetup mode"
  toggle ("anyone in this circle can start live navigation with me *tonight*")
  makes the festival case one-tap, expires on its own clock, and shows the
  same pill while in use. No permanent standing grants — a permanent grant is
  a tracking relationship, which is the product we refuse to be.

## Protocol shape (minimal)

Three signal payloads on the existing encrypted pair path (same wrapping,
NIP-44 + gift wrap, NIP-40 expiration; no new relay-visible anything):

| Signal | Content | Notes |
|---|---|---|
| `radar-session-request` | ttlSec, requestId | expires itself (~2 min) |
| `radar-session-accept` | requestId, ttlSec, startAt | starting both clocks |
| `radar-session-stop` | sessionId | optional courtesy; absence must work (expiry rules) |

Session state lives in a **pure flock-kit module** (`session.ts` or extending
`radar.ts`): request/accept/expire/stop transitions, clock-skew tolerance,
"one open request per pair", and the cadence the publisher should apply —
unit-tested, ported to Kotlin for the locked-phone publisher, pinned by
vectors like the rest of radar.

Publisher integration: the beacon scheduler (JS + native) takes a
`sessionCadenceFloorSec` override while a session is live; precision lifts to
Exact only if the member's own posture allows Exact for that circle — a
session never overrides a posture ceiling (someone locked to Street precision
stays Street; the radar stays honest about it).

## Battery and abuse bounds

- Session cadence floor 5 s, movement-triggered (stationary target ⇒ beacons
  only on the keepalive, ~30 s) — a 15 min session is bounded work.
- TTL hard cap 60 min per session; renewal is a fresh ask (fresh consent).
- One live session per pair; sessions don't stack across circles.
- The lifted cadence obeys the existing outbound budget guards in the native
  publisher (Doze, battery saver) — a session degrades before it drains.

## Acceptance

- Two-phone approach test: with a session live, the seeker's scope/cues track
  the target's walking movement with ≤ ~10 s perceived latency, both locked.
- Ignore test: an unanswered request leaves the requester with "no answer"
  and the target with nothing persistent; relay traffic is indistinguishable
  from normal circle chatter.
- Posture test: a Street-precision member in a session never publishes finer
  than Street, and the seeker's radar says "rough area" exactly as today.
- Stop/expiry indistinguishability: requester UI identical in both cases.

## Implementation slices (follow-up to this doc)

1. flock-kit: pure session rules + vectors.
2. flock app: request/accept UI, session pill, publisher cadence override.
3. flock native: Kotlin session port; cadence override in the background
   publisher; locked-phone parity.
4. FLOCK.md protocol section + PRIVACY.md coercion notes update.
