# Goal: implement radar v2 — blindfold-grade guidance (flock)

**Date:** 2026-07-21 · **Status:** implementation goal · **Design:**
`docs/plans/2026-07-21-radar-navigation-v2.md` (source of truth)

## Context

Radar navigation failed a real in-car field test on 2026-07-21: navigating to a
dropped pin gave no usable direction or distance. The root causes were diagnosed
against the code and a full design was produced. **Read
`docs/plans/2026-07-21-radar-navigation-v2.md` first — it is the source of
truth for this work.** ROADMAP Slice 3 (docs/ROADMAP.md, radar section) tracks
it. Do not re-litigate the design; implement it.

## Scope

Implement **Phase 1** then **Phase 2** from the design doc. Phase 3 (BLE RSSI
endgame) is explicitly out of scope for this session — do not touch
capacitor-mesh-ble.

**Phase 1 — direction you can trust (fixes the car case):**

- Extend `Fix` (app/src/services.ts) with `heading`/`speed` from
  `coords.heading`/`coords.speed`; forward `accuracy` into the radar input.
  Native: use `Location.getBearing()/getSpeed()/getAccuracy()` guarded by
  `hasBearing()/hasSpeed()`; listen to `onAccuracyChanged` for compass quality.
- Heading engine (pure core): arbitrate compass vs GPS course by speed
  (≥3 m/s → course; <1 m/s → compass if accuracy usable; between → compass
  unless it disagrees with recent course by >60°, then course + "compass
  unreliable" status). Circular EMA smoothing, ±8° sign deadband.
- Mode machine (pure core): VECTOR / SEEK / HOMING with the design doc's
  enter/exit thresholds and hysteresis; manual override chip + Auto.
- VECTOR mode: GPS-course-only heading, big-arrow + huge-distance glanceable
  screen, landscape OK, `navigator.wakeLock` held while radar is open.
- Voice milestones (TTS): web `speechSynthesis` + native Android
  `TextToSpeech` in RadarGuideService (survives lock screen). Milestone
  crossings, sustained bearing change >30°, mode changes, degradations,
  arrival. Rate-limited ≥10 s. New Voice toggle bridged like `setMuted`.
  Distances via the existing `fmtDistance` (units preference).
- Stereo pan + turn-direction sign in SEEK: `StereoPannerNode` on web
  (`pan = clamp(relativeBearing/90, −1, 1)`), stereo PCM per-channel gain in
  the native AudioTrack path.

**Phase 2 — blindfold grade:**

- HOMING: continuous geiger cadence (≈1200 ms at 30 m → ≈250 ms at 3 m),
  rising pitch as range closes.
- Warmer/colder trend: smoothed d(distance)/dt; rising second note when
  closing (<−0.4 m/s), falling when receding. When distance < ~3× my fix
  accuracy, DROP the bearing/arrow entirely (it is GPS fiction) and guide by
  warmer/colder + cadence only, saying so.
- Honesty gate: `bearingUsable` additionally requires
  `distance > myAccuracy × bearingSlackFactor`.
- Arrival rework: fires at `max(arriveMetres, targetUncertainty,
  myAccuracy × 0.8)`; copy "Within GPS reach — look around".
- Signed haptic vocabulary between cadence bursts when off-beam: right = two
  short taps, left = one long buzz. Web `navigator.vibrate` + native
  `VibrationEffect` waveforms.
- Full locked-phone parity: everything above works in RadarGuideService with
  the screen locked.

## Hard constraints (non-negotiable)

- **Honesty invariants extend, never relax:** a coarse or stale target NEVER
  gains directional cues (no pan, no sign, no trend, no voice bearing); every
  audible cue keeps a haptic mirror; arrival silences with one haptic; Stop
  kills everything immediately. No new location acquisition — v2 changes
  presentation only, never precision/cadence/publishing.
- **Repo process:** pure-core changes start in **flock-kit**
  (`~/WebstormProjects/flock-kit`, `src/radar.ts`) — new pure functions
  (heading engine, mode machine, cue grammar v2, voice-line copy) with unit
  tests. Then port to Kotlin `RadarCore.kt` (never imports `android.*`) and
  extend the golden vectors (`npm run gen:vectors` — deliberate change, both
  sides regenerated together; JVM tests via `npm run test:native`, JDK 21).
  Then land in flock by updating the `@forgesworn/flock` SHA pin in
  package.json. **Never edit node_modules or restore a local src alias.**
- JS controller stays dumb: decisions in the pure core, sensors/DOM/audio in
  `app/src/radarMode.ts`, pure view helpers in `radarView.ts` (unit-tested).
- While the native guide runs it owns ALL audio/haptics/voice (no
  double-beep); JS keeps visuals. Keep that split.

## Verification

- flock-kit: its own test/lint/typecheck gates green before pinning.
- flock: `npm test`, `npm run typecheck`, `npm run lint`,
  `npm run test:native` all green; extend `e2e/radar.spec.ts` for mode
  transitions and degradations (full e2e suite is >10 min — target the spec
  with `-- e2e/radar.spec.ts`).
- Build the release APK from a CLEAN tree before any deploy.
- Field acceptance (human, Darren): car drive to a pin by voice alone;
  blindfolded 300 m park walk by sound/haptics; locked-phone pocket walk.
  Code-complete + suites green + APK on both phones = done for this session;
  flag the field tests as pending.

## Conventions

British English everywhere. Commits `feat:`/`fix:`/`docs:` — NO Co-Authored-By
lines. ESM-only, ES2022. Feature work on a branch with a PR per repo habit;
flock-kit and flock committed independently (flock-kit pushed first, then the
flock SHA-pin + app/native work).
