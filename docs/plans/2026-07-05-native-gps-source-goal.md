# Goal — a native GPS fix source for background publish

**Date:** 2026-07-05 · **Status:** IMPLEMENTED (compiles into the APK) — on-hardware
verification pending (the locked-walk pass criterion below). **Owner:** flock native.

> **Update 2026-07-05:** the plan below is now built —
> `native/android-src/kotlin-android/cc/trotters/flock/FlockLocationService.kt`
> (direct `GPS_PROVIDER`), its lifecycle wired through `FlockPublishPlugin`
> (`setConfig`→start, `clearConfig`/`wipeAll`→stop), the shared `submitFix`
> intake on `FlockFixReceiver`, and the `location`-typed manifest entry in
> `patch-android.mjs`. A full `npm run apk` compiles it and the merged manifest
> carries `android:foregroundServiceType="location"`. What remains is the
> on-hardware **locked-walk** measurement (see "How to verify").

## The one-sentence goal

Background beacons don't yet flow while the phone is locked because flock's
**fix source** — the community `@capacitor-community/background-geolocation`
plugin — does **not deliver location fixes to a locked/backgrounded foreground
service on GrapheneOS**. Replace it with flock's **own native GPS foreground
service** (modelled on the Phase-0 `native/gps-probe`, which measured GREEN),
feeding the **already-verified** `FlockPublisher.onFix` pipeline. When that
lands, "beacons keep flowing while locked" works end-to-end.

## What the 2026-07-05 on-hardware session established (GrapheneOS Pixel)

Verified **working** on real hardware:

- APK builds; the assert-guarded plugin patch is live (`FIX` broadcast →
  `FlockFixReceiver` is wired into the running APK).
- Join, foreground sharing, relay round-trip on `wss://relay.trotters.cc`.
- **Wire format end-to-end.** A standalone relay watcher decrypted the JS
  pipeline's live beacons byte-for-byte using inbox + beacon keys derived
  *independently* from the circle seed. The crypto / key derivation the PR added
  is correct on device (`t=beacon geohash=gcrmym… prec=9`, plus `t=cover`).
- Foreground publish (via `navigator.geolocation`, `services.ts`).
- Full background exemption: standby bucket 5 (exempted), Doze whitelist,
  `ACCESS_BACKGROUND_LOCATION` granted.

Verified **broken** (the blocker):

- Across **two locked walks**, **zero** fixes reached the native pipeline.
  With diagnostic logging in `FlockFixReceiver` + `FlockPublisher`, the receiver
  logged nothing — so no `FIX` broadcast was ever sent. The patch is on the
  plugin's correct location-delivery path (`ServiceReceiver.onReceive`, which
  reads `intent.getParcelableExtra("location")`); that path simply never fired
  while locked. i.e. **the bg-geo plugin's FGS received no locations while the
  screen was off**, despite full background exemption.

Conclusion: the PR's **publish half is correct and verified**; the **fix source
is the weak link**, and it is upstream of everything the PR added.

## Root cause

- The community plugin requests the **fused provider** (`dumpsys location`
  showed `fused … BALANCED/HIGH_ACCURACY` for uid `cc.trotters.flock`). On
  GrapheneOS (no Google Play Services) the fused/network path does not keep
  feeding a backgrounded/locked FGS.
- The Phase-0 `native/gps-probe` (`ProbeService.java`) requested the **raw
  platform `LocationManager.GPS_PROVIDER` directly** and measured **46 fixes @10s
  while locked + walking** on the same device. Direct GPS is the proven path.
- This is exactly the gap `canary-native` exists to close (a native, Play-free
  location layer). See `[[new-projects-generic-forgesworn]]` — the reusable core
  should graduate to the estate (Rust+UniFFI ideally), app policy stays app-side.

## The plan

Keep the verified `FlockPublisher` pipeline **unchanged**. Only swap the source.

### 1. `FlockLocationService.kt` (Android glue, `native/android-src/kotlin-android/…`)

A `location`-typed foreground service mirroring `ProbeService`:

- `startForeground(NOTIF_ID, notif, FOREGROUND_SERVICE_TYPE_LOCATION)` — the FGS
  type MUST match the manifest declaration (see the FGS-type gotcha,
  `[[flock-native-fgs-gotcha]]`) or `startForeground` crashes the process on
  API 34+.
- `LocationManager.requestLocationUpdates(GPS_PROVIDER, ~5s, 0f, listener,
  handlerThread.looper)` — direct GPS, the proven approach. Also request
  `NETWORK_PROVIDER` when enabled (cheap first-fix help).
- On each `onLocationChanged`, hand off to a single-thread `Executor` (crypto +
  network must never run on the location callback thread) and call
  `FlockPublisher.onFix(lat, lon, accuracy, time)`.
- Build the `FlockPublisher` exactly as `FlockFixReceiver` does: shared
  `EncryptedConfigStore`, `OkHttpRelayPublisher`, and the same
  `ProcessLifecycleOwner`-based `isAppForegrounded` guard so foreground fixes
  still drop (JS `navigator.geolocation` owns the foreground — no double-publish).
- `START_STICKY`; tear down GPS updates + HandlerThread in `onDestroy`.

**Done** — `FlockLocationService.kt` (~150 lines incl. doc comment). A shared
`FlockFixReceiver.submitFix(...)` intake serialises both sources (bg-geo
broadcast + native GPS) onto the one publish thread, so there is no cadence
read/write race and no double-publish (onFix's foreground guard still drops
foreground fixes). `startForeground` is wrapped so a missing FGS-location grant
or type mismatch stops the service instead of crashing the process.

### 2. Lifecycle — follow the config mirror

- `FlockPublishPlugin.setConfig(...)` → `FlockLocationService.start(context)`
  (`startForegroundService`). setConfig is only called while sharing + unlocked.
- `FlockPublishPlugin.clearConfig()` / `wipeAll()` →
  `FlockLocationService.stop(context)`.
- Net: the native GPS service is alive exactly when the publish mirror is —
  started on share, stopped on stop-sharing / lock-boot / decoy hide / reset.

### 3. Manifest (`patch-android.mjs`)

Add (idempotently, in the same style as `FlockFixReceiver` / StayReachable):

```xml
<service android:name=".FlockLocationService"
         android:exported="false"
         android:foregroundServiceType="location" />
```

### 4. Reconcile with the existing bg-geo plugin

- Simplest first step: leave the bg-geo watcher as-is. It still handles
  foreground/permissions; on GrapheneOS it just never fires the background
  broadcast (harmless — the cadence gate de-dupes if it ever does). Two
  location FGSs is wasteful but correct.
- Follow-up: once the native service is proven, consider dropping the bg-geo
  dependency + the `patch-android.mjs` plugin patch entirely and sourcing ALL
  fixes (fg + bg) natively — smaller footprint, one fix path.

### 5. Battery / footprint (aligns with `[[flock-minimal-footprint]]`)

- v1: GPS @~5s while sharing is acceptable for a night-out share; the publish
  **cadence gate** (45s floor / 300s heartbeat) already throttles relay traffic
  regardless of sample rate.
- Follow-up: only run the native GPS service while **backgrounded** (start on
  `ProcessLifecycleOwner` ON_STOP, stop on ON_START — foreground is JS's job),
  and/or widen the interval / add a distance filter when stationary.

## How to verify (tooling that already worked this session)

- **Objective relay watch** (no phone tethering needed): derive the inbox +
  beacon keys from the circle seed (in the invite `#join=` fragment), subscribe
  to `wss://relay.trotters.cc` for `kind:1059 #p=<inboxPk>`, and NIP-59 unwrap +
  `decryptBeacon` each one to print `geohash / precision / arrival-time`. A raw
  `WebSocket` works; `nostr-tools` `SimplePool` did **not** (emit a plain `REQ`).
  The reusable script lived in the session scratchpad.
- **On-device split log**: temporarily add `Log.d("FlockPublish", …)` to
  `FlockFixReceiver` + a `(String)->Unit` logger param on `FlockPublisher`
  (keeps the pure core `android.*`-free), then `adb logcat -s FlockPublish:D`.
  The Pixel's log buffer retains lines while unplugged for a walk — dump on
  replug. This is the `[[gps-probe]]`-style on-device measurement.
- **Pass criterion**: lock the Pixel (screen off, backgrounded), walk ~500 m,
  and see `t=beacon` at **changing** geohashes arriving on the relay *during*
  the locked walk (or, connectivity-independent, `FIX broadcast/native GPS fix →
  publishing → N accepted` in the on-device log).
- Note: **the Pixel has no SIM** (WiFi-only). For a real walk it needs a hotspot
  (flaky in testing) or a SIM; or test on a device with mobile data. The
  on-device log removes the connectivity dependency for *observation*.

## Open questions

1. Native-only fix source (drop bg-geo) vs. keep bg-geo for foreground? Leaning
   native-only long-term; keep both for the first working pass.
2. Where should the reusable native GPS layer live — in flock, or graduate to
   `canary-native` and consume it here? (Estate-primitive rule.)
3. iOS has no equivalent yet (shell is Android-only) — out of scope.

## References

- `native/gps-probe/app/src/main/java/cc/trotters/gpsprobe/ProbeService.java` —
  the proven mechanism.
- `docs/plans/2026-07-05-native-background-publish-design.md` — the publish half
  (verified).
- `docs/plans/2026-06-30-phase0-graphene-spike.md` — Layer-B spike (GREEN).
