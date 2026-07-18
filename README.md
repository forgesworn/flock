# flock

> Experimental, non-commercial location sharing for adult friends and trusted groups.

**Status:** 🛠️ Personal, free, non-commercial proof of concept live at
**https://flock.forgesworn.dev/** for invited adult testers. The focused MVP is
privacy-preserving live location coordination for trusted circles of friends.
Set up one or more circles in advance; invite by QR, link, or six spoken words;
chat; and let each member choose how closely the others see them with a
**geohash precision slider** (a whole region, e.g. Mallorca → exact spot).
Temporary exact "Find each other" mode, lost-phone ring/find, and foreground
radar help people regroup without enabling permanent remote tracking.

The shipped privacy foundation includes per-recipient gift wrapping, nsec-tree
personas/epochs, multi-circle support, app lock, and a decoy view — see
[`docs/PRIVACY.md`](docs/PRIVACY.md). The wider safety set (SOS/duress,
pick-me-up, geofences, dead-man's-switch, rendezvous/meeting points, off-grid,
spoken verification) is **parked post-MVP**: it remains tested in the
`@forgesworn/flock` library but is not wired into the current app UI. The UI's
**Check in** quick action is a circle roll-call, not that parked
dead-man's-switch.

**Delivery with the app closed works on Android:** the shell publishes location
natively in Kotlin while the phone is locked and in deep Doze, hardware-measured
GREEN on GrapheneOS and shipped. The release **APK is the verifiable artefact**:
it is reproducible from a tagged commit and its hash is attested off-host in a
signed transparency log, so a targeted backdoored build is detectable — see
[`docs/verify-apk.md`](docs/verify-apk.md) and [`SECURITY.md`](SECURITY.md).
Start with
[`docs/VISION.md`](docs/VISION.md) (the goal — why this exists, who it's for,
the design principles that aren't up for negotiation),
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (the stack & why),
[`docs/LEGAL.md`](docs/LEGAL.md) (legal and safety notices),
[`docs/FORGESWORN-TOOLKIT.md`](docs/FORGESWORN-TOOLKIT.md) (how flock uses the
ForgeSworn freedom-tech toolset), the [original historical build plan](docs/plans/DESIGN.md),
the protocol spec [`FLOCK.md`](FLOCK.md), the tracked backlog
[`docs/ROADMAP.md`](docs/ROADMAP.md), [`llms.txt`](llms.txt) (AI-facing summary
+ exact API signatures), the runnable
[`examples/quickstart.ts`](examples/quickstart.ts), and the
[historical feasibility research](docs/research/2026-06-30-feasibility-research.md).

`flock` extends [`canary-kit`](https://github.com/forgesworn/canary-kit) (which itself
extends `spoken-token`) into location-aware sharing and safety tooling. The **app MVP**
serves one audience:

- **Adult friends** (e.g. a trip to Mallorca) who want to see roughly where each
  other are — **without handing readable movements to the service operator**. Circles are set
  up in advance, people join by QR/link/words, and each person deliberately taps **Share**.
  Sharing is visible and can be stopped with **Go private**; in the Android app a started
  share continues while the phone is locked. A per-person **precision slider** decides how
  closely the others see them (a whole region … the exact spot). Minimise tracking by design:
  encrypted end-to-end, fanned out over Nostr relays, no accounts, and no server-side
  plaintext location history. Relays and network providers can still observe metadata.

The **library** additionally retains the experimental wider safety capability set
(disclosure-on-event, geofence breach, SOS/duress, check-ins, meeting points…) for
post-MVP app phases and other ForgeSworn tools. The hosted preview is 18+ and must
not be used to track children; see [`docs/LEGAL.md`](docs/LEGAL.md).

All sensitive transport is **decentralised over Nostr** and per-recipient
gift-wrapped. Relays receive opaque outer kind-1059 events; authorised devices
unwrap the inner application signal (normally kind 20078). Each device evaluates
its own geofence locally. No Flock service or relay receives plaintext location,
although relays and network providers can still observe connection and timing metadata.

## ⚠️ The make-or-break constraint

**No web/PWA platform can do reliable background geofencing in 2026** (high-confidence,
adversarially verified — see the research doc). The W3C Geofencing API is dead (archived
2019); the only PWA background primitive (Periodic Background Sync) is Chromium-only,
needs an installed PWA, and lets the *browser* decide if/when it fires; on iOS Safari it
doesn't work at all.

**Therefore:** the PWA delivers everything that works in the foreground (live sharing,
buzz quick actions, the map while open). **True background operation requires the
native Capacitor wrapper.** PWA-first, native-fallback — by necessity, not preference.

| Capability | iOS PWA | Android/GrapheneOS PWA | Android APK |
|---|:--:|:--:|:--:|
| Live sharing, chat, buzz (app open) | ✅ | ✅ | ✅ |
| **Background location sharing** | ❌ | ❌ | ✅ hardware-verified on GrapheneOS |
| App-closed inbound Nostr alerts | ❌ | ❌ | ✅ opt-in **Stay reachable** service |
| Locked-phone radar guide | ❌ | ❌ | 🧪 built/JVM-tested; hardware pass pending |

## Targets

iOS foreground PWA · Android PWA/APK · **GrapheneOS APK** (de-Googled — no
Google Play Services, FCM, or Google geofencing APIs). The shipped Android
inbound path is an explicit foreground service with a persistent Nostr relay
socket; Flock does not currently implement UnifiedPush. Outbound locked/deep-Doze
publishing is hardware-verified on GrapheneOS. Remaining native evidence is
tracked precisely in [`docs/ROADMAP.md`](docs/ROADMAP.md), including locked-phone
radar and live Orbot-route validation.

## Shared library modules (`@forgesworn/flock`)

The canonical library source and compatibility vectors live in the private
[`forgesworn/flock-kit`](https://github.com/forgesworn/flock-kit) repository.
This app pins an immutable `flock-kit` commit and consumes its
`@forgesworn/flock` package. The library is framework-free and pure (like
`canary-kit`): it builds/evaluates, but does not own transport, persistence, or
lifecycle. Geohash encoding and encryption stay at the edge.

| Module | What it does | Status |
|---|---|:--:|
| `geofence` | On-device circle/polygon fence eval; `isBreach` (haversine + ray-casting) | ✅ tested |
| `policy` | Disclosure-on-event decision: withhold \| coarse \| full, by mode/trigger/breach | ✅ tested |
| `signals` | `beacon`/`breach`/`pickup` beacons + `help` duress alert → kind-20078 events | ✅ tested |
| `nightout` | Ephemeral groups (NIP-40), presence ("still out / gone home"), separation ("lost") | ✅ tested |
| `checkin` | Dead-man's-switch — encrypted "I'm OK" heartbeats (custom cadence, battery context); `ok`/`overdue`/`missed`, local self-reminders, "I've got this" ack + escalation | ✅ tested |
| `trail` | Pre-SOS breadcrumbs — on-device rolling buffer, disclosed (duress-keyed) only with a `help`/`breach` | ✅ tested |
| `noreport` | Inverse fences — cap disclosure over sensitive addresses (withhold \| coarse) | ✅ tested |
| `buzz` | Encrypted "look at your phone" ping with reason vocabulary | ✅ tested |
| `allclear` | Stand-down signal, with a coerced flag | ✅ tested |
| `fences` | Circle-wide safe-place sync (latest-wins, capped set) | ✅ tested |
| `rendezvous` | "Be back by / meet at" — ETA + at-risk arrival assessment | ✅ tested |
| `meeting` | Fair meeting-point request/share (midpoint computed on-device) | ✅ tested |
| `disband` | Circle dissolution signal | ✅ tested |
| `offgrid` | Deliberate "going dark" — pre-announced; never suppresses help/pickup | ✅ tested |
| `spokenverify` | Face-to-face pick-up verification words + silent duress word + candidate-risk estimate | ✅ tested |
| `joined` | Encrypted member-joined notice | ✅ tested |
| `lost` | Lost-phone flag and encrypted ring request | ✅ tested |
| `findping` | Consent-gated remote exact-ping request for a flagged-lost device | ✅ tested |
| `radar` | Distance, bearing, freshness, uncertainty, and cue decisions | ✅ tested |
| `app/` (PWA) | Multi-circle MVP: live precision control, map/chat/DMs, QR/link/word invites, temporary exact mode, lost/ring/find, foreground radar, backup/reseed/remove/disband, offline maps, Tor toggle, app lock and decoy. SOS, geofences, dead-man's-switch, rendezvous/meeting, and off-grid remain parked from the UI | ✅ MVP |
| `native/` (Capacitor) | Android APK with Kotlin background publish, opt-in Stay reachable inbound relay service, native notifications, Tor/Orbot routing, and a built locked-phone radar guide. Outbound publish is hardware-verified; radar/Orbot evidence still has explicit pending rows in the roadmap | ✅ Android; 🧪 field checks |

**App gates:** `npm run build` · `npm run test:coverage` · `npm run typecheck` · `npm run lint` · `npm run test:e2e`

**PWA:** `npm run dev` (localhost) · `npm run build:app` (→ `dist-app/`, including bundle budgets) · `npm run preview:app`

The PWA is vanilla TS + Vite, fonts self-hosted (Fraunces + Hanken Grotesk — no
Google CDN), installable (manifest + service worker). It builds inner kind-20078
signals, then encrypts and gift-wraps one outer kind-1059 event per recipient
before publishing. Recipients unwrap and decrypt locally. The web app is
foreground-only; the Android shell owns background publishing and reachability.

## Built on canary-kit

`flock` is mostly *composition* of existing primitives, not new cryptography:

| Need | Reuse | New |
|---|---|---|
| Trusted-group lifecycle | `createGroup`, `addMember`, `removeMember`, `reseed` | encrypted invite/reseed app flow; draft kind-30078 protocol state is not published publicly by the PWA |
| Withheld / coarse location beacon | `encryptBeacon`, `deriveBeaconKey`, `BeaconPayload {geohash, precision, timestamp}` | emission **policy** layer |
| "I need help / SOS" | `buildDuressAlert` / `encryptDuressAlert` (precision-11, scope) | UI panic trigger |
| Breach / pick-me-up | `buildSignalEvent` (kind 20078, `t`=type) | two signal types |
| Ephemeral night-out group | local/invite expiry; draft kind 30078 + NIP-40 protocol form | auto-dissolve |
| Metadata-hiding transport | NIP-59 gift wrap / NIP-17, NIP-44 | mandatory per-recipient wrapping for every sensitive signal |

See the [original historical build plan](docs/plans/DESIGN.md) for the initial
mapping; current delivery status lives in [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Deploy

Static PWA, HTTPS required, **self-hostable**. The canonical host is
`flock.forgesworn.dev` (Hetzner + Caddy, access logs disabled). Flock has no
central plaintext location database, but the host, relays, network providers,
and any online tile/proxy service can still process connection metadata. The
relay and map tiles are configurable so a self-hoster can point at their own;
offline saved maps avoid tile requests while in use. `npm run deploy` builds + rsyncs. See
[`docs/DEPLOY.md`](docs/DEPLOY.md).

## Conventions

- **British English** — colour, initialise, behaviour, licence.
- **ESM-only** — `"type": "module"`, target ES2022.
- **TDD** — failing test first, then implement.
- **Pure functions** for group/state management — return new state, never mutate.
- **Git:** `type: description` commit messages. **No `Co-Authored-By` lines.**

## Licence

[MIT](https://github.com/forgesworn/flock/blob/main/LICENSE) — consistent with the rest of the ForgeSworn toolkit.
