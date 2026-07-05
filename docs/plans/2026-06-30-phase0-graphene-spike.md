# Phase 0 — GrapheneOS background-location spike

**Date:** 2026-06-30 · **Owner:** TBD · **Status:** Layer-B GPS delivery **MEASURED GREEN** on a GrapheneOS Pixel 10 Pro (API 37), 2026-07-05 (`native/gps-probe/`) — locked + walking; deep-Doze stationary run still pending. Full Capacitor harness scaffolded (`native/spike/`).

## Why this exists

The feasibility research could confirm everything *except* one thing, and the
single claim that tried to pin it down was **refuted (0-3)**: the exact mechanism
and reliability of **background location wake-ups on GrapheneOS without Google
Play Services**. The entire background-geofencing pillar rests on this. **Do not
build out the native shell until this spike passes.**

## Hypothesis

`@capacitor-community/background-geolocation` (platform `LocationManager` + a
foreground service with a persistent notification — no Google APIs) delivers
location updates reliably while the app is backgrounded / the screen is locked on
GrapheneOS, at a cadence good enough for geofence-breach detection, at acceptable
battery cost.

## Two layers — isolate them (run the native probe first)

Since this doc was written, live field testing
([`2026-07-05-native-background-publish.md`](2026-07-05-native-background-publish.md))
split the background-reliability question into two independent layers:

- **Layer A — does the *pipeline* run while backgrounded?** Confirmed broken and
  understood: fixes reach native code, then stall at the Capacitor WebView-JS
  bridge, which Android suspends. A code problem (move the pipeline native), not a
  platform one.
- **Layer B — does the OS *deliver GPS* to a locked, backgrounded foreground
  service at all?** On GrapheneOS (no Play Services) this is the original,
  still-unmeasured question — and no amount of native-pipeline work fixes it if
  the OS stops feeding location.

The `native/spike/` harness below can only observe what reaches JS, so it can't
tell these apart (the blind spot flagged in the 2026-07-05 doc). A dedicated
pure-native probe now isolates Layer B.

### `native/gps-probe/` — the Layer-B probe (cheapest decisive test)

A standalone app (appId `cc.trotters.gpsprobe`, installs alongside flock): a
`location`-typed foreground service on raw `LocationManager` — no WebView, no JS,
no crypto, no relay. It logs every fix plus a 30 s **heartbeat**, so the result is
tri-state. Build/run:
[`native/gps-probe/README.md`](../../native/gps-probe/README.md).

| Log after locking | Meaning | Verdict |
|---|---|---|
| `FIX` lines keep coming | GPS delivered to a locked FGS works | **Green** — Layer B is fine; the WebView-JS seam was the whole problem → moving the pipeline native fixes locked sharing |
| `BEAT` heartbeats continue, `FIX` lines stop | process alive, OS stopped feeding GPS | **Red (delivery)** — a native pipeline alone won't help; fix location delivery first |
| `BEAT` heartbeats also stop | Doze/battery killed the service | **Red (process)** — keep-alive / battery-exemption problem |

Run this on the **GrapheneOS Pixel before building anything native** — it converts
"the native pipeline probably fixes locked sharing" into a yes/no. The stock-Android
A32 is only a baseline; a green there with a red on GrapheneOS *is* the finding.

**Result — GREEN (2026-07-05, GrapheneOS Pixel 10 Pro, API 37).** Screen locked +
walking: **46 fixes at ~10 s cadence, longest gap 10 s**, foreground service alive
8+ min (never killed), background-location + battery-exemption on. GrapheneOS
delivers GPS to a locked, backgrounded FGS reliably — **Layer B is fine.** So
flock's locked-phone failure is the Layer-A WebView-JS suspend seam, not the
platform, and moving the pipeline native (`canary-native`) will *fix* locked
background sharing rather than gamble on it. Comfortably beats test #1's ≤60 s
cadence bar. Not yet run: deep-Doze stationary (walking keeps the device out of
deep Doze). Note: adb can't pull the log on GrapheneOS (blocks `Android/data`) —
the probe's on-screen stats are the source of truth (`screencap`).

## Devices

- A **GrapheneOS** phone, **no** Google Play Services, **no** sandboxed Play
  services. (Optionally a second run *with* sandboxed Play services to compare.)
- For contrast: one stock Android and one iPhone.

## No device? Validation tiers

GrapheneOS runs **only on Pixel hardware** — there is no GrapheneOS emulator
image, and cloud device farms don't offer it either. So the production decision
gate genuinely needs a physical GrapheneOS phone; nothing below substitutes for
it. What you *can* do without one:

| Tier | Environment | Answers | Cost |
|------|-------------|---------|------|
| 0 | **Android emulator** (AOSP image, no Google APIs) | Functional path only: route → background fix → `isBreach` flips → transition detected. Catches harness/wiring bugs. | free |
| 1 | **Real stock-Android phone** (a tester's, cheap second-hand, or a cloud farm) | Real Doze / GPS / battery — a strong *proxy*, since GrapheneOS is AOSP and, if anything, stricter. | low / borrow |
| 2 | **GrapheneOS Pixel** | The de-Googled question definitively — **the gate**. | a Pixel |

Tier 0 proves "the code works", **not** "the platform works": it cannot answer #1
(cadence), #3 (Doze) or #6 (battery) — the emulator doesn't represent real power
management or radios, and the cadence/latency numbers it shows reflect the
*injected* route, not real GPS (read them as "did the path fire"). Note too that
the **PWA in live** only ever tests the
*foreground*; background breach detection is exactly what the PWA can't do, so a
live-site test doesn't touch this gate either. The real-world equivalent of Tier 1
is sideloading the **Capacitor APK** onto a real handset. Emulator commands are in
[`native/spike/README.md`](../../native/spike/README.md).

## Setup

The measurement harness + step-by-step runbook live in
[`native/spike/`](../../native/spike/README.md) (a throwaway Capacitor app that
records fixes, evaluates the real `geofence.ts`, and shows the pass/fail numbers
below). In short:

1. `native/spike/README.md` steps 1–3 (install plugins, `npm run build:spike`,
   `cap add android`, permissions).
2. Grant **“Allow all the time”** location + allow the foreground-service
   notification.
3. In the spike app, **Set safe zone here** (~150 m) at a start point, then
   **Start watch**.

## Procedure & pass/fail

| # | Test | Method | Pass criterion |
|---|------|--------|----------------|
| 1 | Background fix cadence (screen locked) | Lock phone, walk; log every fix timestamp | A fix at least every **≤60 s** while moving (`distanceFilter` 25 m) |
| 2 | Geofence breach, app backgrounded | Walk out of the safe zone with the app backgrounded + screen locked | Breach `buildLocationSignal` published within **≤90 s** of leaving |
| 3 | Survives Doze / app standby | Leave the phone idle 30+ min, then move | Watcher still fires; no silent death |
| 4 | Reboot persistence | Reboot; do **not** open the app; move/breach | Document whether it resumes (likely needs a boot receiver — note the gap) |
| 5 | Alert delivery (de-Googled) | Publish a `help`/breach signal; second device subscribed | Received within **≤10 s** via relay socket and/or UnifiedPush |
| 6 | Battery cost | Run 1 & 2 over ~4 h of normal carry | Battery drain attributable to flock is **acceptable** (record %/h) |

## What to record

- Fix intervals (histogram), breach-detection latency, any gaps > 5 min.
- Whether the foreground-service notification is unavoidable (it is, by design —
  and that visibility is a UX/coercion consideration: a persistent "keeping
  watch" notification must not itself become a tell — see FLOCK.md §6).
- Battery %/hour with and without the watcher.
- UnifiedPush vs relay-socket delivery reliability.

## Decision gate

- **All of 1, 2, 3, 5 pass** → proceed to build the native shell (Phase 2).
- **1 or 2 fail** → reconsider: tune `distanceFilter`/accuracy, try
  `@transistorsoft/capacitor-background-geolocation` (paid), or accept reduced
  guarantees and make them explicit in the UI.
- **Battery (6) unacceptable** → motion-detection duty-cycling (transistorsoft) or
  a coarser cadence.
- **Layer-B probe (`native/gps-probe/`) red** → the platform isn't delivering
  locked GPS; a native pipeline (`canary-native`) won't fix sharing-when-locked on
  its own. Resolve location delivery (FGS type / "Allow all the time" / battery
  exemption — or accept degraded guarantees and state them in-app) *before* Phase 2.

## Notes

- iOS is a separate spike: confirm `CLLocationManager` region monitoring (20-fence
  cap) + background mode behave, and whether the installed PWA needs the native
  wrapper from day one (research §1.1 suggests yes for background).
- This spike only needs throwaway code — it is about **measurement**, not polish.
