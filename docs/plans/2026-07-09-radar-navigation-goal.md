# Goal - live radar navigation to a person

**Date:** 2026-07-09 · **Status:** goal/design · **Owner:** flock app + native

## The one-sentence goal

Let someone pick a trusted person in their circle, hold their phone without
staring at it, turn on the spot until audio/haptic feedback points them in the
right direction, lock the screen if they want to, then walk toward a live,
moving target whose updates are immediately obvious.

This is not "show their dot on a map". It is person-to-person navigation for the
last few hundred metres: a phone becomes a private compass, range finder, and
motion tracker for meeting a friend.

## Why this matters

The current map answers "where were they last seen?" Radar navigation answers
"which way do I turn right now?" That is the real use case in a crowd, a dark
street, a festival, a station, a beach, or a city centre after a night out.

The field case is concrete: someone is half a mile away trying to find the
group. They should not have to walk with an unlocked phone in their hand,
staring at a map. They should be able to start navigation, lock the phone, keep
it in hand or pocket, and follow the tones. Every so often they may unlock to
check the motion-tracker view and confirm progress, then lock it again.

Looking down at a map is slow, conspicuous, and fragile. You have to unlock the
phone, orient the map, decide which street or path matches reality, and keep
checking it while both people are moving. The desired interaction is simpler:

1. Select Alex.
2. Hold the phone naturally.
3. Stand still and rotate.
4. The tone/haptic pattern makes the correct bearing obvious.
5. Lock the phone if desired.
6. Start walking and keep following the changing cue.
7. Occasionally unlock for a visual progress check.

Both sides can be moving, so the target is not a waypoint. When Alex's phone
publishes a fresher location, the radar must react in a way the user can feel or
hear immediately: the range changes, the bearing shifts, and the tracker blip
moves. If the cue stays quiet while the target has moved, the feature lies by
omission and sends the user to a stale place.

## User promise

When radar navigation is active:

- I can select one person from my group and navigate toward them without staring
  at the screen.
- I can lock the phone and keep navigating by ear/haptics, then occasionally
  unlock to check visual progress.
- If I stand still and turn around, the feedback clearly identifies the direction
  I need to travel.
- The screen feels like an Alien-inspired xenomorph motion tracker: dark
  phosphor display, sweep/range rings, selected target blip, distance, accuracy,
  freshness, and movement. It should evoke the instrument, not copy a film frame
  or prop UI exactly.
- Audio uses the recognisable approach grammar: "beep ... beep ... beep beep ...
  beep beep beep" as the user gets more aligned and/or closer, with a duller,
  slower pulse when off-bearing or stale.
- Haptics mirror the same signal, so it works in a noisy place or with the sound
  muted.
- When the selected person moves or publishes a fresher fix, I can tell without
  needing to inspect the map.
- If the target's location is stale, coarse, capped by a no-report zone, or not
  accurate enough, the UI says so and the cue degrades instead of pretending to
  be precise.

## Privacy and consent boundaries

Radar navigation must not create a hidden exact-tracking path.

- It can only navigate to location data the selected person has already chosen
  to disclose to this member or circle.
- It must never silently raise another person's precision. A "radar session"
  that needs live exact updates must be explicit, time-boxed, and visible on the
  other device, reusing the same consent posture as "Come to me" or a future
  mutual meetup mode.
- If the target is sharing a coarse geohash cell, the radar shows the cell/range
  uncertainty, not a fake precise bearing to the centre as if it were truth.
- No-report zones still cap or withhold location. Radar must display "private
  area / unavailable" rather than route around that policy.
- The target selection is local UI state. It should not be published as "Darren
  is tracking Alex" unless a future mutual radar session deliberately needs a
  request/accept protocol.
- Server/relay visibility does not change: all beacons and signals stay
  gift-wrapped exactly like the rest of flock.

The honest model: radar is a better way to consume a permitted disclosure, not a
new power to obtain one.

## Product shape

### 1. Select a target

From a member row, member sheet, map pin, or private chat:

- "Navigate to Alex" starts a local radar view when Alex has a usable recent
  location.
- If Alex is coarse/stale, the CTA becomes "Ask Alex to share live exact" or
  "Ask Alex to come to me", depending on the current consent surface.
- The selected target is always obvious and easy to stop. Stop must silence
  audio and haptics immediately.

### 2. Bearing finder

The phone computes:

- my latest fix,
- the selected target's disclosed location or disclosed area,
- distance and bearing from me to target,
- device heading from compass/orientation sensors,
- angular error between where the phone points and where the target is.

When standing still, rotating the phone should be enough to find the direction:

- aligned: strongest/brightest tone, short haptic confirmation, target blip
  centred;
- slightly off: stereo/pitch/cadence indicates left or right correction;
- far off: sparse dull pulse or side-biased haptic;
- unreliable heading: switch to a "walk a few steps" fallback using GPS course
  over ground.

### 3. Alien-style motion-tracker screen

The visual should be inspired by the Alien/xenomorph motion tracker language,
not a literal copy of any film UI:

- dark high-contrast phosphor/CRT feel,
- circular or arced sweep with range rings,
- chunky selected-target blip that jumps/moves when a fresh fix lands,
- distance number with units,
- freshness ("just now", "18 s old", "stale"),
- accuracy/uncertainty band,
- movement indicator if the target has moved between fixes,
- degraded/ghosted target state when stale,
- warning/error treatment for no heading, poor GPS, coarse target, or stale
  target.

The map remains available, but the radar view is the primary experience for this
mode.

### 4. Beep grammar

The sound is not a generic notification. It is the core navigation language.

- Baseline far/uncertain: slow isolated "beep ... beep ... beep".
- Correcting toward the bearing: beeps tighten and brighten.
- Aligned but still distant: a confident repeating pair, "beep beep ... beep
  beep".
- Close and aligned: short bursts, "beep beep beep", with haptics matching the
  rhythm.
- Target moved meaningfully: interrupt with a distinct sweep/pulse, then resume
  the new bearing cadence.
- Stale/coarse/private: degrade to a low, sparse pulse and do not imply a precise
  bearing.
- Stop or arrival: silence immediately, with one short confirmation haptic.

### 5. Clean UI/UX bar

The tracker has to feel obvious under pressure. A half-mile approach after dark
is not the moment for a clever interface.

- One selected person, one dominant range/bearing surface, one obvious Stop.
- No nested cards, dense settings, or explanatory chrome inside radar mode.
- The first screen answers only four questions: who am I following, how far, is
  the location fresh, and which way should I turn?
- The visual language can be dramatic, but the controls must stay quiet:
  target name, distance, freshness, uncertainty, sound/haptic state, stop.
- Target selection comes from places people already understand: member row, map
  pin, private chat, or "Come to me" flow.
- Permission prompts must be staged before the person starts walking: location,
  heading/orientation, sound, and native locked-mode notification where needed.
- Degraded states must be plain: "stale", "coarse area", "no compass", "private
  area", "open phone to refresh", not cryptic sensor errors.
- Unlocking for a visual check must land straight back on the same tracker state,
  not a home screen or settings panel.
- The mode should be glove/night-out friendly: large Stop, large sound toggle,
  high contrast, no tiny map controls as the primary UI.

### 6. Moving-target updates

The feature succeeds only if target updates are felt quickly.

- Incoming fresh beacons for the selected target update the radar immediately.
- A meaningful target movement triggers a distinct "target moved" pulse/beep so
  the user knows the direction changed.
- Local movement also updates the bearing and distance continuously from the
  user's own GPS fixes.
- Smoothing may reduce jitter, but must never hide freshness, staleness, or a
  real change in target position.
- The cue must include age. A strong cue to a 5-minute-old target is worse than a
  degraded cue that admits the target is stale.

For active mutual navigation, normal background cadence may be too slow. A
time-boxed radar session should be allowed to temporarily raise exact publish
cadence and GPS sampling for the participants, with obvious battery/privacy copy
and automatic expiry.

### 7. Locked-phone guide mode

The half-mile meetup use case requires a mode that survives the screen turning
off on Android/GrapheneOS:

- Start must be deliberate from an unlocked app screen.
- Once active, audio and haptics continue while the phone is locked.
- The user can unlock at any time and see the current radar state immediately:
  distance travelled, remaining range, target freshness, and whether the target
  moved.
- The lock-screen notification should expose as little as practical. Prefer
  "Radar active" over naming the selected person unless the user opts into richer
  lock-screen text.
- The user must be able to stop quickly from the app, and the native foreground
  service notification should provide a stop action if the platform permits it.
- If locked operation loses target freshness, the tone degrades to "stale" rather
  than continuing to guide confidently.

### 8. Platform target

The platform bar is deliberately asymmetric for v1:

- **Android / GrapheneOS:** locked-phone by-ear navigation should work. This is
  the hard requirement because it matches the field problem: start radar, lock
  the phone, follow the beeps, occasionally unlock to check progress.
- **iPhone PWA / web:** foreground/open-phone radar is acceptable. The iPhone
  user can keep the PWA open for the Alien-style tracker and audio cue, but v1
  must not promise reliable locked-screen by-ear guidance from the web app.
- **Native iOS:** future route if we decide iPhone must also support locked
  navigation; not required for the first useful radar slice.

## Technical plan

### Pure app logic first

Add a small pure module for the math and cue state:

- distance and bearing between coordinates,
- angular error between bearing and device heading,
- target freshness/staleness classification,
- coarse-cell uncertainty handling,
- cue intensity/cadence/pitch/haptic pattern from distance + angular error +
  freshness,
- movement classification from successive target fixes.

This should be unit-tested before UI work so the privacy and stale-data rules do
not live only in DOM code.

### Foreground PWA prototype

Build radar mode in the app while foregrounded:

- target selection from existing member surfaces,
- DeviceOrientation/compass heading where available,
- Web Audio beeps/tones,
- `navigator.vibrate` haptics where available,
- radar visual view,
- live update from existing presence cache and incoming beacon path.

This proves the interaction without adding a new protocol. It is not enough for
the real field case, because a backgrounded/locked WebView cannot be trusted to
keep audio, haptics, heading, GPS, or inbound target updates alive.

### iPhone PWA support boundary

Flock is already installable as an iPhone Home Screen web app
(`display:"standalone"` plus `apple-mobile-web-app-capable`). That is enough for
an app-like launcher and foreground radar UI. That is acceptable for iPhone/web
v1.

Expected iPhone PWA support:

- **Yes:** Alien-style visual tracker while the PWA is open.
- **Yes:** foreground audio beeps after a user gesture, subject to iOS audio
  rules.
- **Yes, with permission:** foreground heading/orientation where Safari exposes
  `DeviceOrientationEvent` / `DeviceMotionEvent`.
- **Maybe / best effort:** background audio continuing after lock. Treat as a
  device/iOS-version behavior to test, not the foundation of the product promise.
- **No reliable PWA promise:** live locked-screen bearing updates, custom haptic
  patterns, continuous heading/GPS processing, and selected-target relay updates
  while the WebView is suspended.

So the iPhone PWA v1 should degrade honestly:

- open/awake radar = full visual + audio guidance;
- locked iPhone PWA = not a promised mode; if best-effort audio happens to work
  on a given iOS version, treat it as extra, not core behavior;
- if iPhone ever needs the same locked-phone promise as Android/GrapheneOS, build
  a native iOS shell using Core Location, native audio, and Core Haptics.

Do not market "navigate by ear while locked" to iPhone PWA users until it passes
an actual locked-screen field test on recent iOS hardware.

### Native Android locked-mode hardening

For production-quality use on Android/GrapheneOS:

- run active radar as a user-started foreground service while the phone is
  locked,
- keep local GPS/course, heading sensors, audio beeps, and vibration patterns in
  native code while the WebView is suspended,
- keep the selected target's latest permitted location available to native code,
- receive selected-target updates while locked via the native inbound-relay path,
  or explicitly mark target freshness stale if native inbound is not yet present,
- prefer native heading sensors when browser orientation is missing or noisy,
- route haptics through native vibration APIs for reliable patterns,
- keep audio session behaviour predictable when the screen is dimmed,
- integrate with the existing native GPS/background publish work,
- verify the mode on real devices outdoors and in a noisy setting.

### Optional active radar session

If foreground-only consumption of existing beacons is not responsive enough,
design a separate "live radar session":

- requester asks one person for temporary exact live navigation,
- target accepts or has an explicit pre-authorised meetup mode,
- both devices visibly show the session,
- precision/cadence lift is time-boxed,
- no-report zones still apply,
- stopping the session returns cadence/precision to the prior state.

This should be a protocol change only if the existing "Come to me" and beacon
paths cannot meet the moving-target requirement.

## Success criteria

Field success means:

- Two phones are outdoors on real mobile data or hotspot.
- A selects B and starts radar mode.
- B starts roughly half a mile away.
- A can stand still, rotate, and reliably identify B's direction by tone/haptic
  feedback without looking at the map.
- A locks the phone and starts walking; distance trends down when moving
  correctly.
- A occasionally unlocks and sees current progress immediately, then locks again
  without breaking guidance.
- B changes direction or keeps walking; A receives an obvious update and the
  bearing/range changes while locked, without reopening or refreshing anything.
- If B stops publishing, the cue becomes stale within the expected window.
- If B is sharing coarse-only, A gets uncertainty/range guidance but not a fake
  exact pointer.
- Audio can be muted and haptics still make the bearing usable.
- Stop kills the tones/haptics immediately.

## Non-goals

- No silent remote exact tracking.
- No promise of indoor precision where GPS/compass cannot support it.
- No background microphone, camera, or always-on sensor use outside the active
  navigation session.
- No permanent movement history.
- No new relay-visible tracking metadata.

## Open questions

1. What is the first public name: "Radar", "Find friend", "Navigate to Alex", or
   "Rally mode"?
2. Should v1 only consume already-shared exact beacons, or should it include the
   request/accept radar session from the start?
3. What update cadence is acceptable for active mutual navigation: 5 s, 10 s, or
   movement-triggered with a hard floor?
4. Should the phone point direction be the top edge, camera direction, or walking
   direction inferred after a few steps?
5. How should the audio behave around other media: duck, mix quietly, or require
   an explicit "sound on" toggle?
