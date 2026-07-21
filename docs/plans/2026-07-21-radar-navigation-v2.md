# Radar navigation v2 — blindfold-grade guidance

**Date:** 2026-07-21 · **Status:** deep-dive design · **Owner:** flock-kit (pure core) + flock app + native
**Supersedes nothing** — extends `2026-07-09-radar-navigation-goal.md`, whose privacy/honesty
model is unchanged and non-negotiable.

## The one-sentence goal

Radar guidance good enough that a blindfolded person can walk to a pin, an item,
or a person — and a driver can follow it to a pin without ever reading the
screen — because direction, distance, and progress are all carried by sound and
haptics, not just pixels.

## Field report — what actually happened

Driving to a dropped pin with radar open was useless: no usable sense of
direction, no usable sense of distance. This is not a polish gap; four distinct
design faults compound in a vehicle, and three of them also break the on-foot
endgame. Each is grounded in the current code below.

### Fault 1 — the compass always wins, and in a car the compass is garbage

`effectiveHeading()` (app `radarMode.ts:199`, native
`RadarGuideService.effectiveHeading`) prefers the magnetometer heading whenever
one exists, falling back to GPS course over ground only when the compass is
*absent*. In a car the compass is present and **confidently wrong**: the phone
sits in a cradle (often magnetic), surrounded by steel, with the rotation
vector's gravity estimate corrupted by vehicle acceleration. So the scope
rotates to a fiction, the blip sits on the wrong side of the dial, and the
alignment tiers pick the wrong cadence. There is no plausibility check, and
`onAccuracyChanged` — Android's own "this sensor is unreliable" signal — is
an empty stub (`RadarGuideService.kt:104`).

Worse: GPS gives us course and speed **for free** and we throw them away.
`toFix()` (app `services.ts:16`) discards `coords.heading` and `coords.speed`;
the native `onLocationChanged` (`RadarGuideService.kt:84`) ignores
`Location.getBearing()`, `getSpeed()`, and `getAccuracy()`. The
`courseFromFixes` two-fix hack re-derives (badly, from 2 samples) what the chip
already computed (from Doppler, far more accurately, with a validity flag).

### Fault 2 — the cue grammar has no left/right, no trend, and no distance voice

`cueFor` (flock-kit `radar.ts:247`) encodes only the **magnitude** tier of the
angular error (aligned / near / off) and two distance tiers. It never says
*which way* to turn: standing still you can rotate-and-scan, but walking you
drift off-beam and don't know which way to correct, and driving you cannot scan
at all. There is no stereo panning, no rising/falling "warmer/colder" trend, no
spoken distance — `speechSynthesis` and Android `TextToSpeech` appear nowhere
in the codebase. Blindfolded (or driving), the current grammar communicates
almost nothing directional.

### Fault 3 — one interaction model from 50 km down to 2 m

The scope auto-zooms (`niceRange`, `radarView.ts:79`), but the *interaction* is
identical at every range: same rotate-to-scan model, same tier boundaries, same
screen. A vehicle approach, a half-mile walk, and a find-the-keys endgame are
three different tasks with different trusted sensors, different cue budgets,
and different screens. The goal doc's §2 "bearing finder" was designed for the
on-foot middle band and is simply the wrong instrument for the other two.

### Fault 4 — the endgame bearing is fiction and arrival is too tight

`bearingUsable` (flock-kit `radar.ts:198`) gates on the **target's** disclosed
uncertainty but ignores **my own fix accuracy**. At 12 m from a pin with a
typical 8 m urban fix, the me→target bearing swings wildly with every GPS
wobble — yet the scope keeps pointing confidently, and `arriveMetres: 2` (with
a pin's `uncertaintyMetres: 0`) means arrival may fire late or never while the
user orbits their own GPS noise. The last 30 metres — the part that must be
strongest for the blindfold bar — is currently the *least* honest part of the
product.

## Design overview

Three explicit guidance modes with auto-switching and manual override, fed by
one new **heading engine**, speaking one richer **cue grammar**. All decisions
stay in the pure core (flock-kit `radar.ts` + the Kotlin `RadarCore` port,
pinned to each other by golden vectors); controllers stay dumb.

```
sensors ──▶ heading engine ──▶ mode machine ──▶ guidance ──▶ cue grammar ──▶ audio / haptics / voice / screen
 (GPS course+speed, compass       (VECTOR /        (v2, honesty      (stereo, sign, trend,
  +OS accuracy, my fix accuracy)   SEEK / HOMING)    gates extended)    continuous cadence, TTS)
```

## The three modes

Mode selection is a pure function of distance, my speed, and signal quality,
with hysteresis so boundaries never flap. Manual override (a single mode chip
on the scope) pins a mode; "Auto" resumes. Every transition is announced by a
distinct earcon + optional voice line, so a blindfolded user always knows which
grammar they are hearing.

### VECTOR — vehicle / far approach

**Enter:** speed ≥ 5 m/s sustained ~5 s, OR distance > 2 000 m.
**Exit:** speed < 2 m/s for ~10 s AND distance ≤ 1 500 m.

- Heading source: **GPS course over ground only**. The compass is never
  consulted above the speed threshold (Fault 1). Direction is presented
  relative to my direction of travel, clock-face style — the driver never
  points the phone at anything.
- Voice is the primary channel: "800 metres, ahead on your left",
  re-announced on milestone crossings (2 km, 1 km, 500 m, 250 m — unit-aware
  via `fmtDistance`) and on sustained relative-bearing change > 30°. Earcons
  stay sparse — a driver needs prompts, not a metronome.
- Screen (glanceable, large): one big arrow rotated by
  (bearing − course), distance in the largest type on the page, closing
  speed beneath it. Landscape supported. Screen wake lock
  (`navigator.wakeLock`) held while radar is open — today the screen can
  sleep mid-drive and freeze the visuals.
- Honesty: with no course (stationary at lights) the arrow greys out and the
  last spoken direction stands; we never substitute the compass in a vehicle.

### SEEK — on foot, ~30 m to ~2 km

**The current experience, upgraded.** Compass heading-up scope, Alien tracker
visual language retained.

- Cue gains **turn direction**: stereo panning (burst pans toward the correction
  side) and a signed haptic vocabulary (below). Cadence/pitch still encode
  alignment tier and distance band, so existing muscle memory survives.
- Heading engine arbitration (below) replaces compass-always-wins; a walking
  user with a disturbed compass (bag magnet, cycle frame) degrades to course
  over ground with a plain "compass unreliable — using your walking direction"
  status instead of confidently wrong pointing.
- Voice milestones optional and sparser than VECTOR (100 m steps, off by
  default on foot — earcons carry the load).

### HOMING — the last ~30 m: person in a crowd, keys in a field, car in a car park

**Enter:** distance < 25 m. **Exit:** distance > 40 m (hysteresis).
Only offered when the target is precise (uncertainty ≤ ~10 m) — a coarse share
never gets a homing endgame, exactly as today's honesty rules demand.

- Cadence becomes **continuous, not tiered**: burst period interpolates with
  distance (≈1 200 ms at 30 m → ≈250 ms at 3 m) — the geiger-counter endgame.
  Pitch rises as range closes.
- **Warmer/colder trend** replaces the bearing when the bearing stops being
  honest: when distance < ~3× my fix accuracy, the me→target bearing is
  GPS-noise fiction (Fault 4), so the arrow is *dropped* — the scope switches
  to an expanding hot-zone ring, and the cue carries a rising second note when
  closing (smoothed d(distance)/dt < −0.4 m/s) and a falling one when receding.
  Blindfolded, warmer/colder plus geiger cadence is sufficient and honest;
  a confident-but-random arrow is neither.
- Arrival rework: `arrived` fires at
  `distance ≤ max(arriveMetres, targetUncertainty, myAccuracy × 0.8)` and the
  copy says what is true: "Within GPS reach — look around / feel around."
  One confirming haptic, then silence, as today.
- Phase 3 adds BLE RSSI assist for member targets (below) — the only sensor
  that keeps working indoors and resolves the final 5 m in a crowd.

## The heading engine

One pure function, one owner of "which way am I facing", shared by JS and the
Kotlin port. Inputs: compass heading + platform accuracy grade, GPS course +
speed + fix accuracy (all newly surfaced — Fault 1), and timestamps.

Arbitration rules:

1. speed ≥ 3 m/s → **course** (Doppler course is excellent when moving; the
   compass is at its worst exactly then).
2. speed < 1 m/s → **compass**, if its platform accuracy grade is usable
   (`onAccuracyChanged` finally listened to; `SENSOR_STATUS_UNRELIABLE` or
   `_LOW` → compass rejected).
3. In between, prefer compass, **unless** compass and recent course disagree
   by > 60° — then course wins and the UI surfaces "compass unreliable".
4. No usable source → honest `no-heading`, as today.

Output: `{ headingDeg, source: 'compass'|'course'|null, confidence }` — the
guidance and the status line both consume it, so the screen never claims a
source the cue isn't using. Displayed bearing gets circular EMA smoothing with
a per-mode alpha (fast in VECTOR, damped in HOMING) and a ±8° deadband on the
turn-direction sign so left/right never ping-pongs on the beam.

Plumbing this needs `Fix` to grow: `{ heading?: number|null, speed?:
number|null }` from `coords.heading`/`coords.speed` (web) and
`Location.getBearing()/getSpeed()` guarded by `hasBearing()/hasSpeed()`
(native), plus `accuracy` finally forwarded into `RadarInput` as
`myAccuracyMetres`.

## Cue grammar v2

The `RadarCue` shape grows; the beep vocabulary keeps its Alien-tracker soul.

| Channel | Encodes | How |
|---|---|---|
| Cadence (burst period) | Distance | Tiers in SEEK (as today); continuous interpolation in HOMING |
| Pitch | Alignment tier + proximity | As today, plus rising pitch as HOMING closes |
| **Stereo pan** | **Turn direction** | `pan = clamp(relativeBearing / 90, −1, 1)`; on-beam = centred. Web: `StereoPannerNode`. Native: stereo PCM with per-channel gain |
| **Trend note** | Closing / receding | Second note per burst, rising when closing, falling when receding (HOMING; VECTOR voice says it instead) |
| **Haptic sign** | Turn direction, eyes/ears-free | Between cadence bursts when off-beam: **right = two short taps**, **left = one long buzz**. On-beam = cadence only. Learnable in one minute, works in a pocket |
| **Voice (TTS)** | Distance + direction milestones, mode changes, degradations, arrival | Web `speechSynthesis`; native Android `TextToSpeech` inside `RadarGuideService` so it survives the lock screen. Rate-limited (≥ 10 s between lines, arrival excepted). Uses `fmtDistance` so units follow the preference |

Controls stay minimal: the existing Sound toggle, one new Voice toggle, Stop.
Haptics remain always-on while radar runs (they are the pocket channel), as
today. Every audible cue keeps its haptic mirror — the existing invariant.

Honesty invariants extended, not relaxed:

- Pan/sign/trend only exist when `bearingUsable` — a coarse or stale target
  still gets the sparse dull pulse with **no** directional content.
- `bearingUsable` additionally requires `distance > myAccuracy ×
  bearingSlackFactor` (Fault 4) — my own bad fix now degrades pointing exactly
  like the target's disclosed uncertainty always has.
- Voice lines state degradations plainly ("their location is stale") and never
  speak a bearing the cue wouldn't beep.

## Screens

- **VECTOR:** big arrow + huge distance + closing speed; landscape; wake lock.
- **SEEK:** today's scope + a mode chip, north marker, honesty band — plus the
  heading-source status when degraded.
- **HOMING:** hot-zone rings + geiger visual pulse synced to the audio bursts;
  the arrow only while the bearing is honest, warmer/colder wording after.
- All three: same header (who/what, freshness), same big Stop, same status
  line vocabulary. One radar, three faces.

## BLE RSSI assist (member targets, Phase 3)

GPS cannot finish the job indoors or in a dense crowd. Both phones already run
the BLE mesh (`capacitor-mesh-ble`), and Android hands us signal strength today
— `ScanResult.getRssi()` in the plugin's scan callback
(`MeshBlePlugin.java:1212`) and `BluetoothGatt.readRemoteRssi()` on live
connections — we just don't surface it.

- Plugin change: expose per-peer RSSI. **Attribution rule:** RSSI is only
  attributed to the radar target over an **identified GATT connection** (the
  mesh knows which member it authenticated) — never from a raw circle advert,
  because advert UUIDs are circle-scoped, not member-scoped (`bleId.ts`), and
  "some circle member is close" must not be presented as "Alex is close".
- Pure core takes `bleProximity: 'immediate' | 'near' | 'far' | null` derived
  from a median-filtered RSSI window mapped to **bands only** — RSSI-to-metres
  is pseudo-science and we will not speak numbers from it.
- HOMING blends it in only when GPS agrees the target is near (< 50 m) and
  prefers it when GPS accuracy collapses (indoors). Copy stays honest:
  "very close by Bluetooth".
- Privacy: consumes the existing members-only mesh; no new adverts, no new
  identifiers, nothing published, off when mesh is off.

Pins have no radio — the pin endgame is carried by the GPS warmer/colder work
in Phase 2, which is why that lands first.

## Locked-phone parity

Every Phase 1–2 behaviour lands in `RadarGuideService` in the same phase, not
later — the pocket/locked case is the blindfold case:

- Use `Location.getBearing()/getSpeed()/getAccuracy()`; heading engine port;
  compass accuracy via `onAccuracyChanged`.
- Native TTS for voice lines while locked (respecting the same Voice toggle,
  bridged like `setMuted`).
- Stereo bursts via stereo `AudioTrack`; signed haptic vocabulary via
  `VibrationEffect` waveforms.
- Mode machine runs natively from the same pure port; parity pinned by
  extending the golden vectors (`compatibility/v1/radar-vectors.json`,
  `npm run gen:vectors`, JVM tests in `native/crypto-tests`) to cover the
  heading engine, mode machine, pan/sign/trend, and the new arrival rule.

## Where the code lands (repo process)

Pure-core changes begin in **flock-kit** (`src/radar.ts`), pass its gates, then
land in **flock** as an explicit SHA pin update — the established process.

1. **flock-kit:** heading engine, mode machine, cue grammar v2, honesty-gate
   extensions (`myAccuracyMetres`), arrival rework, voice-line copy function,
   BLE proximity banding. All unit-tested; vectors regenerated.
2. **flock app:** `services.ts` Fix extension + wake lock; `radarMode.ts`
   consumes the new core, adds `StereoPannerNode`, `speechSynthesis`, Voice
   toggle, mode chip; `radarView.ts` mode layouts; e2e `radar.spec.ts` grows
   mode-transition and degradation coverage.
3. **flock native:** `RadarCore.kt` port parity; `RadarGuideService.kt` sensor
   upgrades, TTS, stereo, haptic vocabulary; bridge additions in
   `native/radarGuide.ts` (voice toggle, mode surfacing).
4. **capacitor-mesh-ble** (Phase 3): RSSI surfacing per identified peer.

## Field acceptance tests

The feature ships when these pass on real hardware, not when the suites are
green:

1. **Car test (the one that failed):** drop a pin, drive a 2–3 km loop away,
   navigate back by voice + glances only. Pass = every voice line's
   direction matches reality; distance countdown monotonic sensible; no
   compass-poisoned pointing at any moment.
2. **Blindfold walk (the bar):** pin in an open park, start 300 m away,
   blindfold on, spotter alongside. Pass = reach within `max(arrive,
   myAccuracy)` of the pin by sound/haptics alone, including at least one
   deliberate wrong turn corrected by the left/right cues, and the warmer/
   colder endgame terminating the approach.
3. **Pocket test:** same walk, phone locked and pocketed, haptics + voice
   only (Android/GrapheneOS).
4. **Person-in-crowd (Phase 3):** two phones, busy street or building;
   approach from 500 m; BLE endgame resolves the last metres indoors.
5. **Honesty checks:** coarse share never emits directional cues; stale
   degrades mid-walk within the window; magnetic-mount compass corruption is
   detected and reported while course guidance continues.

## Delivery phases

- **Phase 1 — direction you can trust (fixes the car):** Fix/heading/speed
  plumbing, heading engine + compass distrust, VECTOR mode + big-arrow screen
  + wake lock, voice milestones (web + native TTS), stereo pan + turn sign in
  SEEK, mode machine + chips. *Acceptance tests 1 and 5.*
- **Phase 2 — blindfold grade:** HOMING continuous cadence, warmer/colder
  trend, my-accuracy honesty gate + arrival rework, signed haptic vocabulary,
  full locked-phone parity. *Acceptance tests 2 and 3.*
- **Phase 3 — precision assist:** mesh RSSI surfacing, identified-peer
  attribution, HOMING blend, indoor/crowd calibration. *Acceptance test 4.*

## Non-goals (unchanged from the goal doc, restated where new surface appears)

- No silent precision/cadence raising — every mode consumes only the existing
  disclosed beacon; VECTOR/HOMING change *presentation*, never *acquisition*.
- No numeric distance claims from RSSI; bands and trend only.
- No UWB/ARKit-style precision promises; if hardware UWB ever matters it is a
  separate design.
- No turn-by-turn road routing — VECTOR gives beeline vector + distance; the
  driver owns the road network. (A "open in OsmAnd/Organic Maps" escape hatch
  from VECTOR is a cheap Phase 1 nicety worth considering — see open
  questions.)

## Open questions

1. VECTOR voice grammar: clock-face ("at your 2 o'clock") vs left/right
   language ("ahead on your right")? Left/right is proposed — clock-face is
   precise but demands more parsing while driving.
   **RESOLVED by the 2026-07-21 field test: clock-face, everywhere.** Shipped
   as radar v2.1 (see addendum below).
2. Should VECTOR offer a one-tap handoff to a real navigation app
   (`geo:` intent) for the road-network part of a long approach, keeping
   radar for the final unmapped stretch (car parks, fields, festivals)?
3. Voice default: on in VECTOR, off in SEEK/HOMING — right call, or should
   first-run ask once?
4. iOS PWA: `speechSynthesis` and `StereoPannerNode` work foregrounded, so
   Phases 1–2 largely apply; confirm `DeviceOrientationEvent` accuracy
   handling per iOS version, and keep the locked-iPhone non-promise.
5. Haptic vocabulary: is long-left / double-short-right the most learnable
   signing, or should it mirror the "turn toward the buzz side" convention of
   dual-motor wearables (phones have one motor — signing is forced)?

## Addendum — v2.1 (first field test, 2026-07-21)

The first two-phone field test surfaced four findings; v2.1 answers them
without touching acquisition (precision/cadence invariants unchanged):

1. **"The screen doesn't update as they move."** Diagnosis: the pipeline is
   event-driven end to end and correct — but beacons are deliberately
   cell-gated and rate-floored (≥45 s even at Exact), so between disclosures
   the scope only shifts with the watcher's own motion. On a short walk that
   honestly reads as frozen. Consumer-side fixes (no wire change): each
   landing disclosure is now unmissable — the moved pulse gained a spoken
   twin ("They've moved — 300 metres, at your 2 o'clock"), and the minute
   line (below) re-states range even between moves. If livelier tracking is
   ever wanted it is a *cadence-policy* decision (COARSE_MIN_INTERVAL), not a
   radar one.
2. **Clock-face voice + minute cadence.** All voice directions are clock-face
   now ("at your 3 o'clock"), and every mode speaks a minute-cadence
   "<range>, at your <clock>" line (range-only when the bearing isn't
   honest). Ranges are rounded to a 23-step speakable ladder so every line is
   clip-composable offline (GrapheneOS may ship no TTS engine). Clips rebaked:
   clock-1..12 + the full ladder; dir-* retired.
3. **"It didn't act like a compass when I set the phone down."** Two causes,
   both fixed. (a) The Doppler course kept its last walking value at rest —
   courses are now trusted only on a fresh fix at ≥ courseMinSpeedMps
   (1 m/s). (b) The Capacitor WebView's deviceorientation is not
   earth-referenced, so JS never had a real compass — the guide service's
   rotation-vector heading is now mirrored into the WebView over a throttled
   'heading' plugin event and owns the scope's heading while fresh.
4. **"Could others see me move while I was in radar mode?"** Yes — radar
   changes nothing about publishing (it never has). The same cell-gate +
   45 s floor as (1) applies to the watcher's *own* beacons; at coarse
   precisions (< Street) movement inside one cell is invisible *by design*.
