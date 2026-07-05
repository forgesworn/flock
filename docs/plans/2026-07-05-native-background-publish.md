# Native background publish — the outbound half

**Date:** 2026-07-05 · **Owner:** TBD · **Status:** design approved — open questions
resolved in [`2026-07-05-native-background-publish-design.md`](2026-07-05-native-background-publish-design.md);
root cause confirmed via live field testing

## Why this exists

Live-tested tonight at a real event (two phones, real GPS, real relay,
screen-off/locked for extended stretches). Symptoms across multiple
independent observations, all pointing the same way:

- A member walking with the screen off produced **one position jump** for the
  whole walk, not continuous tracking.
- Android's own location indicator (the status-bar dot) turned **off** the
  moment flock left the foreground, even with sharing on.
- A "your phone was reported lost" signal only surfaced **after** reopening
  the app — never as a background notification, even though the sender's
  publish succeeded and the recipient's phone was unlocked-with-"always"
  location and unrestricted battery (both confirmed on-device before ruling
  them out).
- The moment a foreground, explicit action was taken (tapping "share" on a
  roll-call ask), it worked instantly and correctly.

That last point is the tell: **foreground JS-driven actions work perfectly.
Only the background continuation is unreliable.**

### Root cause, confirmed at the code level

`@capacitor-community/background-geolocation`'s Android implementation
(`node_modules/@capacitor-community/background-geolocation/android/.../BackgroundGeolocation.java`)
receives each fix via a `BroadcastReceiver` in its foreground service — that
part is pure native code and should keep running under Doze same as any
foreground-service watcher. But it delivers the fix to our JS with
`PluginCall.resolve(...)`, which is Capacitor's standard native→JS bridge:
under the hood, a WebView `evaluateJavascript()` call. Android/Chromium
throttles or fully suspends a **backgrounded WebView's JS execution**
(timers, and — the part that matters here — pending bridge callbacks), even
while the hosting process stays alive via the foreground service. The
service surviving does not mean the WebView inside it is still running JS.

So the actual pipeline right now is:

```
native LocationManager fix → BroadcastReceiver (native, reliable)
  → PluginCall.resolve() → WebView.evaluateJavascript()   ← queues/stalls here
    → onFix() → autoEmit() → encrypt → publish             ← never runs until reopened
```

Everything after the stall — cadence gating, no-report zones, NIP-44
encrypt, NIP-59 gift-wrap, the relay publish, `notifyIfHidden()` for inbound
alerts — is pure JS. None of it runs while backgrounded. Not "runs slowly" —
queues until the app is reopened, then runs all at once (the "jump").

This is one half of a problem this repo already partly designed for: see
[`2026-06-30-background-inbound.md`](2026-06-30-background-inbound.md),
which proposes running the **inbound** relay subscription natively inside
the foreground service for exactly the same reason (a backgrounded WebView
can't hold a live socket either). This doc is the **outbound** half — publish,
not subscribe — and the two should end up sharing one native Nostr module
rather than being built as two independent crypto ports.

## What has to move natively

The minimum pipeline that must run **without touching the WebView's JS**:

1. Receive a fix (already native, via the same `BroadcastReceiver`).
2. Decide whether to emit (cadence gate, no-report zones) — `src/policy.ts` /
   `src/cadence.ts` today, pure and already unit-tested.
3. Encode the geohash at the circle's chosen precision.
4. Build + encrypt the beacon payload (NIP-44) with the circle's shared
   beacon key.
5. Build the seal (kind 13, signed) and the outer gift-wrap (kind 1059,
   NIP-44-encrypted again, backdated `created_at`, NIP-40 `expiration` tag).
6. Publish to the configured relay(s) over a WebSocket.

None of steps 2–6 have a Kotlin/Java equivalent in this repo today — this is
a green-field native port, confirmed by inspection: no BouncyCastle,
secp256k1, or Nostr library reference anywhere in `native/` or the Gradle
config, and the existing BLE transport (`FlockBlePlugin.java`) deliberately
never touches crypto — it forwards opaque wrap bytes only.

### Crypto primitives that need a Kotlin (or Rust-via-JNI) equivalent

From `app/src/keys.ts` and `app/src/giftwrap.ts`:

| Primitive | Current JS source | Used for |
|---|---|---|
| secp256k1 ECDH + HKDF (`getConversationKey`) | `nostr-tools/nip44` | NIP-44 conversation key |
| ChaCha20 + HMAC-SHA256, NIP-44 v2 padding | `nostr-tools/nip44` | seal + wrap content encryption |
| Schnorr signing | `nostr-tools/pure` (`finalizeEvent`) | seal + wrap signatures |
| SHA-256 (event id, tags) | `@noble/hashes`, `nostr-tools` | event hashing |
| Deterministic key derivation (`derive(root, label, epoch)`) | `nsec-tree` | `deriveInbox`, `deriveCircleSeed`, the beacon key |

Getting any one of these subtly wrong (wrong HKDF info string, wrong padding,
a byte-order slip) doesn't crash — it silently produces an event the JS side
can't decrypt, which is a **worse** failure mode than today's delay. This is
the reason not to hand-roll this at 1am mid-event; see Verification below.

### The data-access problem (new finding, not in the inbound doc)

`app/src/store.ts` persists everything — identity `skHex`, every circle's
`seedHex`, relay URLs — in plain `localStorage` (Chromium's LevelDB-backed
WebView storage), **not** `@capacitor/preferences` (which is a dependency
already, but only used by the throwaway Phase-0 spike harness). A native
Kotlin background task cannot cheaply read `persisted.identity`/`persisted.circles`
today — it would need to either parse Chromium's on-disk LevelDB format
directly (fragile, undocumented, breaks across Chromium versions) or the
store needs to mirror the minimum needed fields (identity secret key, active
circles' seeds + relay list) into `@capacitor/preferences` (→ Android
`SharedPreferences`, natively readable) whenever they change.

**This interacts with App Lock.** If ciphertext-at-rest (`docs/plans/2026-07-02-app-lock.md`)
is on, the decryption key is PIN-derived and today lives only in JS memory
once unlocked. Mirroring the decrypted seed material into a natively-readable
store for background use means a second, natively-accessible copy of exactly
the material App Lock exists to protect at rest. Options, roughly in order
of preference:
- Mirror into Android's **Keystore-backed EncryptedSharedPreferences**
  (hardware-backed on most devices), written only while unlocked, cleared on
  lock/reset/decoy — same threat model as keeping it in JS memory, arguably
  stronger (Keystore vs. a WebView heap).
  - Not compatible with fully-encrypted state — resolve by degrading to
    foreground-only sharing while locked at rest.

This needs a decision before implementation, not during it.

## Verification strategy (non-negotiable given the stakes)

A native crypto port must not ship on the strength of "it looks right":

1. **Golden-vector cross-checks.** Fix a seed, a fix, and a timestamp; encrypt
   in the existing JS test suite; assert the Kotlin implementation produces
   byte-identical ciphertext (or, since NIP-44 has an authenticated random
   nonce, that it *decrypts* to byte-identical plaintext via the JS decrypt
   path, and vice versa for the derivation-only pieces which are fully
   deterministic and CAN be byte-compared directly).
2. **Round-trip on real hardware**: native-built event → real relay → existing
   JS `onIncoming`/`dispatchWrap` decrypts it with zero special-casing.
3. Extend the existing Phase 0 spike methodology (`2026-06-30-phase0-graphene-spike.md`)
   with a **split measurement**: log fix arrival natively (direct log/file
   write from Kotlin, bypassing the JS bridge) *and* log JS-side reception
   time, so a future regression can distinguish "native sampling stopped"
   from "native sampled fine, JS delivery stalled" — tonight's finding
   suggests the original spike's pass/fail criteria may have had this exact
   blind spot (it can only observe whatever reaches JS).

## Phasing

1. **Design the shared native Nostr module** (crypto primitives + a minimal
   WebSocket publish/subscribe client) — one module serving both this doc's
   outbound need and the existing inbound doc's Option A, not two parallel
   ports.
2. **Resolve the data-access question above** before writing any Kotlin that
   needs seed material.
3. Build outbound-only first (this doc) — smaller and lower-risk than
   inbound, since a failed publish is silent/retried already (`autoEmit`'s
   existing retry-on-next-fix behaviour) rather than a missed alert.
4. Wire the inbound doc's Option A on top of the same module once outbound
   is verified on real hardware.
5. Re-run a Phase-0-style spike with the split-measurement methodology above
   to get a real pass/fail number, not an inference from tonight's symptoms.

## Open questions

- Kotlin hand-rolled crypto (BouncyCastle has ChaCha20/Poly1305 and secp256k1
  primitives) vs. a Rust core (e.g. reuse `nostr-sdk`/`rust-nostr` via JNI/UniFFI,
  which already has audited NIP-44/NIP-59 — likely the safer choice given the
  stakes, at the cost of an NDK build step)?
- Does cadence/no-report-zone policy need full parity natively in v1, or is
  "publish on every distance-filtered fix while backgrounded, let JS-side
  cadence reconcile on next foreground" an acceptable interim (simpler, but
  changes the minimal-footprint battery/relay-traffic story while locked)?
- App Lock + native background access — resolve before implementation (see
  above); may mean background publish is simply unavailable while locked at
  rest, degrading to foreground-only, which should be stated in-app rather
  than silently failing.
