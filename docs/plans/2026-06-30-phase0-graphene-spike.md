# Phase 0 — GrapheneOS background-location spike

**Date:** 2026-06-30 · **Owner:** TBD · **Status:** not started

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

## Devices

- A **GrapheneOS** phone, **no** Google Play Services, **no** sandboxed Play
  services. (Optionally a second run *with* sandboxed Play services to compare.)
- For contrast: one stock Android and one iPhone.

## Setup

1. `native/README.md` steps 1–4 (install, `cap add android`, permissions).
2. Grant **“Allow all the time”** location + allow the foreground-service
   notification.
3. Create a circle, define one small safe zone (~150 m) around a start point.

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

## Notes

- iOS is a separate spike: confirm `CLLocationManager` region monitoring (20-fence
  cap) + background mode behave, and whether the installed PWA needs the native
  wrapper from day one (research §1.1 suggests yes for background).
- This spike only needs throwaway code — it is about **measurement**, not polish.
