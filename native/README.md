# flock — native (Capacitor) shell

The PWA does everything in the **foreground**. The native shell adds the one
thing no web platform can do in 2026: **true background geolocation** (and thus
background geofence-breach alerts) on iOS, Android, and **GrapheneOS** — see
`../docs/research/2026-06-30-feasibility-research.md`.

> Status: **scaffold**. The bridge (`background.ts`), Capacitor config
> (`../capacitor.config.ts`), and these steps are ready; the native projects are
> not generated (and `android/`, `ios/` are gitignored). Do the Phase 0 spike
> (`../docs/plans/2026-06-30-phase0-graphene-spike.md`) before committing to this.

## 1. Install

```sh
npm i -D @capacitor/cli
npm i @capacitor/core @capacitor/geolocation @capacitor-community/background-geolocation
```

## 2. Add platforms (builds the web app first)

```sh
npm run build:app
npx cap add android
npx cap add ios        # macOS + Xcode only
npx cap sync
```

`capacitor.config.ts` already points `webDir` at `dist-app`.

## 3. Wire the background watcher

In `app/src/main.ts`, start the watcher only on a native platform:

```ts
import { Capacitor } from '@capacitor/core'
if (Capacitor.isNativePlatform()) {
  const { startBackgroundWatch } = await import('../../native/background')
  await startBackgroundWatch()
}
```

`background.ts` reuses the **same** flock policy + transport as the PWA, so
background fixes obey the identical disclosure-on-event rules (family: withhold
until breach; night-out: coarse + throttled). `help`/SOS stays foreground.

## 4. Native permissions / config

**Android** (`android/app/src/main/AndroidManifest.xml`): `ACCESS_FINE_LOCATION`,
`ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE`,
`FOREGROUND_SERVICE_LOCATION`. The community plugin runs a foreground service
with a persistent notification (configured in `background.ts`) — this is the
mechanism that works **without Google Play Services**, so it runs on GrapheneOS.

**iOS** (`ios/App/App/Info.plist`): `NSLocationWhenInUseUsageDescription`,
`NSLocationAlwaysAndWhenInUseUsageDescription`, and the `location` background
mode. Native region monitoring (`CLLocationManager`) is capped at **20**
geofences.

## 5. De-Googled push (GrapheneOS)

FCM is unavailable. Use **UnifiedPush** (a distributor app such as ntfy holds one
socket and fans out), or keep a foreground-service Nostr relay socket open as the
alert channel. See the research doc §1.3.

## Plugin choice

- **`@capacitor-community/background-geolocation`** (used here) — free, raw
  background GPS via `LocationManager` (no Google APIs), no built-in geofencing,
  so flock evaluates fences on-device (`@forgesworn/flock`'s `geofence`/`policy`).
  This is exactly the decentralised model.
- **`@transistorsoft/capacitor-background-geolocation`** — native, battery-aware
  region monitoring; **paid Android licence**. Consider it only if on-device
  evaluation proves too costly on battery (measure in Phase 0).
