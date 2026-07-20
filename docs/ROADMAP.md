# flock — roadmap & feature backlog

Single source of truth so we ship **full features with no bugs**. Live preview:
**https://flock.forgesworn.dev/**. The privacy-by-architecture foundation (Phase A;
see `PRIVACY.md`) is in place, the coercion-resistance set (Phase J + the decoy
view + the App lock) is **complete**, and the **native outbound background-publish gate is
closed** — background beacons keep flowing while the phone is locked on
GrapheneOS (built, hardware-measured GREEN, and shipped 2026-07-05 as release
`0294b8c`; see "Native background publish" below and Phase G). The outdoor walk
and stationary deep-Doze outbound passes are both **MEASURED GREEN (2026-07-06)**.
That closes the outbound claim only. Locked-phone radar, a live Orbot-route
beacon, and broader Stay reachable battery/device evidence remain explicit
native field gates below. Operator-side work also includes relay #2 (runbook:
`docs/runbooks/second-relay.md`) and publishing `keystore-kit` to npm.

## MVP scope (2026-07)

The app was **refocused to one MVP job** (2026-07-03): privacy-preserving live
location coordination across one or more trusted-adult circles — set up in
advance with QR/link/six-word/remote-signer invites and a per-person **geohash
precision slider** (3–9: whole region, e.g.
Mallorca → exact spot; the map shows exactly what the circle sees of you, with a
dashed would-see preview while not sharing) driving
the emission pipeline (`decideEmission` coarse override; sampling tier follows the
slider — ≥7 uses GPS, coarser polls low-power), and front-page **"buzz the circle"
quick actions**. "Check in" is a group roll-call; Come to me / Where are you? /
Call me / On my way are private-thread actions. **"Come to me"** sends a
confirmed one-shot exact inner beacon (precision 9) inside the mandatory
per-recipient kind-1059 wrap; cadence and the slider stay unchanged, and
no-report zones still cap it. Family/night-out modes collapsed to one
share-live UI model (invite wire format unchanged).

**Privacy default restored (2026-07-10, superseding 2026-07-09):** sharing is
off at boot/create/join and requires a deliberate tap. New circles start at
Neighbourhood (precision 6), and remote exact lost-phone consent starts off.
Once deliberately started in the Android app, sharing still continues while the
phone is locked/in Doze through the native foreground service until the user
stops it or a documented teardown condition occurs. The brief open-by-default,
Exact-spot implementation (`maybeAutoShare` / `autoShareApplied`) was removed.

**Preview access split (decision recorded 2026-07-10; not yet implemented):**
keep `/` as a public project/features site with public APK and source/download
links, and move the usable PWA to `/app/`. Normal PWA and APK startup should
require an operator-issued, signed, expiring preview grant before the existing
18+/consenting-adults acknowledgement. Carry a web grant in a URL fragment such
as `/app/#access=...` so ordinary HTTP requests do not include it; verify it
locally against a bundled public key and store only the resulting local grant.
The APK must enforce the same grant because a public download with an ungated
client defeats the restriction. Preserve existing circle invite deep links and
service-worker scope during the migration. A hidden URL, `noindex`, or shared
password embedded in the client is not access control, and this preview gate is
not highly effective age assurance.

**Parked post-MVP — removed from the app UI only; the library keeps every module
tested and exported:** SOS/duress (incl. stand-down, covert holds, breadcrumb
trail), pick-me-up + spoken verification, take-a-break/off-grid, safe places /
geofence breach, the no-report-zone editor (the policy cap still applies to any
legacy zones), the periodic check-in dead-man's-switch, and rendezvous + meeting
points. Offline-map area saving has since returned through the current map flow.
Their roadmap entries below stand as the post-MVP backlog — annotated, not
deleted. The e2e suite was trimmed to the MVP subset at the same time (see the
coverage note below).

Coarse disclosures render as the **true geohash cell square** (2026-07-03) —
the member is guaranteed inside the square, whose centre is the grid's, never
their position; the old circular halo only approximated it (a member near a
cell corner sat outside the inscribed circle).

## Native background publish — locked sharing works (2026-07-05)

**The make-or-break gate is closed.** Background beacons now keep flowing while
the phone is locked on GrapheneOS — the whole point of the app, and the last open
platform blocker. Built, hardware-proved on the GrapheneOS Pixel 10 Pro, merged,
and shipped (release `0294b8c` live on flock.forgesworn.dev).

- [x] **Native background-publish pipeline** (PR #1, merged) — while the app is
  backgrounded the fix→policy→gift-wrap→relay pipeline runs **natively in Kotlin**
  (`native/android-src/kotlin*`), bypassing the WebView JS that Android suspends.
  Wire-format parity with the JS path is held by public golden vectors (`compatibility/v1/`)
  + a JVM test suite in CI (JDK 21, no Android SDK). The pure core
  (`native/android-src/kotlin/`) never imports `android.*`. Design:
  `docs/plans/2026-07-05-native-background-publish-design.md`.
- [x] **Native GPS fix source** (PR #2, merged — `FlockLocationService`) — the
  community background-geolocation plugin's **fused provider delivers no fixes to a
  locked FGS on GrapheneOS**; replaced with flock's own `location`-typed foreground
  service requesting `GPS_PROVIDER` **directly @5 s** (the mechanism the Phase-0
  gps-probe measured GREEN), feeding the verified `FlockPublisher` via a shared
  `FlockFixReceiver.submitFix` (one publish thread, no double-publish — `onFix`'s
  foreground guard still drops foreground fixes to JS). Started/stopped by the config
  mirror (setConfig→start, clearConfig/wipeAll→stop). Goal + measurements:
  `docs/plans/2026-07-05-native-gps-source-goal.md`.
- **MEASURED GREEN on the GrapheneOS Pixel 10 Pro (2026-07-05):** `dumpsys location`
  shows a **direct** `gps provider … 10213/cc.trotters.flock … @+5s HIGH_ACCURACY`
  (not the fused overlay); with the screen **locked (Dozing)** the relay watcher
  decrypted native beacons at +7 s (first background fix) and every ~50 s after,
  geohashes changing — a suspended WebView can't publish. Signed release APK
  `0294b8c` built (same key → installs over the top) and deployed.
- **THE WALK — MEASURED GREEN (2026-07-06, on current main `13266fc`):** two-phone
  test (GrapheneOS Pixel = sharer, Samsung A32 = observer). With the Pixel **locked,
  screen-off, in pocket, OUTDOORS, at EXACT (~2 m) precision**, the observer tracked
  its fresh moving position — member card `within 610 m · last seen 14:28` (frozen) →
  `within 2 m · last seen 15:02 · out · just now`, and the pin **moved** Beacon Hill Rd
  → Preston Rd/Winstanley Dr (exact dot, no coarse cell). End-to-end confirmation the
  native publisher pushes fresh location through a locked/Dozing screen. **Method note:
  must be run at exact precision AND outdoors** — coarse (~610 m) masks movement inside
  one geohash cell, and indoors there is no GPS fix to publish at any precision; a frozen
  last-seen under coarse/indoors is expected, not a failure.
- **STATIONARY DEEP-DOZE — MEASURED GREEN (2026-07-06, GrapheneOS Pixel 10 Pro, API 37).**
  The one case the walk couldn't prove (movement keeps a device *out* of deep Doze). Forced
  the harshest condition via `dumpsys battery unplug` + `dumpsys deviceidle force-idle` — the
  device pinned in deep **`IDLE`** (`mDeepEnabled=true`), screen off (`Dozing`), OS-unplugged,
  **no maintenance windows** (so if Doze cut flock's network, publishes would stop dead).
  Throughout: `FlockLocationService` stayed a foreground service, flock stayed Doze-whitelisted,
  and **GPS kept delivering at 5 s** (fix counter climbing continuously under idle). flock
  published **three exact (p9) beacons at the ~300 s stationary cadence** (16:15:31, 16:20:31,
  16:24:51), **all decrypted on the relay** — the 300 s spacing is flock's own cadence timer
  (driven by the surviving 5 s GPS callback), not irregular Doze maintenance windows. So a
  motionless, locked, screen-off phone in deep Doze keeps publishing fresh location.
  Observed with a Mac-side watcher (`scratchpad/relay-watch.mjs`, reproduces the app's
  subscribe→giftUnwrap→decryptBeacon path; needs auto-reconnect because relay.trotters.cc
  drops idle subs ~every 75–90 s — the app's `SimplePool` handles this with
  `enableReconnect`/`enablePing`). Method note: `force-idle` is the standard Doze test; a
  real multi-hour **unplugged overnight run + battery-cost measurement** remains as optional
  extra assurance (already tracked as a separate Phase-G item).
- **Follow-ups (housekeeping, not gating):** run the native GPS service only while
  backgrounded; drop the bg-geo dependency once battle-tested (goal doc).

## Chat-led Home & reliability (2026-07-04 pm)

- [x] **Map-led scrollable Home**: hero map → presence **member strip** →
  **circle chat** — one focused thread per circle (mine right-aligned,
  senders named, times shown), quick actions as composer preset chips, all
  persisted (`store.chats`, capped, deduped against relay replays by the
  rumor's `(from, at, text)` triple). **PMs are full 1:1 thread sheets** and
  live under **You → Private chats** with unread badges (nav badges on
  Home/You). You leads with the person; settings fold behind "Settings…".
- [x] **Locked-screen sharing fixed at the root** (GrapheneOS field report):
  Doze suspends the WebView's relay socket unless flock is battery-exempt —
  exemption now requested when sharing starts + an actionable Home card.
- [x] **Reconnect fix**: `SimplePool({ enableReconnect, enablePing })` — one
  socket drop no longer kills incoming until an app restart.
- [x] **Update-nag chain closed end-to-end**: apk.json + Caddy conf live,
  `flock-12629e4.apk` published (the first APK whose update check compares
  against the published-APK marker, not the website deploy).
- [x] **Precision slider self-change fixed**: drag-deferred panel rebuilds +
  a detached slider's stale `change` is ignored.
- [x] **Check-in roll-call**: fans to EVERY circle with an encrypted
  `ask:'location'`; recipients sharing freshen their beacon, others get an
  explicit "share once?" card at their own detail — never automatic (§6).
- [x] **MessagingStyle conversation notifications** (one per conversation,
  updated in place, cleared when the app comes forward).
- [x] **BLE→relay bridge v1**: a wrap received over Bluetooth re-publishes to
  the relays from any connected phone (opt-in, deduped, best-effort).
- [x] **Mesh & bridge v2 + audit hardening + Tor toggle** — executed by a
  Sonnet 5 agent from `docs/plans/2026-07-04-mesh-bridge-goal.md`, reviewed and
  merged same day (7 commits): dead bare-20078 paths deleted + unvetted-relay
  warning (F5); cadence jitter + wire-identical `cover` traffic (F1); profile
  fetch unbatched per pubkey (F3); word-invite hardened — **6 words, scrypt
  2^17, parks an encrypted one-time REFERENCE not the seed, delete-on-fetch,
  and a real bug fixed: kind 20079 was in Nostr's EPHEMERAL range so relays
  never stored parked invites (now kind 8078)** (F4); FLOCK.md/PRIVACY.md
  aligned to the wrap-everything wire model; opt-in fail-loud Tor `.onion`
  toggle (Orbot detection, `ONION_RELAYS` empty until the onion service
  exists); BLE mesh v2 store-and-forward buffer + real learned-peer paged
  manifest reconciliation (shared stack, mixed-version wire tested; hardware verification per
  `docs/plans/2026-07-04-ble-mesh-v2-test-plan.md`). DM forward secrecy
  deliberately deferred (ratchet crypto deserves its own focused session).
  **Not yet deployed** — the 6-word invite format should ship as a coordinated
  site + APK pair. Audit: `docs/research/2026-07-04-relay-privacy-audit.md`.
- [x] **Onion relay endpoint live + native route fixed** (2026-07-11, shipped
  `release/51e7647`): a v3 hidden service on the relay.trotters.cc host now
  fronts the relay
  (`ws://gdtkccgtod3om7bvycaygjjske6sj6vnsu3d7csutkofnoa3ylt6haid.onion`,
  `ONION_RELAYS` default), with a dedicated `access_log off` nginx vhost;
  the clearnet relay vhost was tightened to match (access_log off, X-Real-IP
  dropped). The onion path bypasses both the CDN and IP logging entirely.
  Verified end-to-end over a real Tor circuit: NIP-11, WebSocket 101, and a
  NIP-40-expiring publish/read round-trip. **Native mixed-content gate
  resolved on-device (emulator WebView):** Chromium blocks cleartext `ws://`
  from the `https` origin at the WebSocket *constructor* and does not exempt
  `.onion`, so the fix is `android.allowMixedContent` (renderer) + a
  network-security-config that RE-BLOCKS cleartext for every host except
  `.onion` (network layer), plus https-only avatars so nothing else can
  downgrade. Proven by probe: post-fix, clearnet `ws://` →
  `ERR_CLEARTEXT_NOT_PERMITTED` while `.onion` passes cleartext policy. Only
  a live Orbot beacon on real GrapheneOS hardware remains (emulated ARM ANRs
  under Tor+VPN+WebView; emulator also lacks raw GPS).

## Lost phone ("back of a taxi")

A phone that is *sharing* is a findable phone — that's the pitch for leaving
coarse sharing on all trip. The playbook that already works: watch its pin move
(APK background watch), buzz it repeatedly (system notification + vibration even
hidden), read its **last seen** when the beacons stop, then **remove member**
(reseed cuts the device off) — and the App lock means a finder gets ciphertext.

- [x] **Last seen** (2026-07-03): every roster row with a cached beacon shows
  "on the map · within ~X · last seen HH:MM" plus a 📍 **see-on-map** jump that
  frames the member's whole disclosed cell. Pure UI over the presence cache.
- [x] **Peer "mark as lost"** (2026-07-03): anyone in the circle flags a
  member's phone lost (`t=lost` signal, `@forgesworn/flock/lost`, FLOCK.md §3.3 —
  group-envelope encrypted, latest-per-member wins). Everyone's roster shows a
  "phone lost" pill, the pin/square turns alert-red, and the phone itself shows
  a loud finder card on Home ("found this phone? please help it home") with
  vibration + system notification. Anyone clears it — including the owner
  tapping "It's not lost — I've got it". Display-only by design: it never
  changes what the device discloses. e2e: `lost-phone.spec.ts`.
- [x] **Make it ring** (2026-07-04): a phone the circle has flagged lost plays
  an incoming **targeted buzz** as a loud **alarm** — alarm audio stream (sounds
  through ring-silent), best-effort DND bypass, a screen-waking full-screen
  intent and a long insistent vibration. **No protocol change** — on the wire
  it's an ordinary targeted `buzz`; the lost flag is the gate and the escalation
  is a receiver-side decision (pure `shouldRing` in `app/src/ring.ts`, +6 unit
  tests). Native alarm channel + `ring()` method (`native/notify.ts`,
  `FlockNotifyPlugin.java`; `USE_FULL_SCREEN_INTENT` + `ACCESS_NOTIFICATION_POLICY`
  added to `patch-android.mjs`), degrading gracefully on an older shell to a
  high-priority alert. Finder taps **"🔔 Ring"** on a flagged-lost member's row;
  the lost phone shows a loud pulsing **"This phone is ringing"** card. Output
  only — never discloses location or changes what's shared; decoy-safe (a hidden
  app has no subscription, so it can't ring). FLOCK.md §6.8. e2e
  `make-it-ring.spec.ts` (B flags A lost → B rings → A's phone goes to the
  ringing card → A clears it) green over the live relay. **DND-access affordance
  shipped (2026-07-04):** You → Notifications → "Ring through Do Not Disturb"
  shows the grant status and a one-tap **Allow** that opens the system DND-access
  screen (`FlockNotifyPlugin.checkDndAccess`/`openDndAccessSettings`,
  `native/notify.ts` `hasDndAccess`/`openDndAccessSettings`; re-checked on the You
  tab + return-to-foreground). Native-only; without the grant the alarm still
  sounds through silent, just not full DND. *(On-device validation pending.)*
- [x] **Remote exact ping ("find my phone")** (2026-07-04): a member asks; the
  lost device answers with a **one-shot exact beacon** (reusing the come-to-me
  answer, refactored to `sendExactBeacon`). **The consent design was the work**
  (`docs/plans/2026-07-04-remote-exact-ping.md`): reconciled with the permanent
  non-goal via **pre-authorisation** — the phone answers only because its owner
  pre-consented on their own device (`Circle.pingConsent`, off by default,
  device-local, never synced), so the disclosure still originates from the
  device's own settings. Full gate stack (the strict model): **pre-auth +
  flagged-lost + cancel window + one-shot + rate-limit**. The ask is a new
  `findreq` signal (`@forgesworn/flock/findping`) — deliberately distinct from a buzz (a
  targeted buzz already *rings* a lost phone); the answer is a plain `beacon@9`
  (no-report zones still cap it). Pure gate `shouldAnswerFindPing`
  (`app/src/findping.ts`, +10 unit) + lib round-trip (+5 unit); a per-circle
  pre-auth toggle on the Circle screen, a "📍 Find" finder button on a
  flagged-lost row, and an alert-red **cancel-window banner** (owner's veto) on
  the target. Any failing gate is silent (no tell); decoy-safe. FLOCK.md
  `findreq` row + §6.9. e2e `find-my-phone.spec.ts` (pre-auth → flag lost → ask →
  cancel window → exact fix reaches the asker) green over the live relay;
  come-to-me + make-it-ring + lost-phone regressions green. **Answering needs a
  live GPS fix, so it is a native-shell / foreground capability** (like the
  background watcher); a backgrounded web PWA answers when next foregrounded.
- **Non-goal — permanent**: remote "start sharing". If sharing was off when the
  phone was lost, nothing can switch it on from outside: a remote-enable switch
  is indistinguishable from a stalking tool and breaks the invariant that
  disclosure only ever originates from the device's own settings.

## Radar navigation to a moving person (goal, 2026-07-09)

- [ ] **Live radar navigation** — select a trusted circle member and navigate
  toward them without staring at the map: stand still, rotate the phone, and use
  the accelerating "beep ... beep ... beep beep ... beep beep beep" cue to find
  the bearing; then lock the phone and keep navigating by ear, occasionally
  unlocking for an Alien-inspired xenomorph motion-tracker progress check with
  range, freshness, uncertainty, and target movement. UX gate: one selected
  person, one dominant tracker, one obvious Stop, no settings clutter. Platform
  gate: locked-phone by-ear guidance must work on Android/GrapheneOS; iPhone PWA
  support can be foreground/open-phone visual + audio radar for v1, with native
  iOS only if locked iPhone guidance becomes a target later. This is deliberately
  a better way to consume a permitted disclosure, not a new hidden exact-tracking
  path: coarse shares remain coarse, no-report zones still cap/withhold, and any
  temporary high-cadence exact "radar session" must be explicit, visible, and
  time-boxed. Goal/design:
  `docs/plans/2026-07-09-radar-navigation-goal.md`.
  - [x] **Slice 1 — pure guidance core + foreground tracker (2026-07-09).** The
    library module `@forgesworn/flock/radar` owns every decision (distance/bearing, angular
    error, freshness, the coarse/stale/private degraded states, the beep-grammar
    cue, target-movement classification, GPS-course fallback), unit-tested with
    the honesty invariants held: a coarse share never yields a precise pointer,
    a stale target never sounds confident, arrival silences with one haptic.
    The foreground tracker (`app/src/radarMode.ts` + pure `radarView.ts`
    helpers): phosphor scope with range rings/sweep/blip/uncertainty band,
    distance + freshness readout, plain-words degraded status, Web Audio beeps
    with a vibration mirror (mute keeps haptics), a distinct "target moved"
    interrupt, DeviceOrientation heading with an honest no-compass fallback —
    one selected person, one Stop, one sound toggle, nothing else. Launched from
    a member row's 🧭 (shown only when a beacon exists); consumes ONLY the
    cached already-permitted beacon — nothing is published and nobody's
    precision or cadence changes. iPhone/PWA = foreground/open-phone radar only
    (deliberately unpromised while locked). e2e `radar.spec.ts` green over the
    live relay. **Still open:** a request/accept live radar session and
    stereo/pitch left–right steering.
  - [x] **Slice 1.1 — discoverable launch + who-is-who avatars (2026-07-09,
    field feedback same day).** The 🧭 moved out of the chevron fold onto the
    member row itself, plus a visible "🧭 Find them" in the person's private
    chat (the surface a map-pin tap opens; `openRadarFor` resolves the right
    circle for a DM peer). Avatars: initials from the member's CHOSEN name
    (per-member pubkey pair when unnamed — never a shared placeholder), a
    stable per-member tint from the pubkey (same person = same colour on every
    phone), bigger tiles. e2e covers both launch surfaces.
  - [x] **Slice 2 — Android/GrapheneOS locked-phone guide mode (built
    2026-07-09; hardware validation PENDING).** `RadarGuideService` — a
    user-started, location-typed FGS (the measured-green direct-GPS mechanism)
    with rotation-vector compass, native synthesised beeps (AudioTrack) and
    vibration following the SAME pure rules: the guidance core is ported to
    Kotlin (`native/android-src/kotlin/cc/trotters/flock/radar/RadarCore.kt`,
    no `android.*`) and pinned to the JS module by golden vectors
    (`compatibility/v1/radar-vectors.json`, `npm run gen:vectors`) + JVM tests
    (6, `npm run test:native`). While radar runs on the shell, native owns ALL
    audio/haptics (no double-beep) and JS keeps the visuals; target updates
    are pushed event-driven from the beacon path (`radarBeaconLanded`), so a
    battery-exempt locked phone keeps guiding — and if updates stop reaching
    native, the observation ages on the native clock and degrades to the
    sparse stale pulse (never a confident cue to an old spot). Lock-screen
    notification is low-detail ("Radar active", no name) with a Stop action;
    JS reconciles a notification-stop on resume. Short capped wakelock (45
    min max). **Pending on real hardware (Pixel 10 Pro):** locked-screen
    beep/haptic continuity, compass-under-wakelock behaviour, and the two-phone
    half-mile field walk from the goal doc's success criteria.

## Messaging & map-led Home (2026-07-03)

- [x] **Bugfix — a 1:1 "Come to me" exact share now actually shows on the map
  (2026-07-05).** The private exact share (`doDmComeToMe` → gift-wrapped to the
  recipient's personal inbox) arrived as a chat bubble with a "See on map" button,
  but `onIncomingLocationShare` **never recorded the location** — so the jump only
  panned the camera to **empty terrain** (no pin). Sharing your exact spot with one
  person genuinely didn't work for the person receiving it. Fixed by having the
  received share call `saveBeacon` (rendering it as the sender's pin, exactly as the
  circle-wide `sendExactBeacon` answer already did — the 1:1 path had simply omitted
  it), the bubble carry the sender's `data-pk`, and "See on map" switch to the
  sender's circle so their now-recorded pin is on the active map. On-device only;
  the sender's own later beacon supersedes it by recency. New deterministic e2e
  (`quick-action.spec.ts`) where **neither** person ambient-shares (remote gift-wrap
  invite bootstraps both rosters), so the pin exists **only** because the exact share
  was recorded — proven green over the live relay.
- [x] **Map-led Home.** The Home tab now opens onto a **live members map** (the old
  "Private" status orb is gone; its Private/Sharing copy survives as a glass chip
  over the map, plus a "N people on the map" count). Controls (share toggle,
  precision, messaging, quick actions, invite) live in a re-renderable `#home-panel`
  so a presence tick updates them without tearing the map. Tradeoff logged: **maplibre
  now loads on the default tab** — a footprint bump vs the minimal-footprint north
  star, accepted because the map *is* the ask; easy to gate later if battery wins.
- [x] **Free-text messaging.** A compose sheet (preset chips + free text) sends either
  a **group note** (the existing shared-inbox buzz) or a **private 1:1 DM**. DMs are
  gift-wrapped to the recipient's **personal inbox** (`buildDmWrap`/`readDmWrap`, the
  invite rails), encrypted so **only they** can read it — reachable by **tapping their
  map pin** or the ✉ on their Circle row. Incoming DMs are **gated on circle
  membership** (a removed member post-reseed, or an npub-scraping stranger, is
  dropped). Cold-start closed: a remote invite's seal carries the inviter, so a fresh
  joiner **seeds the inviter into its roster on receipt** and accepts their first
  message immediately. e2e `message.spec.ts` (group note, private 1:1 with a locked
  "just you" banner, pin-tap compose, cold-start first-DM) + DM-primitive unit tests
  incl. the privacy invariant (a third party cannot decrypt). **Open question for
  Darren:** the members-gate is deliberately strict — confirm that's the wanted
  posture vs. accepting any DM from someone who knows a circle id.

## Cross-cutting (apply to everything)

- **Mobile-first** — phone-shaped, large touch targets, one-handed, installable PWA, offline-tolerant.
- **Uber privacy** — the relay is untrusted; minimise all metadata (see `PRIVACY.md`).
- **Minimal footprint (north star)** — flock must be nearly *free to run*: negligible **battery**, negligible **relay traffic**, negligible **metadata**. These are one idea, not three — disclosure-on-event (share only what a moment needs) is the same discipline as sample/emit-only-when-needed. The clean tell: **coarse sharing should use coarse, low-power location** (network/cell, not GPS) — a battery win that is *also* a privacy win (hardware that can't over-collect). Tracked in **Phase H**.
- **Evidence matches the feature** — Playwright drives separate browser identities
  through a Nostr relay for user-visible cross-device flows. CI uses a fresh
  RAM-only local relay; explicit pre-deploy smoke runs use the production-shaped
  target. Pure policy uses
  unit/matrix tests; Kotlin/JavaScript compatibility uses golden vectors; device
  lifecycle claims require hardware. “Built”, “e2e green”, and “hardware green”
  are not interchangeable.
  - ✅ **Current relay e2e suite:** onboarding, backup/reset, QR/link/word
    invitations and join assistance/notices, sharing/precision, map, messaging
    and typing, buzz/quick actions, temporary festival mode, lost/ring/find,
    foreground radar, lock/decoy, reseed/remove/disband, permissions, and hints.
    It is a CI gate against the isolated relay; the same suite can target an
    explicit live relay before deployment. Removed SOS/geofence/check-in/
    rendezvous UI specs remain in Git history only and are not current coverage.
  - ✅ **Regression backbone** — the security-critical `decideEmission` core has
    an exhaustive 216-case truth table plus standalone safety invariants. The
    complete Vitest suite has **863 tests as of 2026-07-17** and CI enforces 80%
    coverage thresholds; command output is authoritative as the suite grows.
  - 🐛 **Bug the e2e caught & fixed**: the 3-party test surfaced a roster-update race — `ensureMember` trusted a circle snapshot captured before an `await`, so two first-contact signals arriving together would let the later write clobber the earlier one, silently dropping a member (who'd then be skipped by reseeds and lists). Fixed to re-read the live roster.
  - 🐛 **Bug the e2e *missed* — and the guard that now catches it**: the map rendered **blank** on the live site. maplibre tags `#map` with `.maplibregl-map{position:relative}`, which (equal specificity, loaded later) beat the app's `.map-canvas{position:absolute;inset:0}` and collapsed the container to **height 0** — yet tiles still loaded and the canvas stayed "visible", so the e2e's visibility check passed while the map showed nothing. Fixed with a higher-specificity selector; `map.spec.ts` now asserts `#map` has real height. **And a release bug it exposed:** the service worker was serving returning users a **stale cached `index.html`** (pinning old hashed assets), so deploys silently didn't land — fixed by cache-busting the SW (`{ cache: 'reload' }` navigations + cache-name bump) and `Cache-Control: no-cache` on `index.html`. *Lesson: "canvas visible" ≠ "content rendered" — assert real dimensions.*
- **ForgeSworn toolset** — use the real tools, don't hand-roll (see `FORGESWORN-TOOLKIT.md`).
- **geohash-kit for all geo maths** — beacons + map (✅). `geofence.ts` now **delegates** haversine distance (`distanceFromCoords`) and point-in-polygon (`pointInPolygon`) to geohash-kit (✅ — one tested/benchmarked impl instead of a second copy; flock keeps the fence *types*, coordinate *validation*, and the *breach decision*). It is **not** one migration, though:
  - `coverage` (`polygonToGeohashes`) is a **representation** tool — map fills (`geohashesToGeoJSON`), no-report zones, coarse-disclosure buckets on one lattice. Its cover **contains** the polygon (edge cells that merely overlap are kept), so it is fail-*dangerous* as a safe-zone breach oracle. Adopt it as those features land.
  - `precisionToRadius` is too coarse to represent real circle fences (610 m → 2 400 m jumps), so **circles stay exact haversine**.
  - A geohash-native *breach* test is **deferred** — its only forcing function is native-shell parity (a Kotlin/Swift prefix check that matches JS bit-for-bit, where haversine/ray-casting have FP-ordering subtleties). When needed, add an **interior** (fully-inside) cover to geohash-kit first — the fail-*safe* variant — rather than feeding the containing cover into a safety check.

## Phase A — Privacy-by-architecture foundation

- [x] **Signer abstraction** (`FlockSigner`) — all event signing, NIP-44, and NIP-59 gift-wrap routed through it (signer-based gift-wrap is unit-tested).
- [x] **Sign in with a signer** (`signet-login` adapter) — key in the signer, **never in flock**; dual local/remote identity + session restore. The picker (`app/src/signin.ts`, +5 unit tests) offers **Signet, a browser extension (NIP-07), Amber, and any NIP-46 `bunker://` / `nostrconnect://`** — so a GrapheneOS user's Amber, an nsec.app account, or a self-hosted heartwood all connect; **nsec-paste is deliberately excluded** (it would reintroduce the key-in-app risk the remote path exists to remove). NIP-46 transport + bunker reconnect ride flock's own no-log relay (`restoreSession({ defaultRelay })`); a `hasNip44` guard rejects a signer that can't drive gift-wrap. *(A live-bunker e2e is deferred — it needs a real signer to pair against; the picker config is unit-tested.)*
  - [ ] **Per-circle personas** — sign each circle's seals under a distinct (heartwood/nsec-tree) persona so a member in two of your circles can't link them to one npub. The generic NIP-46 path is the enabler; deeper lift.
- [x] **nsec-tree circle keys** — circle seeds derived `circleRoot → circleId → epoch` (`keys.ts`); reseed = epoch+1 (deterministic, recoverable from one root, per-circle/per-root unlinkable). Tested. Per-circle *publishing* personas still to come with gift-wrap-everything.
- [x] **Gift-wrap everything** (`giftwrap.ts`) — every signal is NIP-59 wrapped to a rotating nsec-tree group-inbox key (`deriveInbox`); the relay sees only `kind:1059` from random keys to an opaque inbox — no real pubkeys, types, or roster. Tested in-process + live (`#p` round-trip on relay.trotters.cc). **Bonus:** a wrap is self-contained opaque bytes → flock is now **transport-agnostic** (ready for the LoRa path below).
- [x] **Relay strategy** (`app/src/relays.ts`): sensitive Flock traffic fans out
  only across the configured private relay set; the broad public
  `PROFILE_RELAYS` set is reserved for opt-in kind-0 profile reads. The live
  onion twin is an opt-in route. Delivery fails loudly if no sensitive relay
  accepts the event.

## Phase B — Group lifecycle

- [x] **Multi-circle state** — a person in many circles at once. Per-circle live
  state (`circleStates` — beacons/alerts/check-ins/rendezvous never bleed between
  circles), a chip **switcher** in the topbar, add/leave a circle in-app, and a
  multi-inbox subscription so **alerts (SOS / buzz / missed check-in) surface from
  *any* circle** while you're focused on another. Legacy single-circle state
  auto-migrates. Tested in-browser (create×3, switch, distinct seeds, migration).
- [x] **Transient vs long-lived** — at creation pick **ongoing / tonight / 5 days /
  a week**; transient circles carry an `expiresAt`, show a **TTL chip** (`5d`,
  `8h`…), and are **auto-swept** on expiry. Invites carry the expiry too. *(This is
  exactly the "5-day trip with a mate, plus a night out with another group, all at
  once" case.)*
- [x] Create / join (in-person QR + remote gift-wrap) — *done, to be re-based on Phase A.*
- [x] **Sharing is a behaviour, not a persona** — the old *Family / Night-out*
  toggle is now **Private** (hidden until you raise it) vs **Share live · coarse**
  (the "who's still out?" view). The circle *name* carries the category. Lib keeps
  `family`/`nightout` as the internal behaviour keys (no migration). Lifetimes are
  **Ongoing / Today / Custom** (Today = until next 04:00, so a night out isn't cut
  off at midnight). After creating a circle you **land on the Circle screen with
  inviting front-and-centre** (a 👋 lead card + QR/code/remote). Child-first
  language throughout (see `PRIVACY.md`/design notes).
- [x] Reseed / remove member — *done (hand-rolled); migrate to **dominion**.*
- [x] **Buzz** — one-tap encrypted ping to the circle with a chosen reason (preset or custom; adults can assign their own); receiver's phone **vibrates + shows a banner**; optional **targeted** buzz (parent → child). `buzz.ts` lib + Circle UI.
- [x] **Disband / destroy a group** (`disband.ts`) — a member broadcasts a
  gift-wrapped **disband tombstone** to the circle inbox; every member's app drops
  the circle and **wipes its seed** (`removeCircle`). The transport complement to
  canary-kit's `dissolveGroup`; the relay sees only an opaque `kind:1059`. Inline
  two-step confirm in the UI. **Verified end-to-end across two members** (localhost
  member A ↔ live-site member B, over relay.trotters.cc — B dropped the circle).
- [ ] **dominion** — epoch-based access control with tiers (guardians vs children).

## Phase C — Privacy features

- [x] **No-report zones** (`noreport.ts`) — inverse geofences, surfaced as **"Private places"** (home, a
  relative's). Inside one, disclosure is **capped**: withheld or coarsened **even
  on a triggering event** — an SOS over a refuge still fires, but without pinning
  the building. The cap folds into `decideEmission`; zones are on-device only,
  never broadcast. Amber map editor alongside the green "Safe places". Verified
  in-browser (add/save/list, hidden inputs, 0 console errors).
- [x] **Off-grid mode** (`offgrid.ts`) — **"Take a break"**: go dark for 1 hour /
  Today / a custom window. Emits **nothing automatically** (an explicit SOS or
  pick-up still fires — `decideEmission` keeps the triggers, drops the rest);
  **pre-announces** the planned silence to every circle so the dead-man's-switch
  never false-alarms; carries an optional **"why"**; **cancellable** ("I'm back
  now") and **auto-resumes** when the timer ends. Members see "on a break · …".
  Verified in-browser (go dark → orb "Taking a break" → come back, 0 errors).
- [x] **Live presence — rough-area pins + movement-gated cadence** (`app/src/cadence.ts`, `map.ts`). A night-out
  coarse beacon (geohash-6, ±~600 m) now renders as a **translucent "rough area" halo** under the pin
  (`precisionToRadius`), so a cloaked share reads as *"somewhere around here"* instead of a deceptively exact
  point; a full-precision breach/pick-up collapses to the pin ("we know exactly"). Emission is now
  **movement-aware, not time-only**: an **identical geohash cell is never re-broadcast** (standing still stops
  waking the relays) — a beacon fires only on a **cell change** or a slow **heartbeat** (night-out 45 s floor /
  5-min heartbeat; breach 30 s / 3-min), both under the 600 s "stale" window so a stationary member still reads as
  "active". Explicit **SOS/pick-up bypass** the gate and always fire. Cadence is per-circle and reset on reseed.
  The pure gate is unit-tested (7 cases: first-send, floor, cell-change, heartbeat, clock-skew); the night-out
  map e2e asserts the halo renders.
- [x] **Presence polish — petname pins + survives a refresh** (`app/src/store.ts`, `map.ts`). Pins now show a
  member's **petname** (→ opted-in public name → 2-char initials; never a long npub) instead of hex initials —
  rendered via `textContent`, which also **closes an XSS surface** now that a pin label is member-chosen rather
  than hex. **Presence survives a refresh / PWA relaunch**: beacons are cached per-circle in localStorage
  (`prunePresence` — a 6 h age cap + drop-circles-you've-left, pruned on load), rehydrated on mount, and dropped
  on reseed/leave/disband — so a reload no longer blanks the map while it waits up to 5 min for a peer's next
  beacon. Cache is on-device only (no new metadata leaves the phone). 6 new unit tests (`store.presence.test.ts`);
  the night-out map e2e now nicknames A, reloads B, and asserts A's rough area **and** petname persist. **Follow-ups:** none.
- [x] **Festival mode — find each other in a crowd (2026-07-03).** The use case:
  a group at a festival wants to see *where each other is* well enough to walk
  over. The night-out coarse beacon (geohash-6, ±~600 m) is deliberately too
  coarse for that — it says "still on site", not "by the left of the main stage".
  **Shipped as "Find each other":** a device-local, time-boxed precision step-up to
  the finest detail flock offers — **Exact spot (geohash-9, ±~5 m)** on a
  **1 h / 3 h / 6 h** window (capped by the circle's own expiry), opt-in per person
  on Home. *(Boost precision raised from geohash-8 to the slider max 2026-07-04 —
  "walk right to each other" needs the exact spot, not the building.)* It only ever *raises* detail (a finer slider
  wins), the **slider base is never rewritten** (shown separately, restored on
  expiry), and a **no-report place still caps it** — the boost raises the *coarse*
  input to `decideEmission`, it doesn't bypass the policy. Turning it on **starts
  sharing** if it was off; a 30 s monitor **auto-reverts** precision *and* the GPS
  sampling tier the moment the window closes (a battery + metadata win, not just UI).
  `festivalUntil` is **device-local, never synced** (each member opts in for
  themselves — no extra wire metadata). e2e `festival.spec.ts`: A boosts → B's
  rough-area halo collapses to a bare pin → A stops → the halo returns, base slider
  untouched throughout. Pairs with the shipped separation ("lost") alerts, fair
  meeting point, and offline PMTiles basemap (pre-download a congested festival site).

## Phase D — Identity & social

- [x] **Names instead of npubs** (`app/src/profiles.ts`) — private **petnames**
  (your own label for a member, stored on-device, **default**, always win) plus
  **opt-in** public **kind:0** names/avatars from the public profile relays
  (**off by default** — fetching tells public relays which pubkeys you're looking
  up). Inline nickname edit on the Circle screen; settings toggle. Shown
  everywhere (members, alerts, buzz, rendezvous).
- [x] **canary spoken-verify — "is this really my parent, and are they safe?"** (`@forgesworn/flock/spokenverify`,
  Circle screen). A **face-to-face, on-device, zero-relay** pick-up identity check: both phones derive the
  same rotating word from the shared circle seed + a time-based counter (canary `getCounter`, flock-fixed at
  a **1 h rotation, ±1 tolerance** in one audited `SPOKEN_VERIFY` block), so the collector reads a word aloud
  ("Prove it's me") and the child confirms it locally ("Check someone") — **nothing is published**, so there's
  no metadata and no battery (squarely on the minimal-footprint north star), and an impostor who lacks the seed
  simply can't produce the word. **Coercion resistance is built in:** every member also has a **collision-avoided
  duress word**; under coercion the collector reads *that* instead — it verifies as an **identical ✓** (the UI is
  observationally identical, invariants #1/#2) yet **silently raises the circle `help` alarm** naming the coerced
  member (via the existing duress-key path, invariant #3). **Tell-safe by construction:** an alert whose *subject*
  differs from its *sender* is only ever a spoken-verify duress, so the inbound guard keeps it off **both** the
  coerced person's and the checker's screens (a coercer may be watching either) — only the *other* guardians light
  up. A check only detects duress for members your device already knows (roster) — inherent, and correct (you
  verify people in your circle). Pure lib (`spokenWordsFor` / `checkSpokenWord` / `spokenCounter`), **+17 unit
  tests** incl. the two SAFETY invariants (a duress word never reads as plain `verified`; the verify word never
  reads as `duress`); a two-part e2e proves face-to-face verify + impostor-reject (2 people) and the **silent
  duress alarm** reaching a third guardian while the checker and the coerced collector stay calm (3 people).
  **Follow-ups:** surface an alert about a subject not yet on a guardian's roster (add `ensureMember(subject)` to
  the help path); a discreet on-tile duress reveal is a silent long-press (no visible affordance) — worth an
  onboarding note.
- [ ] **Trust** — `nostr-attestations` / `nostr-veil` vouching (optional).

## Phase E — Recovery & resilience

- [ ] **shamir-words** (+ **cairn-kit**) — social / coercion-resistant circle recovery.
- [ ] **stash** — encrypted-to-self vault; survive device loss.
- [x] **keystore-kit — the App lock (key-at-rest)**. Shipped: an opt-in PIN
  (You → Advanced) puts the **whole persisted state** — identity key, circle
  root, every seed, petnames, private places — behind AES-256-GCM at rest. A
  random storage secret is PIN-wrapped by keystore-kit (PBKDF2-600k, namespace
  `flockks`); every save writes `{locked:1, d:<envelope>}` via a **coalescing
  async drain** (sync `save()` signature kept; kill-switch re-checks after
  every await so a hide/disable can't be raced); a stray pre-unlock save can
  **never clobber the ciphertext**. Boot: grace unlock inside a 15-min window
  (kit grace + flock-owned TTL), else a PIN screen with a two-step forgot-PIN
  wipe escape. Composes with the decoy: hiding seals the secret inside the
  sealed state, the decoy shows **no PIN screen** (no tell), unhide boots
  plaintext with a one-tap **re-confirm** card that re-wraps our secret even
  over a keystore blob someone replaced inside the decoy. Excluded from
  backups (device-specific). Consumed from an immutable canonical provider SHA
  until the kit is published — swap to a version range after `npm publish`.
  8 unit tests (`store.rest.test.ts`) +
  2 e2es (PIN gate + live traffic after unlock; the full lock × decoy
  composition). Design: `docs/plans/2026-07-02-app-lock.md`. WebAuthn-PRF
  biometric unlock is wired in the kit but waits for real hardware (Tier 2).
  - [ ] **Publish keystore-kit to npm** (Darren: `npm login && npm publish` in
    the kit repo — its gates are green; consider flipping the repo public to
    match the sibling kits) → then swap Flock's immutable Git dependency to a
    version range.
- [x] **BLE-nearby transport** — the first rung of the off-relay ladder (opaque
  `kind:1059` wraps phone-to-phone over Bluetooth LE when circle members are
  co-located; no relay, no cell, no internet). **Strictly additive** — native-only,
  opt-in, off by default; the relay path is byte-identical when off. Design +
  two-mode rationale in `docs/plans/2026-07-04-ble-nearby-transport.md`.
  **Field-proven A32 ↔ Pixel with all networking off (2026-07-04):** arbitration
  (lower tiebreak yields to server-only), the NOTIFY reverse channel, both
  directions rendering end-to-end, and the discreet→mesh switch (advertId/hops=0 →
  meshUuid/hops=3) all verified on real hardware. Live at `8d6dd03`.
  - [x] **Spike + Slice 1 (hardened, shipped `19111e5`)** — rotating members-only
    advertId (`app/src/bleId.ts`), the forked `FlockBlePlugin`, the additive tap;
    proven A32↔Pixel with all radios off (relay impossible). Slice 1 tamed the
    GrapheneOS rotating-address connection storm (global throttle + link cap +
    backoff + native logging).
  - [x] **Slice 2 — bidirectional single link + crowd mesh** (built, unit-tested,
    APK installed both devices). A **NOTIFY** characteristic carries server→client,
    so re-enabled **role arbitration** gives one link per pair (BLE caps ~7 conns).
    A hop-count envelope floods/relays in crowd mode; discreet stays single-hop.
  - [x] **Shared native transport extraction** — the reusable Android radio,
    chunking, bounded reassembly, arbitration and relay now come from the
    immutable `capacitor-mesh-ble` Git dependency. Flock retains only rotating
    discovery identity, hop policy and opaque gift-wrap integration; the 1,467-line
    app-local plugin was deleted.
  - [x] **Slice 3 — JS mesh integration** — `syncBle` picks discreet (per-circle
    advertId) vs **crowd mesh** (common daily `meshUuid`) from festival "find each
    other"; `onBleFrame` decrypts across **all** circles; festival↔mesh wired.
  - [x] **Validate the mesh path on hardware (2026-07-04)** — the live 2-device
    exchange proven on A32 ↔ Pixel with all radios off: arbitration (Pixel yields,
    server-only), the NOTIFY reverse direction (Pixel→A32 buzz rendered), WRITE
    forward (A32→Pixel buzz rendered), and the discreet→mesh switch. **Remaining:**
    3-device multi-hop (h>0 relay depth) needs a third phone; and the GrapheneOS
    address-rotation churn (peer appears under ~3 rotating addresses → up to 3
    redundant client links, capped by MAX_CLIENT_LINKS) is a tuning follow-up.
- [ ] **mesh-kit** / **mesh-webrtc-lan** — off-relay LAN transport (no internet).
- [ ] **LoRa mesh transport** — phone ↔ a pocket LoRa device over **BLE**, via **Meshtastic** or **MeshCore**. flock signals ride as opaque **E2E-encrypted bytes** (already true post gift-wrap-everything) over the LoRa mesh → works **fully off-grid** (no relay, no cell, no internet) — the ultimate "the relay can't track you". Web Bluetooth (Android/GrapheneOS Chromium) for the PWA; **Capacitor BLE** for iOS. **Rides on the `intermesh-plans` Meshtastic↔MeshCore/MQTT substrate** (active spike). Slots behind the same transport seam (`services.ts`).

## Phase F — Meeting & rendezvous ("be at a place by a time")

Two halves that compose into one feature:

- [x] **Set rendezvous** (`rendezvous.ts` lib + Circle UI) — anyone sets a
  `{ place, deadline, mode: 'be-back' | 'meet-at' }`; place by **name/address**
  (OSM Nominatim geocoding, **no Google**, configurable) or current spot, carrying
  a precise **geohash** + a **"copy address for a taxi"**. Each device computes
  **as-the-crow-flies ETA** (walk/cycle/drive/transit), broadcasts **status**
  (en-route / arrived / **at-risk**), and the setter is **alerted if someone won't
  make it**. Tested (lib) + deployed. **Polish shipped** (all three follow-ups):
  **map-pick a place** — "📍 Pick on map" pans to the map, drops the crosshair
  (the same idiom as the safe/private-place editor) and reads the centre on
  confirm, with a **bounded, best-effort reverse-geocode** filling the taxi
  address; a **live 1 s countdown** to the deadline (`app/src/countdown.ts`
  `formatCountdown`, pure + **+4 unit tests**) driven by a dedicated ticker that
  patches only the `#rzv-countdown` text — never a full re-render — and runs
  **only while the card is on screen** (minimal-footprint north star); and the
  meeting point rendered as a distinct **amber flag pin** (`MapView.setRendezvous`,
  independent of member pins so it persists across presence updates and shows with
  no beacons). A two-person **e2e** (`e2e/rendezvous.spec.ts`) proves map-pick →
  B receives the flag pin **and** a *ticking* countdown over the live relay.
- [x] **Find a fair meeting point** — "some in bar A, some in bar B → where do we
  all go?", computed **entirely on-device** over **rendezvous-kit**. Two slices
  shipped:
  - **Slice 1 — engine core** (`app/src/meetingPoint.ts`, +6 unit tests). A flock
    **on-device `RoutingEngine`** — radius isochrone (`circleToPolygon`, speed ×
    time) + a haversine travel-time matrix, pure/offline/deterministic so **member
    coordinates never leave the device** and there is **no third-party call**
    (rendezvous-kit's own `findRendezvous` always hits public Overpass, so we
    compose its geo primitives ourselves). `suggestMeetingPoint()` intersects the
    isochrones and returns the centre of the overlap (centroid fallback when they
    don't), with per-person ETAs + **fairness score** (`min_max` / `min_total` /
    `min_variance`). A real engine (Valhalla/ORS) can slot behind the same seam
    later — **opt-in, never a silent fallback**.
  - **Slice 2 — the flow** (`@forgesworn/flock/meeting` + Circle UI, +6 unit tests). New
    protocol signals **`mtg-req`** (a proposal: mode + time budget) and **`mtg-loc`**
    (a member's **opt-in, coarse** contribution — a neighbourhood **geohash-6 cell**,
    never an exact fix), both group-envelope encrypted like rendezvous. Flow:
    propose → each member taps **"Share my spot"** (declining sends nothing —
    withhold-by-default holds) → the **proposer's device** decodes the coarse cells
    and computes the fair point → **suggestion card** with everyone's ETA → **pick →
    it becomes an ordinary set-rendezvous** (the pin + live countdown machinery
    already built). A two-person **e2e** (`e2e/meeting.spec.ts`) proves propose →
    B opts in → A computes → set → B receives the rendezvous, over the live relay.
- [x] **Find a fair meeting point — Slice 3 (venues + granular precision)** — shipped
  across four sub-slices, each committed + deployed:
  - **3a — venues** (`app/src/venues.ts`, +5 unit): the on-device centroid is upgraded
    to a real, named venue everyone can reach (pub/bar/café/restaurant/fast-food) via a
    same-origin **`/overpass` proxy** (Caddy `handle_path` + Vite dev proxy, client
    headers stripped) — `searchVenues` sends only a **bounding box**, never participant
    coordinates. Best-effort: any failure (proxy down, rate-limited, no matches) keeps
    the centroid. e2e proves the venue name rides propose→compute→set→the recipient's pin.
  - **3b — fairness toggle**: with ≥2 candidate venues the proposer balances travel —
    **Fairest** (min_max) / **Least total** (min_total) / **Most equal** (min_variance) —
    persisted per device, re-ranking the **cached** venues **in place** (no re-fetch,
    minimal footprint). +1 unit (strategies diverge deterministically) + e2e.
  - **3c — per-person exact precision**: a contributor can share their **precise** spot
    with the **proposer alone** — a geohash-9 share **gift-wrapped to the proposer's
    personal inbox** (encrypted to their key, filed under `personalInboxTag`, no npub on
    the wire) — while the group inbox still sees only the coarse cell. The proposer's
    existing personal-inbox subscription falls through to a meeting-share decode (invite/
    reseed path untouched); `mergeMeetingShare` prefers the finer disclosure whichever
    order coarse/exact land. +5 unit incl. **the privacy invariant (only the named
    recipient can decrypt)** + invite/exact cross-type isolation; e2e over the live relay.
  - **3d — map overlays**: while a search is live the map shows each contributor's cell
    **at its disclosed precision** (coarse = a violet "rough area" blob, exact = a crisp
    glowing dot) + the suggested venue as its own pin, replacing presence pins so the
    same people aren't double-drawn. e2e asserts the venue pin + both contributor cells.
  - **Prod note:** venues need the `/overpass` **Caddy drop-in** applied on the host
    (`deploy/Caddyfile`, `sudo tee`); until then the app degrades gracefully to the
    centroid. See `docs/plans/2026-07-01-fair-meeting-point.md`.
- [ ] **Precision ladder — generalise beyond the meeting point** *(deferred; no forcing
  use yet)*. A per-**circle** default-precision setting (Town / Neighbourhood / Street /
  Exact) + per-**person** overrides stored like petnames, applied to shares generally.
  Slice 3c already proves the targeted-gift-wrap mechanism (exact to the proposer); this
  widens it to "a chosen level, to a chosen person." See `2026-07-01-fair-meeting-point.md`.

## Phase G — Platform & release

- [~] **Capacitor Android application** — shell and native services ship;
  **background *publish* is done and measured GREEN** (2026-07-05 — beacons flow
  while locked, see above). Background **geofence-*breach*** alerting is not yet
  wired into the native pipeline (the MVP parks breach; add it — and validate with
  the outdoor walk — when breach returns to the app).
  - [x] **Android APK ships (2026-07-03)** — `npm run apk` / `npm run apk:release`
    (`native/build-apk.sh`: generate → native-mode web build → manifest patch →
    icons → Gradle → zipalign/apksigner). `native/background.ts` still handles
    permission and forwards fixes while JavaScript is alive, but the authoritative
    hidden/locked publisher is `FlockLocationService` + the pure Kotlin
    `FlockPublisher`: fix → policy → encrypt → gift-wrap → relay without the
    WebView. Configuration and service lifetime remain tied to the sharing toggle
    and are cleared on stop/reset/**hide** (the notification must never be a decoy
    tell). Native builds
    point the privacy proxies at flock.forgesworn.dev (`app/.env.native`); Caddy
    gained the CORS headers the shell's `https://localhost` origin needs
    (`deploy/Caddyfile` — **manual conf.d re-drop needed on the host**).
    `allowBackup=false` keeps plaintext localStorage out of adb/cloud backups.
  - [x] **Tier 1 on-device functional validation (2026-07-03)** — Samsung Galaxy
    A32 (Android 13), sideloaded via adb: install → onboarding → circle creation →
    map tiles through the CORS'd production proxy → native location permission →
    safety watch → **foreground service + "keeping watch" notification while
    backgrounded** (OS location indicator on) → stop-sharing tears both down.
    The whole native loop works on real hardware.
  - [x] **Reliability gate — CLOSED (2026-07-05).** Layer B first: a standalone
    native probe (`native/gps-probe/`) on a **GrapheneOS Pixel 10 Pro (API 37)**
    logged **46 fixes @ ~10 s cadence, longest gap 10 s**, screen locked + walking,
    the foreground service never killed → the OS delivers GPS to a locked background
    service. Then the fix itself: the **native publish pipeline + `FlockLocationService`
    GPS source** (see "Native background publish — locked sharing works" above) turn
    those locked fixes into published beacons, **measured GREEN end-to-end** on the
    same Pixel — native beacons decrypting on the relay with the screen locked
    (Dozing), at +7 s then ~50 s cadence, geohashes changing. Shipped as release
    `0294b8c`. **Both remaining validations now GREEN (2026-07-06):** the **outdoor
    walk** (two-phone, moving pin through a locked/pocketed screen) and the **stationary
    deep-Doze pass** (device pinned in forced deep `IDLE` — screen off, OS-unplugged, no
    maintenance windows — still published three exact beacons at the ~300 s cadence, all
    decrypted on the relay, GPS ticking at 5 s throughout). This closes the
    **outbound background-publish** claim; it does not close the separate radar,
    Orbot, inbound battery/device, or iOS rows. See "Native background publish"
    above for the full measurements.
- [x] **Inbound alerts (app closed) — SHIPPED via Option A, validated on the A32
  (2026-07-04).** Notification behaviour: a message/buzz/alert lands on a
  **locked screen while flock is fully closed**. Implemented as a **location-free
  foreground service** (`native/android/StayReachableService.java` +
  `StayReachablePlugin.java`, injected by `patch-android.mjs`; `specialUse` type —
  no GPS, no location indicator) that keeps the process — and thus the
  **already-always-on relay subscription** — alive, so the normal decrypt →
  `LocalNotifications` pipeline runs closed exactly as in the foreground. Opt-in
  toggle **You → Notifications → "Stay reachable when closed"**
  (`persisted.stayReachable`, `native/stayReachable.ts`), off by default; requests
  a Doze **battery-optimisation exemption** on enable (Samsung/OEM would freeze it
  otherwise); torn down on decoy-hide + reset so its ongoing notification is never
  a "fresh install" tell.
  *Device proof (A32, Android 13):* with flock backgrounded + **screen off
  (Dozing)**, a group buzz from a second member posted `title="LockTest",
  text="Member r52d: …"` on channel `flock-group-v1` (importance 4, per-circle
  group key) — content visible on the locked shade. `dumpsys` confirmed the FGS
  foreground + the app in the Doze whitelist.
  *Superseded earlier partial (2026-07-03):* toast→notification mirror only while
  the location watcher held the process (sharing on). Now decoupled from sharing.
  *Still open for Tier 2:* re-validate on a **GrapheneOS Pixel** (Android 15/16 —
  `specialUse` chosen precisely because dataSync is 6h/day-capped there); measure
  battery cost of the always-on socket over a night.
  *Notifications differentiated (2026-07-04, validated):* `native/notify.ts` posts
  on distinct Android channels — **Direct messages** (1:1), **Group messages**
  (buzz/notes), **Safety alerts** (lost-phone), **General** — separately tunable,
  high-importance (heads-up), stacked per conversation, headed by the
  sender (DM) or circle (group). Channels created at boot in
  `ensureNotifyPermission`; immutable once made → a later change needs a new
  channel id (`-vN` suffix).
  *Lock-screen content shown even under "hide sensitive" (2026-07-04, validated):*
  channel-level PUBLIC is normalised by Android to NO_OVERRIDE (an app can't force
  a channel more public than the user's global setting), so message notifications
  are instead posted through a small native plugin (`FlockNotifyPlugin.java`, via
  `native/notify.ts`) with **notification-level `VISIBILITY_PUBLIC`** — which *is*
  honoured — so the sender + message show on the lock screen even when the device's
  global setting is "hide sensitive content" (the LocalNotifications plugin
  hardcodes PRIVATE, which is why we post natively). Proven on the A32 with
  `lock_screen_allow_private_notifications=0`: the buzz posted `vis=PUBLIC` with
  full title/body while other apps' notifications redacted to a public version.
- [ ] **Go-live hardening (foreground PWA — needs no devices):**
  - [x] **Proxy map tiles + geocoding (Stage 0) — DEPLOYED & LIVE** on
    flock.forgesworn.dev. Tiles (`/tiles/*`) and Nominatim (`/nominatim/*`) are
    **reverse-proxied same-origin** (Caddy `handle_path` blocks in prod, Vite dev proxy
    in dev). OSM sees only the host, never a user's IP + viewport. Defaults flipped in
    `map.ts`/`geo.ts`; client-identifying headers stripped upstream; CSP unchanged (opt-in
    kind:0 avatars still need `img-src https:`). Verified at the edge: `/tiles` + `/nominatim`
    200 same-origin, and the built app no longer references `tile.openstreetmap.org`. **The
    original launch-blocker (the map viewport leak) is closed in production.**
  - [x] **Proxy Overpass venue search (meeting point) — DEPLOYED & LIVE.**
    `/overpass/*` reverse-proxies same-origin to OSM Overpass (Caddy `handle_path` + Vite
    dev proxy, client-identifying headers stripped, `no-store`), mirroring the Stage 0
    tiles/Nominatim proxy — `searchVenues` sends only a **bounding box**, never a
    participant's coordinates. The `deploy/Caddyfile` drop-in is applied on the host and
    verified at the edge (`/overpass` returns live Overpass JSON, 200). Prod venues are
    live; the flow still degrades gracefully to the on-device centroid if Overpass is
    unreachable (Phase F Slice 3a).
  - [~] **Local / offline vector basemap (Stage 1) — spiked & proven.** A vector PMTiles
    basemap (`app/src/basemap.ts`, behind `VITE_PMTILES=1` / `localStorage flock.pmtiles`)
    renders flock's **dusk palette** from a **single same-origin file** — a whole ~11 km
    town, z0–15, is **3.3 MB** (verified: `go-pmtiles extract` from the Protomaps daily
    build, +~2 MB self-hosted glyphs/sprite via `scripts/fetch-basemap-assets.mjs`; **zero
    third-party calls** — confirmed in-browser). Fetched once → cached on-device → the map
    makes **zero** network calls at view time (no when/where-you-look leak) and works
    offline. Vector dusk restyle done.
  - [x] **"Save this area" (Stage 2) — LAUNCHED & LIVE.** Per-circle offline vector maps:
    `app/src/area.ts` (bbox of zones + buffer; tested) → `server/extract.mjs` on the host
    (`flock-extract.service` on `127.0.0.1:8791`, Caddy `/api/extract`; clips the Protomaps
    daily build **server-side** so the browser only ever talks to our origin — 400/413/429
    guards, span + concurrency caps, `no-store`, bbox never logged) → `app/src/offlineArea.ts`
    (POST → OPFS → a maplibre style over a pmtiles `FileSource`). `VITE_OFFLINE_MAP` is on in
    the canonical deploy; glyphs (Latin + General Punctuation) + sprite shipped and kept in a
    **deploy-surviving** SW cache (`flock-basemap-v1`); an **out-of-area chip** flags pins
    beyond the saved map (**never** live-fetches mid-event). **Verified end-to-end on prod:**
    onboard → add a place → "Save map offline" → 6.5 MB to OPFS → the vector map renders
    offline with **no asset 404s**. **Follow-ups:** an e2e (mock `/api/extract` — CI has no
    `go-pmtiles`); CJK/other-script glyph ranges if flock goes international; a per-IP
    rate-limit on `/api/extract`.
  - [x] **Map labels — device locale + per-user "Local names" toggle (launch markets verified).**
    The offline vector basemap labelled everything in English; now it follows each member's
    **device locale** (`app/src/lang.ts` `preferredMapLang`, constrained to glyph-covered
    Latin/Greek/Cyrillic → English otherwise, so never tofu), with a per-user **Map labels**
    toggle on the offline control — **My language** (default) vs **Local names** (the tiles'
    native `name`, matching street signs, identical on every member's map — for a
    mixed-nationality group abroad, since each map renders per-device). Glyph coverage
    **verified** for the initial markets (UK/DE/CZ/Mallorca/Madeira — all Latin) by rendering
    real towns via `app/lang-proof.html`: München (ß ö ü), Praha (ě ř č ž ů — Latin Extended-A),
    Palma (Catalan ç), Funchal (Portuguese ã ç). **Verified end-to-end on prod:** the toggle
    flips, persists `flock.maplabels`, and re-inits the map cleanly. Deploy now excludes
    prebuilt `*.pmtiles` from prod. **Follow-ups:** preserve the map camera on label switch
    (currently re-centres); missing POI sprite icons (e.g. `townhall`) need a custom sprite;
    whole-island saves exceed the 60 km extract cap (Mallorca ~90 km).
  - [~] **Multi-relay fan-out — machinery shipped (`73ee7d7`).** Signals publish to
    every relay in the no-log private set and succeed if any accepts; subscriptions
    read across the set (the pool dedupes a wrap arriving from several relays), so a
    relay outage no longer drops inbound alerts. Also **fails loud** — nostr-tools'
    pool RESOLVES a `"connection failure"` string when a relay is unreachable, so the
    old `Promise.any` read an all-relays-down send as success (**an SOS could look
    sent when it never left the device**); publishes now throw if NO relay accepted,
    which every caller surfaces as "couldn't send". Fan-out stays on `PRIVATE_RELAYS`
    (no-log) — **never** the public profile set, which would leak traffic timing + IP
    to an untrusted operator even though content is an opaque `kind:1059`. Persisted
    `relayUrl → relayUrls[]` (migrated); settings is now an **editable relay list**.
    TDD +16 unit tests; full two-person e2e green. **Redundancy is opt-in until the
    private set has >1 relay** (add a trusted one in settings) — the real out-of-box
    fix is to **stand up a second no-log relay we control** (infra: host + domain,
    mirror the trotters setup) and add it to `PRIVATE_RELAYS`, no code change.
    **Runbook ready** (`docs/runbooks/second-relay.md`): bare host → serving
    traffic, nostr-rs-relay for verified NIP-40 parity, no-log OS posture, Tor
    v3 onion, verification checklist + the NIP-40 probe (`scripts/nip40-probe.mjs`).
    **Blocked only on a host** (VPS in a different failure domain + DNS + root SSH).
  - ✅ **Licence** — resolved to **MIT** (matches `package.json` and the whole ForgeSworn toolkit): added a `LICENSE` file (`Copyright (c) 2026 TheCryptoDonkey`) and linked it from the README, replacing the old "TBD".
  - [x] **Key-at-rest — closed by the App lock** (keystore-kit, Phase E): opt-in
    PIN encrypts the whole persisted blob at rest; the in-app caveat copy now
    points at the lock. Signet sign-in remains the stronger path (key never in
    flock at all).
- [x] **Release CI** — GitHub Actions gates lint/typecheck/build, bundle budgets,
  80% coverage, same-job Kotlin→JavaScript reverse-vector parity, and the
  two-person Playwright suite against a fresh RAM-only relay. Actions are
  SHA-pinned; production-relay smoke remains explicit and production receives no
  push-test traffic. anvil publishing is deliberately omitted while the library
  is private/unpublished.
- [~] **Verifiable builds — the compelled-update defence** (plan:
  `docs/plans/2026-07-06-verifiable-builds.md`; procedure: `docs/verify-apk.md`).
  The one court order that bypasses E2E is a compelled **targeted backdoored build**
  (Lavabit / Apple–San-Bernardino shape); we can't be made unable to comply, but we
  can make compliance **detectable**.
  - [x] **APK reproducibility — DONE, measured 2026-07-06.** The unsigned release
    APK is byte-identical across four independent clean builds. Removed the sole
    wall-clock input (build date now derives from the commit epoch, TZ-independent —
    `vite.config.ts`); added `npm run apk:verify` (unsigned build + anchor hash, key
    untouched) and anchor publication in `deploy.sh` (`flock.apk.unsigned.sha256`).
  - [x] **Off-host / transparency-log publication — LIVE; first real release attested
    2026-07-06.** Append-only, SSH-signed record that rides git off our host: `npm run attest`
    (`scripts/attest-release.mjs`) appends `docs/transparency/RELEASES.jsonl` and mints a
    signed `release/<build>` tag embedding `build → commit → unsigned/signed APK sha256`,
    verifiable with `git verify-tag` against `docs/transparency/allowed_signers`. Dedicated
    ed25519 release key (gitignored like the keystore, `.pub` committed). Signing chain
    proven end-to-end (selftest passes; rogue key rejected). **First real release cut &
    published: `release/dfaa8a9`** (commit `dfaa8a9be9…`, ledger line 2) — unsigned anchor
    `d60b5067…de0792cd` (reproduced byte-identically across 3 independent clean builds),
    signed APK `0b7986e6…b76a63`, signer cert canonical `320ab5bc…9877`. Signed tag pushed
    to the forge and **all four channels verified to agree at the edge**: the downloadable
    `downloads/flock.apk` re-hashes to the attested signed hash, `flock.apk.unsigned.sha256`
    == the reproducible anchor, `apk.json` == build `dfaa8a9`, and the off-host signed tag +
    ledger carry the same record. Remaining: a project-key **Nostr note** as channel #2.
    The GitHub repository is currently **private**; public independent tag/source
    verification therefore remains gated on an explicit future visibility decision.
    See `docs/transparency/README.md`.
  - [ ] **Gradle dependency locking** — pin transitive artefacts against far-future
    drift.
  - [ ] **PWA tamper-evidence** — signed asset manifest + SRI, honest ceiling stated;
    **steer at-risk users to the APK** (the web app can't match a signed, reproducible
    binary served from a compellable host).
  - Pairs with the warrant canary + `.onion` endpoint (see `docs/PRIVACY.md`
    "When a court comes knocking").

## Phase H — Minimal footprint (battery, bandwidth, metadata)

The **north star**: flock should cost a phone almost nothing to carry. The
movement-gated cadence (Phase C) throttles relay **publishes** — but *not* GPS
**sampling**. A continuous `watchPosition({ enableHighAccuracy: true })` is the real
battery drain, and it runs the whole time you're sharing. Close that gap, matching the
hardware cost to what we actually disclose. (Ordered biggest-win-first.)

- [x] **Accuracy matched to disclosure precision — shipped.** Night-out shares now sample
  at **low power** (`enableHighAccuracy: false`, network/cell) — ample for a ~600 m cloak,
  the biggest battery saving, and coarser-by-construction = **more private**. Family keeps
  GPS and is **adaptive**: a cheap fix that lands *uncertain* near a safe-zone edge escalates
  to **one sharp one-shot** before deciding, so we neither miss a breach nor cry wolf. Breach
  is now **accuracy-aware** in the security-critical core — `classifyContainment` (lib)
  returns inside / outside / **uncertain** from the fix's `accuracy` radius, and
  `decideEmission` fires a breach **only on a confident `outside`** (accuracy defaults to
  exact, so the 216-permutation truth-table is unchanged). Explicit **SOS / pick-up take a
  fresh one-shot fix** (~2.5 s cap, last-known fallback), decoupling emergency accuracy from
  the ambient (suspended / low-power) watch. TDD: +22 unit tests (`geofence.accuracy`,
  `policy.accuracy` incl. a no-false-breach sweep); a new e2e proves an imprecise near-edge
  fix never false-discloses while a confident one still breaches.
- [~] **Back off sampling when it can't matter.** **Shipped:** the GPS watch is now
  centralised behind `syncWatch()` = `sharing && !isDark() && !hidden`, so it suspends
  **entirely during an off-grid break** (it used to keep burning while `onFix`
  early-returned) and while the app is **backgrounded** (`visibilitychange` — a foreground
  PWA can't sample in the background regardless), and resumes on come-back / auto-resume /
  return-to-foreground. A safe subset — **no change to accuracy, the emission decision, or
  the SOS path**; full e2e green plus a new "sampling suspends during a break, resumes on
  return" test.
- [x] **Stationary back-off (night-out) — shipped.** A night-out share now samples via a
  **self-scheduled poll** (`services.pollLocation`) that eases off when still — exponential
  back-off 30 s → 180 s, reset the moment it moves (`hasMoved` ignores jitter up to the
  coarser of the two fixes' accuracies) — instead of a continuous watch, letting the radio
  sleep between samples. Capped under the 600 s "stale" window so a still member never reads
  as "gone home". **Family deliberately stays on the continuous, tight watch:** a breach must
  be caught fast even for a *fast* exit (a child driven off is exactly when it matters), so
  family GPS must **not** back off — a safety line, not a battery one. Pure helpers TDD'd
  (`hasMoved`, `nextPollDelaySeconds`); night-out share + family breach e2es both green.
- [x] **Battery-aware — shipped.** Battery Status API (Chromium; absent elsewhere ⇒
  never conserve): battery ≤20% AND discharging AND **no live alert anywhere** widens the
  night-out poll (cadence `conserve` doubles every delay; the stale-window ceiling still
  holds so a still member never falsely reads "gone home"). Family's continuous watch is
  deliberately untouched (safety line), and any alert — mine, failed, incoming, check-in,
  breach — restores full cadence. Pure logic TDD'd in `cadence.test.ts`.
- [ ] **Broader battery validation needs hardware** — outbound walking and forced
  deep-Doze publication are already green on a GrapheneOS Pixel 10 Pro, and
  app-closed inbound alerts are green on a Samsung A32. What remains is measured
  battery cost and reconnect behaviour across the supported device/ROM matrix,
  especially with Stay reachable, radar, Tor, and BLE enabled independently.

## Phase I — Product-audit hardening (2026-07-02)

A full product audit (docs + spec + every module, findings verified in code)
found the wire protocol sound — gift-wrap-everything has no bypass path, key
domain separation holds — and the gaps clustered around the **human failure
modes**. Plan with designs, decisions, and per-slice tests:
`docs/plans/2026-07-02-product-audit-hardening.md`. In priority order:

- [x] **Slice 1 — no-report zones fail-safe under GPS noise** 🔴 — the cap used crisp
  `isInside` while breach used accuracy-aware `classifyContainment`; a noisy fix near a
  private place during an SOS could pin the exact address. `inNoReportZone`/
  `noReportPolicyAt` now take the fix's accuracy and treat `uncertain` as inside (capped)
  — only a *confident* outside escapes, the exact mirror of breach flipped to the
  redaction-safe direction. Accuracy 0 stays crisp, so the 216-permutation truth-table
  is untouched. TDD +11 unit tests (incl. a SAFETY accuracy sweep on the SOS path); new
  e2e proves an imprecise near-edge SOS reaches B location-less. All 3 app call sites
  already passed `accuracyMetres`, so the fix is live with no app change.
- [x] **Slice 2 — confirm destructive actions** 🔴 — "Sign out & reset" and "Remove
  member" executed on one tap; both now use the disband two-step inline confirm idiom
  (arm → alert-coloured warning + Cancel), reset warns "no way back" (Slice 4 will link
  the backup). E2e: a new `reset.spec.ts` (arm → cancel keeps the circle → confirm wipes
  to onboarding) and the 3-party remove spec now drives arm → cancel → re-arm → execute.
- [x] **Follow-up (found during Batch 1) — typing is wiped by any inbound re-render** 🟡 —
  fixed systemically: `render()`/`rerenderOnboard()` capture the focused input (value +
  caret) before the DOM rebuild and restore it after; deliberate clears unaffected
  (tapping a button blurs the field first). The `sendBuzz` fixture dropped its atomic
  workaround — every buzz spec is a live regression test — and `typing.spec.ts`
  reproduces the original failure with real keystrokes (B mid-typing when A's buzz
  re-renders B's screen).
- [x] **Slice 3 — safe places sync across the circle** 🔴 — fences were device-local
  only, so a guardian's safe place did nothing on the child's phone. Shipped in three
  sub-slices: **3a** — fences move onto the `Circle` (per-circle), legacy device-global
  sets migrated into every circle (behaviour-preserving; 4 unit tests); **3b** — new
  lib module `@forgesworn/flock/fences` (`t:'fences'`, group-envelope, gift-wrapped like every
  signal): idempotent **full-replacement set, latest-wins** (`updatedAt`, equal-clock
  tie-break on the smaller `by` → convergent; echoes are no-ops; **empty set is valid**
  so deletes sync; strict re-validation on decrypt so a malformed set can never
  silently disable breach detection; 14 unit tests), publish-on-edit with a
  monotonic clock, relay replay covers late joiners, reseed replays the set under the
  new key; **3c** — map-panel copy tells the truth ("Shared with everyone in <circle>" /
  "Yours alone — never leave this phone"), FLOCK.md §3.2 rewritten for the shipped
  design (the old kind-30078 stored-signal spec would have leaked a stable d-tag).
  E2e (`fences.spec.ts`): **B breaches a fence only A drew** — drawn on A, lands on
  B's map with zero setup, B leaving alerts A over the live relay — plus delete-syncs.
  Private places stay device-only by design. *(Role-gated editing waits for dominion.)*
- [x] **Slice 4 — circle-root backup & restore** 🟠 — device loss used to destroy every
  circle forever. New `app/src/backup.ts` (7 unit tests): a single passphrase-encrypted
  token — PBKDF2-SHA256 (600k) → canary-kit's AES-256-GCM envelope, **no new crypto** —
  carrying identity, `circleRootHex`, the circles **with their seeds** (a joined
  circle's seed is *not* derivable from your root — root alone was never enough),
  petnames and private places; relay list + presence cache deliberately excluded.
  You-tab **Backup** card (copy code / download file; the reset confirm points at it);
  **Restore from backup** on the welcome screen; restore merges without clobbering
  (existing identity/circles win, missing ones are added). E2e: back up → wipe →
  wrong passphrase rejected → restore → **B's next buzz decrypts on the restored
  device** over the live relay. Superseded by shamir-words/stash when Phase E lands.
- [x] **Slice 5 — duress cover for stop-sharing / disarm / off-grid** 🟠 — FLOCK.md
  §6.1's coerced-stop silent alarm was unimplemented at the three real coercion points.
  Now a **silent long-press (1.2 s)** on Stop sharing / check-in Turn off / Go dark
  performs the identical visible action **and** raises the circle `help` alarm via the
  existing duress path (`raiseDuressAlarm` — fresh fix, no-report cap respected, silent
  on failure). Tell-safe: hold-tracking is keyed by action (survives a mid-hold
  re-render), a 10 s ceiling stops a stale pointerdown misreading keyboard activation
  as covert, and a `covertHelpUntil` window drops the raiser's own relay echo so
  nothing on the coerced screen changes — an overt SOS keeps its own-screen behaviour.
  On the wire the extra wrap is indistinguishable from any signal. FLOCK.md §6.1 marked
  implemented. E2e: normal tap-stop reaches nobody; long-press stop alarms B while A's
  screen stays clean. *(Deliberately NOT on SOS — that's an overt action by design.)*
- [x] **Slice 6 — uniform NIP-40 expiry on every gift wrap** 🟠 — every wrap now carries
  `expiration = created_at + 16 d` (85f5cb0): one window for ALL types (a per-type
  window would be a type-tell), derived from the backdated `created_at` so the tag adds
  zero information. relay.trotters.cc verified behaviourally (rejects expired at
  publish, suppresses on read). FLOCK.md §6.6 bounded-retention invariant; PRIVACY.md
  retention row. Consequence handled in Slice 7: replay only covers the window, so the
  fence author republishes when a newcomer appears.
- [x] **Slice 7 — "a new phone joined" notice** 🟡 — `ensureMember` routes through pure
  `store.withNewMember`: unexpected roster additions land in `unseenMembers` → toast +
  persistent banner + "new" badge until acknowledged, remedy signposted (You → remove,
  which reseeds). Silent when expected (self, invites I sent) or within a 10-min join
  grace (the roster replaying to a fresh joiner isn't news — every OTHER device still
  notices the joiner). Fence author republishes on any addition (Slice 6 consequence).
  E2e: join → buzz → banner on A, none on B, "Got it" sticks.
- [x] **QR invite leak (found by Darren in real use)** 🔴 — scanning the invite QR
  offered "Search Google for this text": the code, SEED INCLUDED, went to a search
  engine. Fixed: QR + copy button now carry `origin/#join=<code>` — camera apps open
  links; the fragment never reaches any server (not ours, not Cloudflare) and is
  scrubbed from the address bar on consumption, including fragment-only navigation
  while flock is already open. Pasted bare codes and full links both join.
- [x] **Slice 8 — permission-denied guidance + invite-wait feedback** 🟡 — location
  errors carry a structured kind (`GeoErrorKind`); denied ⇒ persistent actionable
  card + honest toggle + retry; transient no-fix ⇒ calm "Looking for you…" card that
  clears on the next fix (watch keeps trying); remote-invite wait shows "still
  waiting" guidance after 60 s. E2e simulates the denied browser API at the boundary
  (Playwright auto-resolves geolocation even ungranted — probe-verified).
- [x] **Slice 9 — invite hygiene: share-sheet over clipboard** 🟡 — invite button
  prefers `navigator.share` (secret never touches a cloud-syncing clipboard);
  clipboard = desktop fallback, selectable text = last resort; AbortError treated
  as "sheet closed", not failure. (QR→link + trust-framing toast shipped earlier
  with the QR-leak fix.)
- [x] **Slice 10 — Cloudflare in the threat model + private map default** 🟡 —
  PRIVACY.md gains "the map & the host": honest table of what CF sees as TLS
  terminator (IP + tile viewports, searches, extract boxes ≈ home) + mitigations.
  Offline-map control now ON for everyone ('0' opts out; raster = automatic fallback
  for unsaved areas; /api/extract verified live on prod). **Decision taken (2026-07-02):
  grey-clouded** — CF is out of the TLS path (verified: direct LE chain, no cf-ray,
  proxies + no-cache headers all green from the origin). Bonus: kills the CF
  Browser-Cache-TTL override that made deploys sticky for returning users.
- [x] **Slice 11 — truthful SOS states** 🔴 — "Help sent" now only after a confirmed
  publish; failure = persistent "Help didn't send / tap to try again" orb (retry, not
  toast). Receiver orb shows "[name] needs help / tap to see where" from `st.alerts`
  across all circles; tap focuses the circle (map when a location is held). New
  `allclear` library signal (group envelope key): "I'm safe now" stands the circle
  down; covert long-press sends `coerced:true` inside the encryption — identical
  screen + wire, receivers keep alarming; only the alert's owner can stand it down.
  E2e: broken-relay SOS shows persistent retry; genuine stand-down clears B; coerced
  stand-down calms A's screen while B stays alarmed.
- [x] **Slice 12 — helper hints + settings switch** 🟠 — `hint(id, text)` component
  (`.tip`, per-hint ✕), persisted `{on, dismissed[]}` via pure `hintShown`/
  `withHintDismissed`, "Show helper tips" switch (**off by default**) + "Bring all tips back"
  on You. Placed: start-watch (mode-aware what/why), SOS/pick-up pair, remote invite,
  pick-up check, delivery servers. The current MVP later changed the default to
  off: e2e proves opt-in → dismiss one → off/on preserves the dismissal → reset
  deliberately brings all tips back.
- [x] **Slice 13 — jargon & copy pass** 🟠 — npub → "invite key" (+ friendly error
  copy), reseed → "Reset this circle's security", dead-man's-switch → "Automatic
  check-in", "Nostr relays" → "Delivery servers", transient → temporary, Rendezvous
  unified as Meeting point, `~geohash` under members → "location on the map" (e2e
  markers updated), gift-wrap/NIP-44 jargon removed, plain-words footer.
  *Deferred to Slice 14: npub-as-name placeholder + nickname prompt on adoption
  (flow change, not copy).*
- [x] **Slice 14 — structure & flow simplification** 🟡 — You-tab Advanced fold
  (servers/security/leave/disband/reset collapsed by default; fixtures gained
  `openAdvanced`); npub never shown as a name ("Member <tail>" + join-notice ✎
  nudge); await-screen key QR → `origin/#invite=` link that prefills the sender's
  form; failed clipboard copy renders the link as selectable text. *(Circle-tab
  card consolidation deferred — meeting/rendezvous cards are already mutually
  exclusive in practice.)*

## Phase J — Safety-loop library features (2026-07-02) — ✅ LIBRARY COMPLETE, UI PARKED

Four disclosure-on-event primitives were completed in the library on
2026-07-02. They trigger on inaction or duress rather than continuous tracking.
Their historical app UI was removed during the focused MVP pass; “complete” in
this phase means library implementation/tests, not current user-facing support.

- [x] **Check-in self-reminders + escalation-until-acknowledged.** Shipped:
  `selfCheckInStatus` (local-only nudge: due-soon → overdue → missed; a reminder
  that emitted traffic would be a tell), `ack` signal (`CheckInAck`, envelope
  key, sender-must-match-claimer like `allclear`, stale-episode acks dead once
  the target checks in again), and `classifyEscalation` (levels 0→2 by
  `stepSeconds`, first responder wins, unacknowledged sorted first). PWA: "I've
  got this" button on a missed member's row → "✓ X on it" pill on every device;
  escalating toasts until acknowledged; orb subtitle shows who's handling it;
  **custom check-in cadence** (5 min–24 h input alongside the presets). E2e:
  custom-cadence arm A→B, self-reminder due-soon→overdue (clock), and a
  3-person miss → B acks → C sees "on it" + its own ack button gone. 15 new
  unit tests (`flock-kit/src/checkin.test.ts`).
- [x] **Pre-SOS breadcrumb trail.** Shipped: `@forgesworn/flock/trail` — `pushCrumb`
  (pure rolling buffer: ≥60 s spacing, ≤15 min age, ≤12 crumbs) +
  `buildTrailSignal`/`decryptTrail` under the **duress key** (trail exists only
  because a trigger fired — never the beacon/envelope domain). PWA: buffer fed
  from `onFix`, **memory only** (never localStorage); **no-report zones
  excluded at record time** (fail-safe); trail rides out best-effort with
  help/SOS and breach; receivers draw red dotted crumbs + line on the map
  (`map.ts` `setTrail`), member row says "recent trail on the map"; a genuine
  all-clear deletes it; 30-min display window. FLOCK.md §3.6. E2e: A moves
  under a fast-forwarded clock → SOS → B gets alert + trail.
- [x] **Guardian-visible battery health.** Shipped: optional
  `battery: 'low' | 'critical'` on `CheckIn` (inside the encryption, absent =
  fine, only when discharging; low ≤ 20%, critical ≤ 8% via the Phase H battery
  watcher). B sees "battery critical" on the member row, and missed-check-in
  escalation toasts carry the context ("their battery was critical"). FLOCK.md
  §3.5. E2e: stubbed dying battery on A → B reads it on A's row.
- [x] **Decoy/duress app view.** Shipped — **decoy over wipe** (a destructive
  wipe risks obstruction liability under a legal hold; a decoy doesn't).
  Hiding **encrypts the entire persisted state** under an unlock phrase
  (PBKDF2-600k → the backup path's AES-256-GCM envelope, key derived at
  enable time so the hide is instant, no magic bytes in the blob) and reboots
  flock as a **genuinely fresh install** — a real, working app, no identity,
  no subscriptions, so signals arriving while hidden render nothing. Covert
  gesture (1.2 s hold on the wordmark) + a discoverable You-tab card. Exit is
  the existing **Restore from backup** screen (anything as the code, the
  phrase as the passphrase) with **constant-work failure** (dummy KDF when
  nothing is hidden) so behaviour and timing can't tell a decoy from a first
  run; `lockSaves()` stops a queued signal handler resurrecting the state in
  the wipe→reload gap; reset-inside-decoy preserves the sealed blob. 8 unit
  tests (`app/src/decoy.test.ts`, incl. a no-plaintext-tell sweep) + a
  two-person e2e (hide → silent under B's buzz → genuine error on a wrong
  phrase → restore intact) + a solo e2e (decoy fully usable; reset survives).
  Design + honest limits: `docs/plans/2026-07-02-decoy-view.md`, PRIVACY.md.
  Key-at-rest hardening landed the same day — see the **App lock** (Phase E):
  with it on, the "fresh install's" localStorage holds ciphertext, and the
  decoy deliberately shows no PIN screen (a lock gate on a "brand new" app
  would be the tell).

**Explicit non-goals** (these conflict with the ethos; their absence is a
positioning decision, not an implementation gap): crash/driving detection (continuous
sensor sampling), crowdsourced area-safety maps (creates the location-linked
metadata pool we exist to avoid), professional monitoring dispatch (a
centralised, subpoenable custodian).

## Resolved inputs

- **Relay set** ✅ — adopted from `pallasite/src/credits.ts` into `app/src/relays.ts`:
  private = `relay.trotters.cc` (ours, sensitive traffic); public profile set =
  trotters/nos.lol/damus/nostr.band/primal/ditto (kind:0 reads only).
