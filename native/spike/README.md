# Phase 0 spike — runbook

Throwaway measurement harness for the **single unproven claim** the feasibility
research could not confirm: reliable **background location wake-ups on GrapheneOS
without Google Play Services**. Read the plan first —
[`docs/plans/2026-06-30-phase0-graphene-spike.md`](../../docs/plans/2026-06-30-phase0-graphene-spike.md).
This is **measurement, not polish**: do not build out the native shell until the
decision gate there passes.

## What this harness does

A self-contained Capacitor app (its own page + build — **not** the real flock
PWA) that:

- starts the free, Google-free watcher
  (`@capacitor-community/background-geolocation` → `LocationManager` + a
  foreground service, no Google APIs),
- evaluates the **real** flock geofence (`src/geofence.ts` `isBreach`) on every
  fix,
- persists the whole session with `@capacitor/preferences` so it **survives the
  WebView being backgrounded / killed** (the entire point), and
- shows live pass/fail numbers and a one-tap **Copy session JSON** to get the raw
  data off the phone.

It covers the **local** tests (#1 cadence, #2 breach latency, #3 Doze survival,
#4 reboot). Test **#5 (alert delivery)** uses the normal app + a second device;
test **#6 (battery)** is read from the OS. See the table below.

> Editor squiggles before you install: `harness.ts` imports `@capacitor/*`, which
> aren't dependencies until step 1. `native/` is outside the library tsconfig, so
> this never affects `npm run build`/`test`/`typecheck` — same as
> `native/background.ts`.

## Prerequisites

- A **GrapheneOS** phone (no Google Play Services, no sandboxed Play services),
  USB debugging on. Optionally a stock Android + an iPhone for contrast.
- Android Studio + SDK on the build machine.

## 1. Install Capacitor + the plugins

```sh
npm i -D @capacitor/cli
npm i @capacitor/core @capacitor/geolocation \
      @capacitor/preferences @capacitor-community/background-geolocation
```

(`@capacitor/preferences` is the durable store for the recorded session;
everything else matches `native/README.md`.)

## 2. Build the spike and add Android

```sh
npm run build:spike     # vite build -c vite.spike.config.ts → dist-app
npx cap add android
npx cap sync
npx cap run android     # or open in Android Studio and run on the device
```

`build:spike` overwrites `dist-app` with the spike app. When you're done, run
`npm run build:app` to restore the production output.

## 3. Android permissions / manifest

In `android/app/src/main/AndroidManifest.xml` ensure:

```xml
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />
<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
```

On the device, grant location **“Allow all the time”** (Android 11+ forces this
via Settings, not the runtime prompt) and allow the foreground-service
notification. On GrapheneOS also confirm the app isn't being battery-restricted.

## 4. Run a session

1. Open the app, set the **radius** (default 150 m), tap **Set safe zone here**
   at your start point.
2. Tap **Start watch**, grant permissions.
3. Lock the phone and pocket it. Walk a route that leaves the zone.
4. Reopen the app — fixes recorded while backgrounded appear (it re-paints every
   5 s). Tap **Copy session JSON** to export the raw log.

## 5. Tests → where to read the result

| # | What | How | Pass | Where |
|---|------|-----|------|-------|
| 1 | Background fix cadence (screen locked, moving) | Walk with phone locked | **p90 moving ≤ 60 s** | `#1` chip |
| 2 | Geofence breach, app backgrounded | Walk out of the zone, locked | **detected ≤ 90 s** | `#2` chip + "breach latency" |
| 3 | Survives Doze / standby | Idle 30+ min, then move | watcher fires again; no *silent* death | "gaps > 5 min" + your walk log¹ |
| 4 | Reboot persistence | Reboot, **don't** open app, move | does it resume? | see below — expect a gap² |
| 5 | Alert delivery (de-Googled) | Use the **real app** to raise SOS/breach; 2nd device subscribed | received ≤ 10 s | second device |
| 6 | Battery cost | Run 1 & 2 over ~4 h | drain **acceptable** | OS battery settings (record %/h) |

¹ A gap while you're **stationary** is expected — `distanceFilter` is 25 m, so no
movement means no fix. #3 is about whether a fix arrives *once you move again*
after a long idle; judge the gap list against when you actually moved.

² The free plugin's watcher is added from JS, so after a reboot nothing runs until
the app is opened — expect test #4 to show **no auto-resume**. Record the gap. A
`BOOT_COMPLETED` receiver (below) is a starting point, but robust headless resume
needs custom native work and is **out of scope for the spike** — note it as a gap
and move on.

## Decision gate

Per the plan: **#1, #2, #3, #5 all pass → build the native shell (Phase G).** #1
or #2 fail → tune `distanceFilter`/accuracy, evaluate the paid
`@transistorsoft/...` plugin, or ship reduced guarantees stated honestly in the
UI. #6 unacceptable → motion-detection duty-cycling or a coarser cadence.

## Reference: BOOT_COMPLETED receiver (test #4)

Paste into the generated Android project (it's gitignored). Re-launching the app
on boot lets it re-add the watcher; subject to OS background-launch limits, so
**measure, don't assume**.

`android/app/src/main/java/cc/trotters/flock/BootReceiver.kt`:

```kotlin
package cc.trotters.flock

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            context.packageManager
                .getLaunchIntentForPackage(context.packageName)
                ?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                ?.let(context::startActivity)
        }
    }
}
```

Register it inside `<application>` in `AndroidManifest.xml`:

```xml
<receiver android:name=".BootReceiver" android:exported="true">
  <intent-filter>
    <action android:name="android.intent.action.BOOT_COMPLETED" />
  </intent-filter>
</receiver>
```

## Files

- `metrics.ts` — pure: session → cadence / gaps / breach-latency / pass-fail.
- `harness.ts` — watcher + on-device `isBreach` + `Preferences` persistence.
- `ui.ts` / `main.ts` / `index.html` / `styles.css` — the readout.
- `../../vite.spike.config.ts` — isolated build (root `native/spike` → `dist-app`).
