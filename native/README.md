# flock — native (Capacitor) shell

The PWA does everything in the **foreground**. The native shell adds the one
thing no web platform can do in 2026: **true background geolocation** (and thus
background geofence-breach alerts) on Android and **GrapheneOS** — see
`../docs/research/2026-06-30-feasibility-research.md`.

> Status: **Android ships** — `npm run apk` / `npm run apk:release` produce an
> installable APK. iOS remains unbuilt. The generated `android/` project is
> gitignored and fully reproducible: every native customisation lives in the
> committed scripts here, never as hand-edits to generated files.
>
> The Phase 0 spike (`../docs/plans/2026-06-30-phase0-graphene-spike.md`)
> remains the **measurement gate** for background *reliability* claims
> (cadence / Doze / battery on real hardware). The APK existing does not close
> it — sideload, measure, then believe.

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
- **`background.ts`** — a THIN fix-forwarder over
  `@capacitor-community/background-geolocation` (platform `LocationManager` +
  foreground service — **no Google APIs**, which is why it works on
  GrapheneOS). It never decides anything: fixes enter the app's normal
  `onFix → autoEmit` pipeline, so breadcrumbs, off-grid, no-report zones and
  cadence gating apply identically to foreground and background (FLOCK.md §6).
- **app wiring** (`app/src/app.ts`) — the background watcher is tied strictly
  to the **sharing toggle**: start-sharing starts it, stop-sharing stops it,
  and reset/hide (decoy) tear it down so the foreground-service notification
  can never be a tell on a "fresh install". Detection via the injected
  `window.Capacitor` (`app/src/native.ts`) keeps Capacitor out of the web
  bundle; the bridge loads as a lazy chunk only inside the shell.
- **`patch-android.mjs`** — location + foreground-service permissions,
  `allowBackup=false` (with the app lock off, localStorage is plaintext — it
  must not be extractable via adb/cloud backup), and the **verified App Links
  intent filter** for `https://flock.forgesworn.dev`.
- **`deeplink.ts`** — a scanned/tapped flock invite arrives in the shell as an
  Android *intent* (the WebView never navigates); this bridge re-injects just
  the `#join=`/`#invite=` fragment so the app's normal hashchange consumer
  handles it. Verification is against `/.well-known/assetlinks.json` (committed
  at `app/public/.well-known/`, so every deploy serves it) — it lists the
  release **and** local debug signing fingerprints; regenerate with
  `keytool -list -v -keystore native/release.keystore` if the key ever changes.
  Net effect: someone with the APK installed who scans an invite QR joins in
  the app (background watch, one identity), not in a browser tab.

## Installing on GrapheneOS / Android

1. Sideload the APK (no Play Services needed — nothing in the app uses them).
2. Location permission: choose **"Allow all the time"** (Android 11+ sends you
   to Settings for this) — background breach detection needs it; foreground-only
   sharing works with "While using".
3. Allow the notification (Android 13+): it belongs to the foreground service
   that keeps the watcher alive; it only exists while sharing is on.
4. GrapheneOS: check the app isn't battery-restricted (Settings → Apps → flock
   → Battery → Unrestricted) or the OS may kill the watcher.

## De-Googled push (future)

FCM is unavailable on GrapheneOS. Alerts currently arrive over the app's own
relay subscriptions (foreground, or background while the watcher's service
keeps the WebView alive). For delivery when the app is fully dead, use
**UnifiedPush** (e.g. an ntfy distributor) — see the research doc §1.3.

## Plugin choice

- **`@capacitor-community/background-geolocation`** (used) — free, raw
  background fixes via `LocationManager`, no Google APIs, no built-in
  geofencing: flock evaluates fences on-device (`geofence.ts`/`policy.ts`),
  which is exactly the decentralised model.
- **`@transistorsoft/capacitor-background-geolocation`** — native, battery-aware
  region monitoring; **paid Android licence**. Consider only if Phase 0
  measurement shows on-device evaluation is too costly on battery.
