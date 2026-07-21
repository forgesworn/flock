# Radar competitive landscape

**Date:** 2026-07-21 · **Status:** research · **Scope:** flock radar v2.1 (main `377194a`) vs the market

Compares the shipped radar — three-mode sensory guidance to a person/pin
(VECTOR/SEEK/HOMING, heading engine, clock-face voice, stereo pan, signed
haptics, honesty gates, locked-phone GrapheneOS service) — against every
product category that overlaps any part of the use case. Web research run
2026-07-21; source URLs at the end of each section.

## TL;DR

**Nobody else ships sensory guidance to a moving person.** Across four
categories and ~25 products, exactly one competitor offers *any* directional
guidance to a person — Apple's Precision Finding for People — and it is a
screen-based arrow, gated on both parties owning an iPhone 15+, working only
inside UWB range (~15–60 m). Everything else is a dot on a map with a
hand-off to turn-by-turn routing. The specific combination flock radar ships
today — voice/stereo/haptic guidance to a **moving** target, a driving mode,
locked-phone operation, honest sensor degradation, E2E encryption with no
account, on hardware people already own — exists nowhere else in the market.

The closest live competitors are not apps at all: three funded hardware
gadgets (Totem Compass, Buddycompass, Crowd Compass) re-colonising dead
Lynq's festival-friend-finder niche in 2025–26. All are visual-arrow/LED
devices with no voice, no phone integration, and (mostly) no stated
encryption — and Totem raised $1.3M pre-seed for a $69 gadget that does a
subset of what flock radar does as software.

Where competitors genuinely beat us: Apple's UWB gives sub-metre endgame
accuracy indoors (our GPS endgame honestly degrades instead; BLE RSSI assist
is Phase 3 and unshipped); mainstream apps feel "live" (Zenly-style
continuous updates) where our 45 s cell-gated beacon floor reads as frozen
between disclosures; and satellite (Google/Garmin) covers no-coverage areas
our relay path cannot.

## 1. What we have (capability statement)

From the implementation audit (flock-kit `radar.ts`, flock `radarMode.ts` /
`radarView.ts`, native `RadarCore.kt` / `RadarGuideService.kt`):

- **Three auto-switching modes with hysteresis** — VECTOR (vehicle/far: GPS
  course only, compass never consulted ≥3 m/s, big glanceable arrow, voice
  leads), SEEK (on foot 30 m–2 km: Alien-tracker scope, stereo pan, signed
  haptics), HOMING (<25 m, precise targets only: continuous geiger cadence
  1 200→250 ms, warmer/colder trend, arrow dropped inside the GPS-fiction
  zone).
- **Heading engine** — arbitrates compass vs Doppler course by speed and
  platform accuracy grade; compass distrust surfaced honestly; v2.1 course
  trust floor (≥1 m/s fresh fix) and native rotation-vector mirror into the
  WebView.
- **Cue grammar** — cadence/pitch encode distance and alignment; stereo pan
  encodes turn direction; second-note trend encodes closing/receding; haptic
  vocabulary (two short taps = right, one long buzz = left) works in a
  pocket; clock-face TTS ("300 metres, at your 2 o'clock") with a 23-step
  speakable ladder pre-baked as offline clips (GrapheneOS may ship no TTS
  engine); minute-cadence status line; moved-interrupt with spoken twin.
- **Honesty gates** — no bearing when target coarse (>50 m uncertainty),
  stale (>600 s), or inside my own fix accuracy ×1.25; arrival fires at
  `max(2 m, target uncertainty, my accuracy × 0.8)` with truthful copy;
  degradations are spoken, never papered over.
- **Locked-phone parity (Android/GrapheneOS)** — RadarGuideService foreground
  service keeps GPS, rotation-vector heading, stereo audio, haptics, and
  voice clips alive with the screen off; target updates bridged per beacon;
  ages on the native clock.
- **Privacy invariants** — radar only consumes location the target already
  disclosed (NIP-44 gift-wrapped over Nostr); never raises precision or
  cadence; publishes no targeting metadata; lock-screen shows "Radar
  active", not a name.

Known gaps (from the same audit): BLE RSSI endgame is Phase 3 (unshipped);
iPhone is foreground-PWA only; partial wake lock capped ~8 min; 500 ms tick
lag noticeable in vehicle; beacon cadence (≥45 s, cell-gated) means the
scope only moves between disclosures with the watcher's own motion.

## 2. UWB precision finders — Apple, Google, Samsung, Tile

**Apple Find My / Precision Finding** is the only product in the entire
research set with person-to-person directional guidance. Requirements: both
parties on iPhone 15+ (U1/U2 UWB), mutual Find My sharing, within UWB range
— ~15 m on gen-1, ~50–60 m on gen-2. UX is an on-screen arrow + distance +
haptics: visual-first, no voice, no stereo audio, no driving mode, useless
in a pocket. Beyond UWB range it collapses to a map pin. AirTag 2 (Jan
2026, $29) extends item-finding range ~4× to ~60 m. Find My network is E2E
encrypted but Apple-account-gated and Apple-silicon-gated at both ends.

**Google Find Hub** (rebranded May 2025): UWB directional finding is
tag-to-phone only (Moto Tag, June 2025) — no phone-to-phone person guidance
found. Fragmentation bites: many Android flagships (incl. Pixel 9) lack
UWB. Satellite features (Pixel 10 + T-Satellite/Starlink) are a real
coverage differentiator for emergencies. Network is E2E with aggregation
thresholds, but account-gated.

**Samsung SmartThings Find / SmartTag2**: Compass View arrow + AR camera
overlay — tag-finding only, Galaxy-UWB-phone-gated. The People tab is
map-pin sharing with a nav hand-off, no directional guidance to a person.

**Tile / Chipolo**: no UWB, no directional anything — ring-to-find plus
warmer/colder proximity. Tile now belongs to Life360 (see §3 for that
record); its Anti-Theft Mode (tracker invisible to anti-stalking scans) is
in active litigation as an abuser tool.

**Read-through for radar:** UWB owns the last 10 metres indoors — sub-metre,
crowd-proof, works where GPS dies. Our HOMING honestly degrades there
(warmer/colder + geiger), and Phase 3 BLE RSSI is our only planned answer.
But UWB is a ~60 m bubble requiring matched premium hardware both ends;
everything from 60 m to 2 km+ — the actual "find your group" problem — is a
map pin for Apple users too. VECTOR/SEEK has no UWB competitor at all.

Sources: macrumors.com/how-to/iphone-15-locate-friends-with-precision-finding,
support.apple.com/guide/iphone/iph3effd0ed6, macrumors.com/2026/01/26/10-things-to-know-about-the-new-airtag-2,
apple.com/legal/privacy/data/en/find-my, 9to5google.com/2025/05/13/googles-find-my-device-network-is-now-find-hub,
9to5google.com/2025/06/11/moto-tag-find-hub-uwb-update-rolling-out,
winbuzzer.com/2025/04/27 (Pixel UWB gap), support.google.com/android/answer/14796936,
androidauthority.com/samsung-galaxy-smarttag-2-review-3378184,
samsung.com/latin_en/support (Samsung Find people tab), tomsguide.com/tech/chipolo-pop-review,
hotairtag.com/tile-tracker-review.

## 3. Family/friend locators — Life360, platform sharing, Zenly heirs

**Life360** (~80M users): the category giant, and the clearest privacy
anti-thesis. No guidance UX — tapping a member hands off to turn-by-turn
routing. Monetisation: after the 2021 data-selling exposé and a 2021 pledge
to stop, it resumed selling location-derived audience segments via LiveRamp
in Aug 2024, launched an ad platform on ~95% member location-share rates
("Place Ads"), suffered a 442k-user data exposure via Tile's support system
(2024), was named in the Texas AG's suit over driving data feeding
insurance pricing, and received an FTC enforcement order (Jan 2025)
restricting sensitive-location sales. Its "Bubble" feature is one of the few
coarse-precision controls in the market — a point of partial overlap with
our precision tiers.

**Google Maps sharing / WhatsApp Live Location / Snap Map / amo "Bump"**:
all map-dot UX, zero guidance. WhatsApp live location is genuinely E2E but
capped at 8 h sessions; Google Maps sharing is not E2E (patent exists,
nothing shipped); Snap Map is ads-funded with binary share/don't-share.
Zenly (40M users) was shut down by Snap in Feb 2023 rather than sold; its
ex-team's amo/Bump revives the social map (battery, speed, Spotify status)
with vague encryption claims — and still hands navigation off to Apple/
Google Maps. The Zenly lineage proves demand for *liveliness* (continuous
updates, presence feel) — the exact axis where our 45 s cell-gated floor
reads as frozen, deliberately.

**Self-hosted/Nostr**: OwnTracks (MQTT), Hauk, PhoneTrack, Home Assistant —
all map-dot or presence-state tools, no mesh, no guidance. Grid (Matrix,
E2EE, self-hostable, 2026) is the closest philosophical peer — still a map.
The Nostr location ecosystem is thin: Locus (E2E live location over Nostr)
is discontinued; Wherostr/Yondar are geo-social, not person-finding; the
geospatial NIPs (#136, #927) are unratified. **We are effectively the Nostr
location app.**

**Read-through for radar:** the entire category stops at "where's their
dot". Radar's job — the last half-mile after the dot — is unserved by all of
them, and Life360's record makes "no company can hold, sell, subpoena, or
lose it" a live, documented contrast rather than abstract positioning.

Sources: itoolab.com/location/how-does-life360-work, thecapitolforum.com
(LiveRamp segments), adexchanger.com (ad platform), aslawonline.com/life360-lawsuit,
techcrunch.com/2025/05/28 (Tile merge), screenrant.com (WhatsApp durations),
ynews.digital (WhatsApp E2E), sifted.eu/articles/snaps-decision-shut-down-zenly,
yahoo.com/tech/amo-third-app (Bump), values.snap.com/privacy, owntracks.org,
mygrid.app, github.com/Myzel394/locus, github.com/nostr-protocol/nips/pull/136.

## 4. Off-grid and team tools — Meshtastic, ATAK, Garmin

**Meshtastic**: closest in spirit (decentralised, open-source, off-grid;
0.5–20 km+ LoRa range) but requires dedicated radio hardware, and its
bearing-to-node display is a recent bolt-on (2026 map card; third-party
MeshWave app) — numbers on a screen, no audio/voice/haptic layer, and
channel encryption is shared-PSK (unauthenticated) unless using 2.5+ DMs.

**ATAK-CIV**: the Bloodhound tool is the most capable bearing-to-moving-
target instrument in existence (range/bearing/ETA to a moving marker,
offline maps) — and a power-user suite with a steep learning curve, visual-
primary, built for teams that train on it. Validates the capability;
irrelevant to a casual festival group.

**Garmin**: inReach is satellite messaging + map view (no guidance-to-
person). The Alpha dog-tracker line is the best hardware prior art for
HOMING — a compass needle pointing at a live moving target, 2.5 s updates,
9-mile VHF — at $600–1 200+ of hunting hardware, visual-only, zero privacy
story. onX buddy tracking is cellular-only map pins.

**Read-through for radar:** the off-grid tools prove every individual
capability exists somewhere — moving-target bearing (ATAK, Garmin Alpha),
off-grid mesh (Meshtastic) — but always as visual instruments on dedicated
hardware for specialist users. Nobody composes them into a consumer sensory
experience on a phone.

Sources: meshtastic.org/docs/configuration/radio/position, meshwave.io,
d-central.tech/meshtastic-encryption, kindlymorrow.com/blog/meshtastic-vs-meshcore-2026,
civtak.org/atak-about, ATAK 5.3 user manual (static1.squarespace.com),
rei.com/product/216799, dusupply.com (Alpha 300i), projectupland.com
(Alpha review), onxmaps.com/offroad/app/features/location-sharing.

## 5. Audio-guidance prior art — the blindfold bar

**Microsoft Soundscape** (open-sourced 2023) and successor **VoiceVista**
(iOS): 3D-spatialised audio beacon on a destination — the direction *sounds*
like where it is. **BlindSquare** ($39.99, iOS), **Lazarillo**, **OKO**:
self-voicing POI/intersection guidance. This category invented the audio
grammar we build on, and its users are the ultimate accessibility audience
for radar.

**Every documented beacon targets a static destination.** No product in the
accessibility space guides to a *moving person*. Audio-beacon-to-moving-
person — with spoken clock-face bearings, cadence, and degradation honesty —
appears to be genuinely unclaimed territory, and blind and low-vision users
meeting friends in public spaces are arguably the users who need it most.

Sources: github.com/microsoft/soundscape, drwjf.github.io/vvt (VoiceVista),
guidedogs.org.uk (VoiceVista), blindsquare.com, lazarillo.app,
lighthouseguild.org (OKO).

## 6. Direct rivals — the Lynq-successor hardware wave

**Lynq** (2018–19: phone-free GPS "people compass", ~20k units, $1.7M
presales) died — trademark abandoned May 2021. Its niche has been
re-colonised in 2025–26 by three funded/shipping gadgets, squarely aimed at
our festival/off-grid audience:

| | Totem Compass | Buddycompass | Crowd Compass |
|---|---|---|---|
| Price | $69 | n/f | $199.99 |
| Guidance | LED arrows to ≤4 friends | arrows, ≤8 devices | arrows, LoRa 915 MHz |
| Range | ~1 km+ P2P mesh | ~3 km repeating mesh | ~3 miles |
| Updates | ~1/s off-grid | n/f | n/f |
| Voice | none | none | none |
| Encryption | none stated | none stated | claims E2E |
| Phone-based | no — extra gadget | no | no |
| Funding | $1.3M pre-seed (Feb 2025) | — | — |

None offer voice, spoken bearings, haptic vocabulary, locked-phone
operation, or phone integration. All require buying, charging, and carrying
another device per person. Totem's raise is the market signal: investors
funded a $69 gadget doing a *subset* of what flock radar does in software on
hardware everyone already carries.

**Zello** (walkie-talkie + location) gates location behind the paid Work
tier, dispatcher-oriented, no guidance.

Sources: techcrunch.com/2018/05/15 (Lynq), trademark.justia.com/900/62/lynq-90062367,
trailandkale.com/totem-compass-review, totemlabs.com, businesswire.com/news/home/20250212385814
(Totem raise), buddycompass.shop, crowdcompass.io, inc.com/ali-donaldson
(rival startups feature), blog.zello.com/location-tracking-app.

## 7. Feature matrix

| Capability | flock radar v2.1 | Apple Precision Finding (people) | Google Find Hub | Life360 / Zenly-style | Garmin Alpha | Meshtastic | Totem/Crowd Compass | Soundscape family |
|---|---|---|---|---|---|---|---|---|
| Guidance to a **moving person** | ✅ GPS-honest, all bands | ✅ ≤~60 m UWB only | ❌ (tags only) | ❌ map dot | ✅ (dogs, VHF) | ⚠️ numeric bolt-on | ✅ LED arrow | ❌ static beacons |
| Voice directions (clock-face) | ✅ offline clips + TTS | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ⚠️ spatial audio, static |
| Stereo/spatial audio cue | ✅ pan + trend note | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ (static) |
| Haptic direction vocabulary | ✅ signed L/R | ⚠️ proximity buzz | ❌ | ❌ | ❌ | ❌ | ⚠️ vibe pulse | ❌ |
| Driving mode | ✅ VECTOR | ❌ | ❌ | ⚠️ crash/routing | ❌ | ❌ | ❌ | ❌ |
| Locked-phone / eyes-free | ✅ Android/GrapheneOS | ❌ | ❌ | ❌ | ✅ (handheld) | ❌ | ✅ (gadget) | ⚠️ audio continues |
| Honest sensor degradation | ✅ core invariant | ❌ silent fallback | ❌ | ❌ | ❌ | ❌ | ❌ | ⚠️ |
| Sub-metre indoor endgame | ❌ (Phase 3 BLE) | ✅ UWB | ✅ tags | ❌ | ❌ | ❌ | ❌ | ❌ |
| Continuous "live" feel | ❌ 45 s floor by design | ✅ in range | — | ✅ | ✅ 2.5 s | ⚠️ | ✅ ~1/s | — |
| Works with no internet | ⚠️ BLE mesh (position), relay needed for beacons | ✅ in UWB range | ⚠️ satellite (Pixel 10) | ❌ | ✅ VHF | ✅ LoRa | ✅ | ❌ |
| E2E encrypted, no account | ✅ NIP-44, no account | ⚠️ E2E, Apple ID | ⚠️ E2E, Google acct | ❌ sells segments | ❌ | ⚠️ PSK channels | mostly ❌ | n/a |
| Coarse-precision sharing | ✅ per-tier, cell-gated | ❌ | ❌ | ⚠️ Bubble | ❌ | ❌ | ❌ | n/a |
| Extra hardware required | ❌ | ❌ (iPhone 15+ ×2) | tag | ❌ | $600–1 200 | LoRa radio | $69–200 each | ❌ |

## 8. Honest weaknesses (where the market beats us)

1. **The last 5 metres indoors.** Apple UWB resolves a person in a crowd to
   sub-metre; our HOMING admits GPS fiction and switches to warmer/colder.
   Correct honesty, worse outcome. Phase 3 BLE RSSI (banded, identified-GATT
   only) is the planned answer and remains unshipped.
2. **Perceived liveliness.** Zenly/amo/Life360/Totem all update in seconds.
   Our ≥45 s cell-gated beacon floor is a privacy feature that *reads* as a
   bug ("the screen doesn't update as they move" — first field test). v2.1's
   spoken moved-interrupt and minute line mitigate; a consented, time-boxed
   radar-session cadence lift (v1 goal doc's "active radar session") is the
   real fix and is still future protocol work.
3. **iPhone.** Foreground PWA only; locked-phone by-ear guidance is
   Android/GrapheneOS-only until a native iOS shell exists. Apple users get
   a materially worse flock radar than Apple's own (in-range) offering.
4. **No-coverage areas.** Beacons need a relay path; Google's satellite tie-
   ups and Garmin inReach work where there is nothing. BLE mesh covers
   member-to-member proximity, not the half-mile approach with no data.
5. **Polish/AR.** Samsung's AR overlay and Apple's arrow are slick; our
   scope is deliberately instrument-like. Fine for our audience, worth
   knowing for broader appeal.
6. **500 ms tick lag** noticeable in VECTOR at speed (implementation note,
   fixable).

## 9. Where flock radar stands alone

The unclaimed combination, in one sentence: **spoken, stereo, haptic
guidance to a moving person — in a car, on foot, or with the phone locked in
a pocket — that tells the truth when its sensors can't, over E2E-encrypted
decentralised transport, with no account, no company custodian, and no extra
hardware.**

Component by component, the nearest prior art is: ATAK Bloodhound
(moving-target bearing, specialist), Garmin Alpha (compass-to-moving-target,
$1k hunting kit), Soundscape (audio beacon grammar, static targets), Totem
(off-grid friend arrows, gadget), Apple (person UWB, 60 m Apple-only
bubble). No product combines even two of the five pillars (sensory grammar,
moving person, honesty gates, locked-phone, sovereign transport).

## 10. Strategic notes

- **Market validation is fresh:** Totem's $1.3M raise (Feb 2025) and two
  rivals shipping into Lynq's grave prove people pay for find-my-friends-
  off-grid. Flock delivers that as free software on existing phones.
- **Accessibility is an unclaimed second audience.** The Soundscape/
  BlindSquare community lost its Microsoft flagship and has no moving-person
  beacon. Radar's blindfold bar was engineered for exactly this. Worth a
  conversation with that community before claiming it in marketing.
- **Life360's record is the positioning gift** — FTC order, resumed segment
  sales, breach, insurer data suits — for "a safety net no company gets to
  hold, sell, subpoena, or lose" (VISION.md, one line).
- **Apple's moat is hardware-gated both ends.** Mixed groups (one Android
  phone present) break Precision Finding; flock is cross-device by design.
  The claim "the only person-to-person guidance that works across platforms"
  currently survives everything researched — the one caveat being our own
  iOS locked-mode asymmetry.
- **Priority signals from the gaps:** (a) Phase 3 BLE RSSI closes our only
  hard capability deficit vs Apple; (b) the consented radar-session cadence
  lift addresses the liveliness complaint that every mainstream competitor
  wins on; (c) the VECTOR `geo:` hand-off (open question 2) cheaply
  neutralises "but Maps does routing".

## Research provenance

Implementation audit: flock-kit `src/radar.ts` (modes 687–708, thresholds
66–78, honesty gates 301–323, cues 459–510), flock `app/src/radarMode.ts`
(voice 560–632, beeps 741–798), `native/.../RadarGuideService.kt` (149–365),
`RadarCore.kt` (395–414); design docs `2026-07-09-radar-navigation-goal.md`,
`2026-07-21-radar-navigation-v2.md` (incl. v2.1 addendum). Market research:
three parallel web sweeps (precision finders; locators/self-hosted/Nostr;
off-grid/accessibility/hardware), July 2026, sources inline per section.
