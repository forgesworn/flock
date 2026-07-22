# Radar architecture review — placement, correctness, meatchat

**Date:** 2026-07-22 · **Status:** review + one actionable hardening plan · **Scope:** flock-kit, flock app+native, capacitor-mesh-ble, mesh-kit, meatchat

## Verdict: the architecture is fundamentally sound

Radar follows a clean **functional-core / imperative-shell** split:
- **flock-kit** (`radar.ts`, `radarSession.ts`) — pure, deterministic decision logic
  (guidance state, mode machine, heading engine, cue grammar, honesty gates, BLE
  bands, session rules). No I/O, no `Date.now()`, "now" and positions are inputs.
- **flock app** (`radarMode.ts`, `radarView.ts`, `radarSession.ts`) — the controller:
  DOM, Web Audio, vibration, speech, sensors, wake lock, session wire glue.
- **flock native** (`RadarCore.kt` + `RadarGuideService.kt`) — a hand-maintained
  Kotlin port of the pure core, pinned to the TS by **golden vectors**, plus the
  locked-phone foreground service.

This is the right shape for a cross-runtime (JS + Kotlin) feature that must behave
identically on a live screen and a locked phone. The golden-vector parity harness is
the correct mechanism and is genuinely comprehensive for the pure core (23 vector
groups incl. guidance/mode/heading/cue/ble/clock/session).

## The one real placement gap: voice announce-PRIORITY is un-pinned decision logic

`announceVoice` — the policy deciding WHICH voice event wins each tick (arrived →
mode → compass → degraded → ble-close → moved → milestone → bearing-change →
periodic, with rate floors and one-shot flags) — is **hand-duplicated** in
`app/src/radarMode.ts` (~line 702) and `RadarGuideService.kt` (~line 501), with
**no unit test and no golden-vector group**. Every other radar decision is pinned;
this one is not.

- **Current state: NOT a bug.** Diffed both implementations line-by-line
  (2026-07-22): identical ordering and conditions. No drift today.
- **Risk: future drift.** Two hand-synced copies of subtle priority logic (timers,
  one-shot flags, per-event rate floors) will eventually diverge on the next edit,
  and nothing would catch it — exactly the failure the vector harness prevents
  everywhere else.
- **Right home: the kit.** The ORDERING + CONDITIONS are pure (a function of the
  guidance state, the last tick's remembered state, and timing booleans). Only
  `playVoice` (audio + rate limit) and the state-flag writes are impure.

### Extraction plan (behaviour-preserving)

1. **flock-kit** new pure `selectVoiceEvent(input): VoiceSelection | null`:
   - `input`: `{ state, lastState, mode, lastAnnouncedMode, headingStatus,
     lastHeadingStatus, bleClose, lastBleClose, spokenClockHour, lastSpokenClockHour,
     movedAnnouncePending, bearingUsable, distanceMetres, lastDistance, periodicDue }`
     (all pure; the controller computes `periodicDue = now - lastPeriodicAtMs ≥
     periodicVoiceSec·1000`).
   - returns `{ event: VoiceEvent, rate: 'urgent'|'direction'|'general',
     countsAsPeriodic: boolean, consumeMoved: boolean } | null` — composes the
     existing pure `crossedMilestone` / `speakableDistanceMetres` for the
     distance-carrying events.
2. **Golden vectors:** a `voiceSelect` group generated from the current JS behaviour
   (so the extraction is behaviour-preserving by construction), asserted in
   `RadarCoreTest.kt`.
3. **Rewire both controllers** to: compute the booleans → call `selectVoiceEvent` →
   apply effects (`playVoice`, stamp `lastPeriodicAtMs` on a successful play, clear
   `movedAnnouncePending` when `consumeMoved`). Delete the hand-rolled ladders.
4. Verify: kit unit tests, `RadarCoreTest`, JS suite, `radarSession`/`radar` e2e.

Non-urgent (no current defect); do it as its own focused slice so the field-tuned
voice UX is preserved and diffs stay reviewable.

## Right-libs verdicts (checked, mostly correct)

- **BLE RSSI proximity in `capacitor-mesh-ble` (shared plugin) — KEEP, with a note.**
  Only flock uses it; meatchat neither imports nor references RSSI. But RSSI is a
  property of the BLE *link the plugin owns* — a consumer cannot obtain it without
  the plugin surfacing it — and it is opt-in (off by default, zero cost to meatchat).
  So it belongs at the transport layer, not in a flock-native module. The honesty
  gate (`MeshBleWire.shouldAttributeRssi`: no attribution while relaying) is likewise
  a correct property of the plugin's OWN contract ("attributed to an identified
  peer" cannot hold across relays, for ANY consumer), not flock policy. Verdict:
  correctly placed; document it as a flock-only surface of the shared plugin.
- **`radarSession.ts` in flock-kit — correct.** Pure session rules; the kit IS
  flock's shared lib, and it's cleanly pure/testable/vector-pinned.
- **Kotlin parity via golden vectors — correct**, with the announce gap above and
  one cleanup: the deprecated `vectorDirectionPhrase` is dead in the app yet still
  ported to Kotlin, exported (via `export *`), and vector-pinned. Remove it (kit +
  Kotlin + `directionPhrase` vectors) and curate the kit's wildcard export to an
  explicit surface.

## meatchat consideration

- **Signed-presence is the shared CONCEPT, not shared CODE — and that's defensible.**
  meatchat's `announce.ts` (`verifyAnnounce`, BIP-340 Schnorr over persona+venue+
  nonce) solves the same root problem radar's planned verified-attribution fix needs:
  *the BLE transport's claimed `from` is untrustworthy*. But the two apps have
  **different trust models** — meatchat authenticates a lightweight persona announce;
  flock already gets a seal-verified sender for free from its NIP-59 gift-wrap unwrap
  (`dispatchWrap` success). Verdict: radar's verified-attribution fix should use
  flock's OWN seal-author-on-unwrap (see 2026-07-22-ble-attribution-authentication.md,
  Approach A), NOT adopt meatchat's announce — forcing a shared primitive across two
  distinct trust models would be over-abstraction. Cross-reference announce.ts as
  prior art; don't couple them.
- **Proximity is a false cognate.** meatchat's `ambient.ts proximity` (0..1, for
  match scoring, NOT RSSI-derived) and radar's RSSI physical-ranging bands are
  legitimately separate concerns. No shared abstraction warranted.
- **The recent RSSI change is safe for meatchat** — it doesn't use RSSI, and it pins
  an OLDER plugin SHA (`c29c1d17`) than flock (`42a0519`), so the change doesn't even
  reach it. **But that divergence is a hygiene issue:** the "shared" plugin isn't
  kept in lockstep across consumers; a security-relevant plugin fix only lands where
  someone re-pins. Recommend a periodic shared-lib pin-sync across flock + meatchat.

## World-class (unchanged from the competitive review, now grounded)

Radar owns the unclaimed position (spoken/stereo/haptic guidance to a moving person,
locked-phone, honesty-gated, E2E, no account, no hardware). The remaining gaps to
"definitively best" are product, not architecture: **iOS locked-mode** (biggest),
and restoring **crowd-mode BLE assist** via the verified-attribution fix. The
architecture is ready for both.
