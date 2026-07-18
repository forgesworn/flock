# Native background publish — design (outbound half)

**Date:** 2026-07-05 · **Status:** approved design — resolves the open questions in
[`2026-07-05-native-background-publish.md`](2026-07-05-native-background-publish.md)

## Decisions (the three "resolve before implementation" questions)

1. **Crypto stack: rust-nostr official Android bindings.**
   `org.rust-nostr:nostr-sdk` **0.44.2** from Maven Central — a plain Gradle AAR
   dependency, **no NDK build step** (the doc's assumed cost of the Rust option
   turned out not to apply: prebuilt bindings exist). It matches the `nostr` 0.44
   pin already used across the workspace (`stash-rs`, `heartwoodd`,
   `signet-nip46-client`). Everything else the pipeline needs — HMAC-SHA256
   (nsec-tree + beacon-key derivation), SHA-256 (group-id hash, event ids),
   AES-256-GCM (the beacon payload itself) — is platform `javax.crypto`. The only
   primitives taken from rust-nostr are the ones that must not be hand-rolled:
   secp256k1 Schnorr keys/signing and NIP-44 v2 encrypt/decrypt. The `-jvm`
   artifact (`nostr-sdk-jvm`) lets the golden-vector tests run as plain JVM JUnit
   tests, no device required.

2. **Data access: Keystore-backed EncryptedSharedPreferences mirror.**
   JS mirrors the *minimum* config into `androidx.security`
   EncryptedSharedPreferences (hardware-backed Keystore on most devices)
   whenever it changes while unlocked. The mirror is **persistent** — that is
   the point: a killed process's native task must read it without the WebView.
   It is cleared on stop-sharing, decoy hide, reset, switch to a Signet
   identity, and on the next open into the app-lock screen (see App Lock
   interaction). Signet and Tor identities never populate it (no local seal key /
   no native Orbot route), so they degrade to foreground-only — the app says so
   rather than silently failing.

3. **Policy parity in v1: no-report zones + cadence gate.**
   Both pure gates are ported natively: **no-report zones** (security-critical —
   a private place must hold while the phone is locked, and with native publish
   this is no longer trivially guaranteed by background silence) and the
   **`shouldEmitBeacon` cadence gate with jitter** (same relay-traffic story as
   foreground). Cover traffic and adaptive sampling are explicitly **not**
   ported in v1 — follow-ups, noted in Out of scope.

## Scope

Android shell only. While the app is backgrounded or the screen is locked,
automatic location beacons for the **active circle** continue to publish
natively — same policy, same wire format, indistinguishable on the relay from
foreground publishes. Manual/foreground actions (SOS, pick-up, roll-call
replies) are untouched: they are explicit taps, so the WebView is running.

## Architecture

```
native LocationManager fix → BroadcastReceiver (plugin foreground service)
  ├─ PluginCall.resolve() → WebView → onFix() → autoEmit()   (unchanged; owns FOREGROUND)
  └─ [patch] package-scoped broadcast → FlockFixReceiver      (new; owns BACKGROUND)
       → FlockPublisher (Kotlin):
           app in foreground? → drop (JS owns it)
           config from EncryptedSharedPreferences (absent → idle)
           off-grid check → no-report zones → geohash encode
           → cadence gate (state persisted) → beacon AES-256-GCM (javax.crypto)
           → kind-20078 event → inbox derivation (nsec-tree HMAC port
             + rust-nostr Keys) → NIP-59 seal + wrap (rust-nostr NIP-44 +
             Schnorr, backdated created_at, NIP-40 expiry)
           → OkHttp WebSocket per relay, await ["OK"] → journal entry
```

### Fix source — patch the community plugin

`@capacitor-community/background-geolocation` stays the watcher (permissions,
distance filter, staleness already handled). `native/patch-android.mjs` — which
already rewrites the generated project on every build — additionally patches the
plugin's `BackgroundGeolocation.java` so each fix is *also* sent as an
in-process, package-scoped broadcast (`Intent.setPackage(...)`, extras: lat,
lon, accuracy, time). ~4 inserted lines at the same point that calls
`PluginCall.resolve(...)`; the JS bridge delivery is untouched. The patch
**asserts on its anchor string and fails the build loudly** if a plugin update
moves it — never a silent no-op. The plugin lives in its own Gradle module, so
the broadcast (not a class reference) is what keeps it decoupled from app code.

### Mutual exclusion with the JS pipeline

`FlockPublisher` acts **only while the app process is not in the foreground**
(`ProcessLifecycleOwner`, `androidx.lifecycle-process`). Foregrounded → JS
`autoEmit` owns publishing exactly as today. Backgrounded → the WebView is
suspended (the confirmed root cause), so only native runs. The only overlap is
the brief grace period right after backgrounding where the WebView may still
execute; the worst case is one duplicate beacon of the identical cell, which
receivers already tolerate (a pin refresh).

### Native pipeline detail (Kotlin, committed in `native/android-src/`)

Per fix, for the mirrored active circle:

1. **Off-grid**: `offGridUntil` in the future → drop.
2. **No-report zones**: port of the `decideEmission`/no-report subset used by
   `autoEmit` (mode pinned `nightout`, trigger `none`): inside a zone → withhold
   or cap precision, identically to `src/policy.ts` + `src/noreport.ts`.
3. **Geohash encode** at the circle's share precision (festival override
   respected via the mirrored `festivalUntil`): a small Kotlin port of
   geohash-kit's `encode`, golden-vector tested.
4. **Cadence gate**: port of `shouldEmitBeacon` + `jitteredSeconds`
   (`app/src/cadence.ts` — pure, already unit-tested in JS). State
   (`lastGeohash`, `lastSentAt` per circle) persists in the same encrypted
   prefs, so it survives process restarts.
5. **Beacon payload**: `{geohash, precision, timestamp}` JSON, AES-256-GCM with
   `HMAC-SHA256(seed, BEACON_KEY_INFO)` — byte-identical to canary-kit's
   `encryptBeacon` (12-byte IV prepended, base64).
6. **Signal event**: kind 20078, `d: ssg/<SHA256(groupId)>`, `t: beacon` —
   canary-kit's `buildSignalEvent`.
7. **Inbox derivation**: nsec-tree port — `fromNsec` intermediate HMAC
   (`HMAC-SHA256(key=seed, msg="nsec-tree-root")`) then `derive(root,
   "flock:inbox", 0)` (domain-prefixed HMAC, big-endian index, retry-on-invalid-
   scalar via rust-nostr key validation). Public keys via rust-nostr `Keys`;
   no hand-rolled curve math anywhere.
8. **Gift wrap** (`app/src/giftwrap.ts` semantics): rumor from the identity
   pubkey → seal kind 13 signed with the identity key, NIP-44 to the inbox
   pubkey, backdated `created_at` (0–2 days) → wrap kind 1059 from a fresh
   ephemeral key, NIP-44 again, tags `[p, inboxPk]` +
   `[expiration, created_at + 16d]`, backdated `created_at`. NIP-44 + Schnorr
   via rust-nostr.
9. **Publish**: short-lived OkHttp WebSocket per relay URL, send
   `["EVENT", wrap]`, await `["OK", id, true]` with a timeout; success = ≥1
   relay accepted. Behind a small `RelayPublisher` interface so the inbound
   doc's Option A can swap in rust-nostr's pooled client later.
10. **Journal**: append `{circleId, geohash, precision, sentAt, relaysAccepted}`
    plus fix-arrival timestamps (the split-measurement log) to the encrypted
    prefs, capped.

On failure (no relay accepted) the cadence state is untouched, so the next fix
retries — the same semantics as `autoEmit`.

### Config mirror (JS side)

New Capacitor plugin `FlockPublishPlugin` (`setConfig(json)` / `clearConfig()` /
`getJournal()` / `ackJournal()`) + `native/publishMirror.ts`. `app.ts` calls a
single `syncNativePublish()` — same pattern as `syncWatch`/`syncBle` — after
every relevant mutation; it recomputes the config and diffs against the last
sent. Mirrored fields (nothing more):

- identity `skHex` (local identities only — a Signet identity has no local key
  to seal with, so the mirror is cleared and background publish is
  foreground-only, stated in-app),
- active circle: `id`, `seedHex`, `sharePrecision`, `festivalUntil`,
- `relayUrls`, `noReportZones`, `offGridUntil`, the sharing flag.

**Cleared on**: stop sharing, decoy hide, reset, switch to Signet, and the next
open into the app-lock screen. A cleared config idles the publisher immediately.
Reseed/epoch change re-mirrors the new seed — stale-seed wraps to a rotated-out
inbox are bounded by the next `syncNativePublish()`.

**App Lock interaction** (the doc's hard question): while the app is unlocked and
sharing, the seeds exist in the Keystore-backed mirror — the same threat model as
holding them in the WebView heap, arguably stronger (hardware Keystore vs a JS
heap). The app lock is a *key-at-rest* lock: nothing runs at the instant it
"engages" (the process simply dies losing the in-memory key), so the mirror is
**not** wiped at that moment. It is cleared the next time the app is opened, in
`bootLocked`, before the PIN screen renders. That means the honest behaviour is:

- **While flock is closed/killed and locked at rest, background publish keeps
  running** from the persisted mirror — the OS can restart the fix broadcast into
  a fresh process and `FlockFixReceiver` publishes without the WebView. This is
  intended: beacons go only to the circle's inbox (encrypted), so a locked phone
  that keeps your circle informed is the feature, not a leak — and it is exactly
  the field failure (locked phone → no beacons) this whole change fixes.
- **The instant the user reopens** and is met with the PIN screen, the mirror is
  cleared and background publish is foreground-only until they unlock — reopening
  is the signal that defers to an explicit unlock.

The genuine coercion case is not the app lock but the **decoy/hide** path, which
`await`s a full wipe (config, cadence, journal) before sealing — leaving nothing
for a restarted native task to adopt. So "locked at rest" does not mean "dark";
"hidden" does.

### Reconciliation on resume

On Capacitor `resume` (and boot), JS reads the journal → replays each entry
into `saveBeacon` (own-pin history) and `beaconCadence` (no double-send right
after reopening) → `ackJournal()`. The fix-arrival half of the journal is the
split measurement the spike doc asked for: "native sampled fine, JS delivery
stalled" becomes directly observable.

### Build integration

`patch-android.mjs` grows three idempotent steps (same file, same style):
copy the new Kotlin sources; apply the Kotlin Gradle plugin + add pinned deps
(`org.rust-nostr:nostr-sdk:0.44.2`, `androidx.security:security-crypto`,
`androidx.lifecycle:lifecycle-process`, `com.squareup.okhttp3:okhttp`) to
`app/build.gradle`; patch the geolocation plugin's Java (assert-guarded).

## Verification (non-negotiable)

1. **Golden vectors, JS → Kotlin.** The public `compatibility/v1/` vitest suite writes `vectors.json` from
   the existing JS implementations: byte-compared for everything deterministic
   (nsec-tree `fromNsec`+`derive`, `deriveInbox`, beacon key, group-id hash,
   geohash encode, event-id hashing); decrypt-direction round-trips for the
   randomised pieces (AES-GCM beacon, NIP-44, full wrap).
2. **Kotlin JUnit (JVM)** asserts against those vectors using `nostr-sdk-jvm` —
   runs locally/CI, no device. A reverse stage has the Kotlin side emit full
   wraps that a guarded vitest unwraps through the **untouched** `giftUnwrap`
   path — zero special-casing, the doc's criterion.
3. **Hardware round-trip**: turnkey instructions (build APK → share → lock →
   walk → second phone observes continuous movement; then repeat inside a
   no-report zone and assert silence/capping). The journal's split log gives
   the pass/fail evidence.

## Out of scope (v1)

- **Inbound** (2026-06-30 doc) — the `RelayPublisher` seam and the crypto
  helpers are shared groundwork, but no subscription is built here.
- **Cover traffic natively** — while backgrounded, moving-vs-still timing is
  partially readable by a logging relay (the heartbeat still masks the worst of
  it). Follow-up once the pipeline is verified.
- **Adaptive sampling backoff** — the watcher's `distanceFilter` is the v1
  battery gate.
- **Signet identities** — no native NIP-46 signing; foreground-only, stated
  in-app.
- **iOS** — the shell is Android-only today.

## Risks

- **Plugin patch coupling**: pinned `@capacitor-community/background-geolocation`
  version; the patch fails the build loudly on anchor drift.
- **rust-nostr binding drift**: pinned 0.44.2; the golden vectors catch any
  NIP-44 behavioural change on upgrade.
- **`androidx.security-crypto` is in maintenance mode**: stable and widely
  deployed; if it is ever removed, the mirror moves to a manually
  Keystore-wrapped file with the same lifecycle.
