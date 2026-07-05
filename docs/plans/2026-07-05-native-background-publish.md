# Native background publish — the outbound half

**Date:** 2026-07-05 · **Owner:** TBD · **Status:** design — confirmed root cause via live field testing, not yet built

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

## Goal

Restore reliable screen-off sharing on Android/GrapheneOS by moving only the
active-circle `fix → disclosure policy → geohash → canary-kit beacon
encryption → NIP-59 gift-wrap → relay publish` path into one native module,
while preserving JS protocol compatibility, App Lock / decoy teardown, Tor
fail-loud behaviour, and local-vs-Signet signer semantics.

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

Everything after the stall — cadence gating, no-report zones, canary-kit beacon
encryption, NIP-59 / NIP-44 gift-wrap, the relay publish, `notifyIfHidden()` for
inbound alerts — is pure JS. None of it runs while backgrounded. Not "runs
slowly" — queues until the app is reopened, then runs all at once (the "jump").

This is one half of a problem this repo already partly designed for: see
[`2026-06-30-background-inbound.md`](2026-06-30-background-inbound.md),
which proposes running the **inbound** relay subscription natively inside
the foreground service for exactly the same reason (a backgrounded WebView
can't hold a live socket either). This doc is the **outbound** half — publish,
not subscribe — and the two should end up sharing one native Nostr module
rather than being built as two independent crypto ports.

## Why keep the native surface minimal (scope discipline)

This port is deliberately the *smallest* pipeline that restores background
reliability — not a first step toward a native app. Every primitive ported
here must stay **byte-identical to the JS implementation forever**, or
native-built and web-built clients silently stop being able to decrypt each
other's events. That lockstep-crypto tax is real, so the design goal is to pay
it in **exactly one shared native module** and nowhere else.

Framed that way, this module is the firewall against a full native-Kotlin
rewrite. A whole-app fork would duplicate the entire ~4,500-LOC policy/protocol
brain (geofence, policy, signals, nightout, checkin, cadence, wordcode, invite,
giftwrap) in a second language and keep *all* of it in crypto lockstep — a
permanent doubling, not a one-time port. Containing the native surface to this
module keeps the TS brain the single source of truth. A full fork is only worth
revisiting if (a) a Phase-0 spike shows Capacitor can't hit reliability targets
*even with this native pipeline in place*, or (b) native UX / Keystore-grade
at-rest security becomes a first-class priority — at which point this module is
the de-risked starting point, not wasted work.

## What has to move natively

The minimum pipeline that must run **without touching the WebView's JS**:

1. Receive a fix (already native, via the same `BroadcastReceiver`).
2. Decide whether to emit (disclosure policy, no-report zones, cadence gate) —
   `src/policy.ts` and `app/src/cadence.ts` today, pure and already unit-tested.
3. Encode the geohash at the circle's chosen precision.
4. Build + encrypt the beacon payload with canary-kit's beacon layer
   (`deriveBeaconKey` + AES-256-GCM), using the circle seed.
5. Build the seal (kind 13, signed) and the outer gift-wrap (kind 1059,
   NIP-44-encrypted, backdated `created_at`, NIP-40 `expiration` tag).
6. Publish to the configured relay(s) over a WebSocket.

None of steps 2–6 have a Kotlin/Java equivalent in this repo today — this is
a green-field native port, confirmed by inspection: no BouncyCastle,
secp256k1, or Nostr library reference anywhere in `native/` or the Gradle
config, and the existing BLE transport (`FlockBlePlugin.java`) deliberately
never touches crypto — it forwards opaque wrap bytes only.

### Crypto primitives that need a Kotlin (or Rust-via-JNI) equivalent

From `src/signals.ts`, `app/src/keys.ts`, `app/src/giftwrap.ts`, and
`app/src/signer.ts`:

| Primitive | Current JS source | Used for |
|---|---|---|
| HMAC-SHA256 beacon-key derivation | `canary-kit` (`deriveBeaconKey`) | inner location beacon key |
| AES-256-GCM, 12-byte IV + auth tag | `canary-kit` (`encryptBeacon`) | inner geohash/precision/timestamp payload |
| secp256k1 ECDH + HKDF (`getConversationKey`) | `nostr-tools/nip44` | NIP-44 conversation key |
| ChaCha20 + HMAC-SHA256, NIP-44 v2 padding | `nostr-tools/nip44` | seal + wrap content encryption |
| Schnorr signing | `nostr-tools/pure` (`finalizeEvent`) | seal + wrap signatures |
| SHA-256 (event id, tags) | `@noble/hashes`, `nostr-tools` | event hashing |
| Deterministic key derivation (`derive(root, label, epoch)`) | `nsec-tree` | `deriveInbox`, `deriveCircleSeed` |

Getting any one of these subtly wrong (wrong HKDF info string, wrong padding,
a byte-order slip) doesn't crash — it silently produces an event the JS side
can't decrypt, which is a **worse** failure mode than today's delay. This is
the reason not to hand-roll this at 1am mid-event; see Verification below.

**Also needs a native port, but *not* crypto-lockstep-sensitive:** geohash
encoding at the circle's chosen precision (step 3), today `geohash-kit`. It's a
standard, well-specified algorithm — a wrong result mis-places a pin, it
doesn't produce an undecryptable event — so it carries none of the
byte-identical risk above. But combined with the crypto and a minimal WebSocket
client, it confirms this is a **standalone native module/project** (phasing
step 1), not a handful of scattered ports.

### The data-access problem (new finding, not in the inbound doc)

`app/src/store.ts` persists everything — identity `skHex`, every circle's
`seedHex`, relay URLs — in plain `localStorage` (Chromium's LevelDB-backed
WebView storage), **not** `@capacitor/preferences` (which is a dependency
already, but only used by the throwaway Phase-0 spike harness). A native
Kotlin background task cannot cheaply read `persisted.identity`/`persisted.circles`
today — it would need to either parse Chromium's on-disk LevelDB format
directly (fragile, undocumented, breaks across Chromium versions) or the
store needs to mirror an explicit native background-publish profile into a
natively readable store whenever the active sharing surface changes.

That profile must be a narrow contract, not a dump of `Persisted`. Minimum
fields:

- local signing secret + pubkey **only when** `authMethod === 'local'` and
  `identity.skHex` exists (see Signet caveat below),
- active circle id, current seed, expiry, base share precision, temporary
  festival/exact-share deadline, and the no-report zones needed for disclosure
  policy,
- last beacon / cover cadence state and the tuning constants needed to match
  JS publish cadence,
- already-resolved relay route. If Tor is enabled but the onion/Orbot route is
  not ready, JS must not write a clearnet fallback profile; native publish is
  disabled until the route is valid.

It must **not** include chat history, DMs, petnames, public profile cache,
cached member presence, full message history, or unrelated settings. Inbound
all-circle subscriptions may need a separate all-circle inbox profile later;
this outbound profile should mirror only what the active sharing toggle can
publish.

The mirror must be refreshed or cleared on every lifecycle edge that changes
the authority to publish: start/stop sharing, active-circle switch, precision or
festival changes, no-report-zone changes, relay/Tor changes, circle expiry,
leave/disband, reseed/member removal, reset, App Lock wipe, and decoy hide.

### Signet / remote-signer caveat

`Identity.skHex` exists only for local-key identities. A Signet / NIP-46 / NIP-07
/ Amber identity is pubkey-only in flock's persisted state; the key stays in the
external signer. Native background publish still has to sign the NIP-59 seal as
the real member, or recipients will attribute the beacon to the wrong pubkey.

So v1 has two honest choices:

- support native background publish only for local-key identities, and degrade
  Signet users to foreground-only publishing with clear UI copy; or
- build a native Signet/NIP-46 session path capable of background signing and
  NIP-44 encryption before claiming Signet works screen-off.

Do **not** replace the sender with a circle-derived key just to avoid the
signer problem. That would change both attribution and protocol semantics.

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
   in the existing JS test suite; assert the Kotlin/Rust implementation matches
   the JS contract. Deterministic pieces (`deriveInbox`, `deriveCircleSeed`,
   `deriveBeaconKey`, event ids) can be byte-compared directly. Randomised
   pieces (AES-GCM IV, NIP-44 nonce, NIP-59 backdating) must round-trip both
   ways: native-built event decrypts through existing JS, JS-built event decrypts
   through native.
2. **Round-trip on real hardware**: native-built event → real relay → existing
   JS `onIncoming`/`dispatchWrap` decrypts it with zero special-casing.
3. **Revocation tests**: stop-sharing, reset, App Lock wipe, decoy hide,
   leave/disband, circle expiry, and reseed/member removal clear or rewrite the
   native profile before another background fix can publish.
4. **Route tests**: when Tor is enabled but no `.onion` relay / Orbot route is
   ready, native publish fails closed and never silently uses clearnet.
5. **No-report and cadence tests**: background publish respects no-report zones,
   active precision/festival boosts, movement gating, heartbeat cadence, and
   cover traffic just like foreground `autoEmit`.
6. Extend the existing Phase 0 spike methodology (`2026-06-30-phase0-graphene-spike.md`)
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
3. Define and wire the native background-publish profile + teardown hooks before
   enabling any native publish path.
4. Build outbound-only first (this doc) — smaller and lower-risk than
   inbound, since a failed publish is silent/retried already (`autoEmit`'s
   existing retry-on-next-fix behaviour) rather than a missed alert.
5. Wire the inbound doc's Option A on top of the same module once outbound
   is verified on real hardware.
6. Re-run a Phase-0-style spike with the split-measurement methodology above
   to get a real pass/fail number, not an inference from tonight's symptoms.

## Open questions

- Kotlin hand-rolled crypto (BouncyCastle has ChaCha20/Poly1305 and secp256k1
  primitives) vs. a Rust core (e.g. reuse `nostr-sdk`/`rust-nostr` via JNI/UniFFI,
  which already has audited NIP-44/NIP-59 — likely the safer choice given the
  stakes, at the cost of an NDK build step)? A Rust core also gets geohash
  off-the-shelf (the `geohash` crate) alongside `rust-nostr`'s audited crypto,
  rather than hand-porting `geohash-kit` *and* leaning on BouncyCastle — so the
  geohash requirement (above) is a further mark in the Rust core's favour.
- Does cadence/no-report-zone policy need full parity natively in v1, or is
  "publish on every distance-filtered fix while backgrounded, let JS-side
  cadence reconcile on next foreground" an acceptable interim (simpler, but
  changes the minimal-footprint battery/relay-traffic story while locked)?
- App Lock + native background access — resolve before implementation (see
  above); may mean background publish is simply unavailable while locked at
  rest, degrading to foreground-only, which should be stated in-app rather
  than silently failing.
- Local-key-only v1 vs. native Signet/NIP-46 support — decide before claiming
  background publish works for external-signer users.
- Exact fallback behaviour when the native profile is absent/stale: should the
  foreground service keep sampling for diagnostics, or stop the watcher entirely
  so the persistent notification cannot imply sharing is working?

## Non-goals for this doc

- Signal-style chat, DMs, buzz notifications, and inbound alert delivery. Those
  belong to `2026-06-30-background-inbound.md` and should reuse the same native
  Nostr module only after outbound publish is verified.
- Remote "start sharing". Background publish only continues an already-active,
  local sharing decision.
- Broad native rewrite of the app. The TypeScript policy/protocol brain remains
  the source of truth; native exists here only because Android suspends the
  WebView pipeline while the screen is off.
