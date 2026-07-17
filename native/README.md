# flock — native Android (Capacitor)

The PWA owns the foreground product. The native Android layer adds the work a
web platform cannot reliably do: locked/background location publication,
app-closed relay reachability, native notifications/ring, BLE, Tor/Orbot
routing, and locked-phone radar guidance. It targets stock Android and
**GrapheneOS** without Google Play Services.

> Status: **Android ships** — `npm run apk` / `npm run apk:release` produce an
> installable APK. iOS remains unbuilt. The generated `android/` project is
> gitignored and fully reproducible: every native customisation lives in the
> committed scripts here, never as hand-edits to generated files.
>
> **Outbound background publishing is shipped and measured.** Locked walking
> and stationary deep-Doze round trips are green on GrapheneOS. That result is
> scoped: locked-phone radar, the live Orbot-route beacon, and broader inbound
> battery/device coverage retain separate evidence rows in `../docs/ROADMAP.md`.
> iOS remains unbuilt.

## Build

```sh
npm run apk           # debug   → android/app/build/outputs/apk/debug/app-debug.apk
npm run apk:release   # release → android/app/build/outputs/apk/release/flock-release.apk (signed)
```

`native/build-apk.sh` does everything: generates `android/` if missing
(`cap add android`), builds the web app in **native mode** (`build:native` —
see below), syncs, applies `patch-android.mjs`, regenerates launcher icons
(`@capacitor/assets` from `native/assets/`, derived from `app/public/icon.svg`),
then runs Gradle.

Prerequisites: Android SDK (`~/Library/Android/sdk` or `$ANDROID_HOME`) and a
**JDK 21** (Capacitor 8 pins the toolchain) — `brew install openjdk@21` is
auto-detected.

### Release signing

The first `apk:release` run mints `native/release.keystore` +
`native/keystore.properties` (both gitignored). **Back both up** — Android only
installs updates signed by the same key; lose it and every device must
uninstall/reinstall (losing local state). Same key across machines: copy both
files into `native/` before building.

## How the shell integrates (all committed, nothing manual)

- **`build:native`** (`vite build --mode native`, env in `app/.env.native`) —
  inside the APK there is no same-origin server, so the privacy proxies
  (`/tiles`, `/nominatim`, `/overpass`, `/api/extract`) point at the production
  host instead. Same guarantee, same server; the host's Caddy also sends the
  CORS headers the shell's `https://localhost` origin needs (deploy/Caddyfile).
- **`background.ts`** — permission and plugin watcher bridge. It forwards fixes
  into the WebView while JavaScript is alive, but it is not the authoritative
  locked-phone publisher: Android can suspend that JavaScript path.
- **`FlockLocationService` + `FlockPublisher`**
  (`android-src/kotlin-android/` + `android-src/kotlin/`) — the production
  background path. The app mirrors the minimum encrypted configuration through
  `publishMirror.ts`; while hidden, Kotlin owns fix → cadence/movement policy →
  beacon encryption → per-recipient NIP-59 wrapping → relay publish, then
  journals the result for the WebView to adopt on resume. It uses raw Android
  location APIs and no Google services.
- **app wiring** (`app/src/app.ts`) — the background watcher and native publish
  mirror are tied strictly to the **sharing toggle**: start-sharing starts it,
  stop-sharing stops it,
  and reset/hide (decoy) tear it down so the foreground-service notification
  can never be a tell on a "fresh install". Detection via the injected
  `window.Capacitor` (`app/src/native.ts`) keeps Capacitor out of the web
  bundle; the bridge loads as a lazy chunk only inside the shell.
- **`patch-android.mjs`** — location + foreground-service permissions,
  `allowBackup=false` (with the app lock off, localStorage is plaintext — it
  must not be extractable via adb/cloud backup), and the **verified App Links
  intent filter** for `https://flock.forgesworn.dev` — claiming **only path
  `/`** (invite fragments live there), so `/get.html` and the APK download
  stay reachable in the browser on phones that have flock installed.
- **`notify.ts`** — toasts render into the WebView, invisible with the screen
  off — exactly when "🚨 Help raised" matters. While the app is hidden, app.ts
  mirrors its toasts here as real Android notifications
  (`@capacitor/local-notifications` — pure AOSP, GrapheneOS-safe). Permission
  is requested at boot; asking mid-emergency from the background is too late.
- **`deeplink.ts`** — a scanned/tapped flock invite arrives in the shell as an
  Android *intent* (the WebView never navigates); this bridge re-injects just
  the `#join=`/`#invite=` fragment so the app's normal hashchange consumer
  handles it. Verification is against `/.well-known/assetlinks.json` (committed
  at `app/public/.well-known/`, so every deploy serves it) — it lists the
  release **and** local debug signing fingerprints; regenerate with
  `keytool -list -v -keystore native/release.keystore` if the key ever changes.
  Net effect: someone with the APK installed who scans an invite QR joins in
  the app (background watch, one identity), not in a browser tab.
- **`StayReachableService` / `stayReachable.ts`** — opt-in, location-free
  foreground service that keeps the existing relay/WebView path available for
  app-closed inbound alerts. It is not UnifiedPush and has an explicit battery
  cost surfaced in Settings.
- **`RadarGuideService` / `radarGuide.ts`** — native locked-phone radar loop.
  Pure decisions match `src/radar.ts` through committed golden vectors and JVM
  tests; the real-hardware field pass remains open.
- **BLE + Tor/Orbot** — native plugins provide the nearby buffer/mesh and the
  `.onion` relay network path. The onion route is implemented; its final live
  GrapheneOS/Orbot beacon check is tracked separately.

## Installing on GrapheneOS / Android

1. Sideload the APK (no Play Services needed — nothing in the app uses them).
2. Location permission: choose **"Allow all the time"** (Android 11+ sends you
   to Settings for this) — background sharing needs it; foreground-only
   sharing works with "While using".
3. Allow the notification (Android 13+): it belongs to the foreground service
   that keeps the watcher alive; it only exists while sharing is on.
4. GrapheneOS: check the app isn't battery-restricted (Settings → Apps → flock
   → Battery → Unrestricted) or the OS may kill the watcher.

## De-Googled inbound alerts

FCM is deliberately absent. Alerts arrive over the app's own Nostr relay
subscriptions. In the foreground that is the normal WebView connection; with
**Stay reachable** enabled, a location-free Android foreground service keeps
that relay/WebView path available after the UI is closed. Flock does not
currently implement UnifiedPush. If the user disables Stay reachable or the OS
kills the process, app-closed alerts are not promised.

## Location implementation

- **Own Kotlin service (authoritative while hidden)** — raw Android location,
  native policy/encryption/wrapping/publish, no Google APIs. This is the path
  that passed locked/deep-Doze hardware measurement.
- **`@capacitor-community/background-geolocation`** — retained as the permission
  and WebView fix-forwarding bridge while JavaScript is alive. It is not the
  proof of background publication.
- **`@transistorsoft/capacitor-background-geolocation`** — native, battery-aware
  region monitoring; **paid Android licence**. Not used by the current path.

## Verification and release integrity

`npm run test:native` runs the pure Kotlin policy/crypto JVM suite. That suite
emits Kotlin-built wraps; CI then runs
`native/vectors/verify-kotlin.test.ts` in the same job to prove the untouched
JavaScript path can unwrap/decrypt them. This is wire compatibility, not device
evidence. The real-hardware matrix remains in `../docs/ROADMAP.md`.

Release APKs are reproducible from tagged source and their hashes are attested
off-host. See `../docs/verify-apk.md`, `../SECURITY.md`, and
`../docs/transparency/README.md`.
