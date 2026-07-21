# Radar — the road to world's best

**Date:** 2026-07-21 · **Status:** items A + C SHIPPED (flock main e32dc7c); B designed, kit core shipped · **Owner:** flock-kit + flock + capacitor-mesh-ble

## Status (end of 2026-07-21 session)

- **A — BLE RSSI assist: SHIPPED.** capacitor-mesh-ble b8f9402 (attributed
  RSSI + MeshBleRssiBus), flock-kit b8429b0 (banding/blend/hold/voice),
  flock e32dc7c (JS + locked-phone parity, JVM vectors green). Awaiting the
  indoor person-in-crowd field test (radar-v2 acceptance test 4).
- **B — radar session: designed** (`2026-07-21-radar-session-design.md`);
  kit pure rules shipped (`radarSession` module, kit 41ebde9). App/native
  implementation is the next slice.
- **C — quick wins: SHIPPED** in e32dc7c (geo: hand-off chip, wake-lock
  renewal both sides). The 500 ms tick-lag item remains open.
- **NEW (field feedback, same day): universal direction callouts SHIPPED** —
  a changed clock hour ("3 o'clock" → "2 o'clock") is always spoken, every
  mode, boundary-sticky (6° hysteresis), own 5 s floor, web + locked-phone.
- **NEW: quality pass SHIPPED** — two-layer sonar ping (web + native PCM
  parity), phosphor sweep decay, breathing blip + echo ring, CRT overlay.
  Voice clip set complete 46/46 (OpenAI TTS bake, incl. state-ble-close).
- **Deploy:** phones still run the pre-session build — needs `apk:release`
  on a clean tree + deploy, then the field tests.
**Grounding:** `docs/research/2026-07-21-radar-competitive-landscape.md` (market),
`docs/plans/2026-07-21-radar-navigation-v2.md` (design, incl. v2.1 addendum),
`docs/plans/2026-07-09-radar-navigation-goal.md` (privacy model, unchanged and non-negotiable).

## The claim we are building toward

The competitive research found the unclaimed position: *spoken, stereo, haptic
guidance to a moving person — driving, walking, or phone locked in a pocket —
that tells the truth when its sensors can't, E2E-encrypted, no account, no
extra hardware.* v2.1 already owns most of that. "World's best" means closing
the three gaps the research says competitors still win on, without spending
any of the honesty or privacy invariants that make the position defensible:

1. **The last 5 m indoors** — Apple UWB resolves it; our HOMING honestly
   degrades. Fix: **Phase 3 BLE RSSI assist** (designed in radar-v2, unbuilt).
2. **Perceived liveliness** — Zenly-style apps update in seconds; our ≥45 s
   cell-gated beacon floor reads as frozen. Fix: **consented radar session**
   (designed in the v1 goal doc §"Optional active radar session", unbuilt).
3. **Long-approach ergonomics** — VECTOR gives a beeline; drivers still want
   the road network. Fix: **`geo:` hand-off** (open question 2, resolved: yes).

Plus two implementation debts the audit flagged: the ~8 min partial wake lock
cap and the 500 ms tick lag in VECTOR.

## Work items

### A. BLE RSSI assist (Phase 3 of radar-v2) — flock-kit + capacitor-mesh-ble + flock

The honesty rules from the design doc, restated as the implementation contract:

- **Attribution:** RSSI is attributed to the radar target ONLY via an
  identified mesh peer — a MAC address bound to an authenticated member by the
  existing GATT frame exchange (`peerAddresses` in `MeshBlePlugin`). Raw
  circle adverts are never attributed ("some member is close" ≠ "Alex is
  close"). Both sources are used once a MAC is bound: `readRemoteRssi()`
  polling on client links, and scan-result RSSI for bound MACs.
- **Bands only:** RSSI → `'immediate' | 'near' | 'far' | null` via a
  median-filtered window. No metres are ever derived or spoken from RSSI.
- **Blend, never acquire:** BLE proximity may (a) floor the HOMING cadence,
  (b) hold HOMING against GPS wobble, (c) speak "Very close — by Bluetooth".
  It never creates a bearing, never relaxes the coarse-share rule
  (uncertainty > 50 m ⇒ no blend, ever), never enters HOMING for a target
  that GPS doesn't already place near (≤ 50 m), and is off when mesh is off.
- **Direction stays GPS-honest:** pan/sign/arrow remain gated on
  `bearingUsable` exactly as today. BLE affects cadence, mode hold, and voice.

Landing order (the established kit-first process):

1. **flock-kit** `src/radar.ts`: `BleProximity` type; `bleProximityFromRssi`
   (pure median → band); `RADAR` constants (`bleImmediateRssi: -60`,
   `bleNearRssi: -80`, `bleAssistMaxMetres: 50`, sample window/freshness);
   `CueContext.bleProximity` + HOMING cadence floor; `ModeInput.bleProximity`
   + HOMING hold; `VoiceEvent 'ble-close'` + line. Unit tests + append-only
   vector groups.
2. **capacitor-mesh-ble**: `startRssiSampling({ intervalMs })` /
   `stopRssiSampling()`; `rssi` event `{ peer, address, rssi, source:
   'gatt'|'advert', at }`; client-link `readRemoteRssi` polling; attributed
   scan RSSI for bound MACs; web no-op; a native `MeshBleRssiBus` static
   registry so the flock `RadarGuideService` (same process, different package)
   can consume samples while locked.
3. **flock app**: `radarMode.ts` subscribes for the selected target's member
   id, keeps the rolling window, feeds `bleProximity` into cue/mode/voice;
   pin bump to the new kit SHA.
4. **flock native**: `RadarCore.kt` parity for banding/blend/hold (JVM tests
   against the extended vectors); `RadarGuideService` consumes the RSSI bus —
   locked-phone parity in the same phase, per the design doc's rule.

### B. Consented radar session — the liveliness fix (design first)

The v2.1 field test's #1 finding ("the screen doesn't update as they move")
is a cadence-policy fact, not a radar bug. The fix is the v1 goal doc's
"active radar session": requester asks, target accepts (or has pre-authorised
a meetup mode), both devices visibly show the session, precision/cadence lift
is time-boxed with automatic expiry, no-report zones still apply. Deliverable
this pass: a full design doc (protocol events, consent surfaces, cadence
values, expiry, coercion analysis) — implementation is its own slice.

### C. Quick wins — flock app

- **VECTOR `geo:` hand-off:** one chip on the VECTOR screen opening
  `geo:lat,lon?q=lat,lon(label)` — OsmAnd/Organic Maps/Maps pick it up; radar
  stays running for the final unmapped stretch. (Answer to open question 2.)
- **Wake-lock renewal:** re-acquire `navigator.wakeLock` on
  `visibilitychange`; renew the native partial wake lock before its ~8 min
  cap while guidance is active.
- **VECTOR tick lag:** drive guidance recomputation from fix/heading events
  (with the 500 ms tick as fallback), so vehicle-speed bearing changes land
  without up to 500 ms of stale arrow.

## Acceptance (extends the v2 field tests)

- **Indoor person-in-crowd (Phase 3, test 4 of radar-v2):** two phones, busy
  building; approach from 500 m; BLE endgame resolves the last metres indoors
  — cadence quickens and "Very close — by Bluetooth" speaks while GPS
  accuracy is collapsed.
- **Honesty checks:** a coarse share with mesh running produces NO ble blend,
  no quickened cadence, no voice line; RSSI from an unbound MAC changes
  nothing; mesh off ⇒ identical to v2.1.
- **geo: hand-off:** from VECTOR, one tap opens the maps app on the target
  point; returning to flock resumes radar state intact.

## Non-goals (unchanged)

No RSSI-to-metres claims. No UWB promises. No silent precision/cadence
raising — the radar session is explicit, visible, time-boxed. No new relay
metadata. Coarse shares never blend.
