# flock

> Experimental, non-commercial location sharing for adult friends and trusted groups.

**Status:** 🛠️ Personal, free, non-commercial proof of concept live at
**https://flock.forgesworn.dev/** for invited adult testers. **The app is
now a focused MVP** (2026-07): privacy-preserving **live location sharing with
one group of friends** — set the circle up in advance, invite by QR code, and
each member controls how closely the others see them with a **geohash precision
slider** (a whole region, e.g. Mallorca → exact spot), plus one-tap "buzz the circle" quick actions
(Check in · Come to me · Where are you? · Call me · On my way). Built on a
**shipped privacy-by-architecture foundation** (gift-wrap-everything, nsec-tree
personas/epochs, multi-circle, app lock + decoy view — see
[`docs/PRIVACY.md`](docs/PRIVACY.md)). The wider safety set (SOS/duress,
pick-me-up, geofences, dead-man's-switch, rendezvous/meeting points, off-grid,
spoken verification) is **parked post-MVP**: it lives on fully tested in the
`@forgesworn/flock` library (see the table below) but is no longer wired into
the app UI. **Delivery with the app closed now works:** the Android shell
publishes location natively (Kotlin) while the phone is locked and in deep Doze —
hardware-measured GREEN on GrapheneOS and shipped (see `docs/ROADMAP.md`). The
release **APK is the verifiable artefact**: it is reproducible from a tagged
commit and its hash is attested off-host in a signed transparency log, so a
targeted backdoored build is detectable — see
[`docs/verify-apk.md`](docs/verify-apk.md) and [`SECURITY.md`](SECURITY.md).
Start with
[`docs/VISION.md`](docs/VISION.md) (the goal — why this exists, who it's for,
the design principles that aren't up for negotiation),
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (the stack & why),
[`docs/LEGAL.md`](docs/LEGAL.md) (legal and safety notices),
[`docs/FORGESWORN-TOOLKIT.md`](docs/FORGESWORN-TOOLKIT.md) (how flock uses the
ForgeSworn freedom-tech toolset), [`docs/plans/DESIGN.md`](docs/plans/DESIGN.md),
the protocol spec [`FLOCK.md`](FLOCK.md), the tracked backlog
[`docs/ROADMAP.md`](docs/ROADMAP.md), [`llms.txt`](llms.txt) (AI-facing summary
+ exact API signatures), the runnable
[`examples/quickstart.ts`](examples/quickstart.ts), and the
[feasibility research](docs/research/2026-06-30-feasibility-research.md).

`flock` extends [`canary-kit`](https://github.com/forgesworn/canary-kit) (which itself
extends `spoken-token`) into location-aware sharing and safety tooling. The **app MVP**
serves one audience:

- **A group of adult friends** (e.g. a trip to Mallorca) who want to see roughly where each
  other are — **without handing readable movements to the service operator**. The group is set
  up in advance, people join by QR code, and each person deliberately taps **Share**.
  Sharing is visible and can be stopped with **Go private**; in the Android app a started
  share continues while the phone is locked. A per-person **precision slider** decides how
  closely the others see them (a whole region … the exact spot). Minimise tracking by design:
  encrypted end-to-end, fanned out over Nostr relays, no accounts, and no server-side
  plaintext location history. Relays and network providers can still observe metadata.

The **library** additionally retains the experimental wider safety capability set
(disclosure-on-event, geofence breach, SOS/duress, check-ins, meeting points…) for
post-MVP app phases and other ForgeSworn tools. The hosted preview is 18+ and must
not be used to track children; see [`docs/LEGAL.md`](docs/LEGAL.md).

All transport is **decentralised over Nostr**. Each device evaluates its own geofence
**locally** and only ever broadcasts **encrypted** alerts. No server holds plaintext
location.

## ⚠️ The make-or-break constraint

**No web/PWA platform can do reliable background geofencing in 2026** (high-confidence,
adversarially verified — see the research doc). The W3C Geofencing API is dead (archived
2019); the only PWA background primitive (Periodic Background Sync) is Chromium-only,
needs an installed PWA, and lets the *browser* decide if/when it fires; on iOS Safari it
doesn't work at all.

**Therefore:** the PWA delivers everything that works in the foreground (live sharing,
buzz quick actions, the map while open). **True background operation requires the
native Capacitor wrapper.** PWA-first, native-fallback — by necessity, not preference.

| Capability | iOS PWA | Android PWA | GrapheneOS | Native (Capacitor) |
|---|:--:|:--:|:--:|:--:|
| Foreground location | ✅ | ✅ | ✅ | ✅ |
| **Background location sharing** | ❌ | ❌ | ❌ | ✅ **only path** |
| Push notifications | ✅¹ | ✅ | ⚠️ UnifiedPush | ✅ |
| Live sharing + buzz (app open) | ✅ | ✅ | ✅ | ✅ |

¹ Installed PWA only (iOS 16.4+). No background location.

## Targets

iOS · Android · **GrapheneOS** (de-Googled — no Google Play Services, no FCM, no Google
geofencing APIs). De-Googled push uses **UnifiedPush** or a persistent Nostr relay socket.

> **Biggest unproven risk:** reliable background location wake-ups on **GrapheneOS without
> Google APIs** could not be confirmed by the research and **must be prototyped on a real
> device first** (Phase 0). Do not lock the architecture until this spike passes.

## Library modules (`src/`)

The library is framework-free and pure (like `canary-kit`): it builds/evaluates,
it does not own transport, persistence, or lifecycle. Geohash encoding and
encryption stay at the edge.

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
| `app/` (PWA) | **MVP UI** — onboarding, status orb, live sharing with a **precision slider** (geohash 3–9, region → exact spot; the map previews what the circle sees of you), "buzz the circle" quick actions incl. a confirmed one-shot exact **"Come to me"**, QR + remote invites, presence map, reseed/remove; decoy view under compelled unlock; app lock (state encrypted at rest behind a PIN). SOS/pick-me-up, geofences, check-ins, rendezvous/meeting, off-grid: **parked post-MVP** (library retains all of it) | ✅ MVP |
| `native/` (Capacitor) | Background location sharing + UnifiedPush — APK ships; reuses the same policy/transport. Outbound background publish (Kotlin) built — golden-vector verified both directions ([design](docs/plans/2026-07-05-native-background-publish-design.md)); hardware round-trip verification pending ([runbook](docs/runbooks/native-background-publish-test.md)) | 🧱 shell |

**Library:** `npm run build` · `npm test` · `npm run typecheck` · `npm run lint`
**PWA:** `npm run dev` (localhost) · `npm run build:app` (→ `dist-app/`) · `npm run preview:app`

The PWA is vanilla TS + Vite, fonts self-hosted (Fraunces + Hanken Grotesk — no
Google CDN), installable (manifest + service worker). It signs and publishes real
kind-20078 signals via `nostr-tools` and reads them back, decrypting beacons/
alerts with the flock library. Foreground only — background geofencing needs the
native shell (Phase 2).

## Built on canary-kit

`flock` is mostly *composition* of existing primitives, not new cryptography:

| Need | Reuse | New |
|---|---|---|
| Trusted-group lifecycle | `createGroup`, `addMember`, `removeMember`, `reseed`, kind 30078 | role tags |
| Withheld / coarse location beacon | `encryptBeacon`, `deriveBeaconKey`, `BeaconPayload {geohash, precision, timestamp}` | emission **policy** layer |
| "I need help / SOS" | `buildDuressAlert` / `encryptDuressAlert` (precision-11, scope) | UI panic trigger |
| Breach / pick-me-up | `buildSignalEvent` (kind 20078, `t`=type) | two signal types |
| Ephemeral night-out group | kind 30078 + NIP-40 `expiration` | auto-dissolve |
| Metadata-hiding transport | NIP-59 gift wrap / NIP-17, NIP-44 | wrap live beacons (proposal) |

See [`docs/plans/DESIGN.md`](docs/plans/DESIGN.md) for the full mapping and phased build.

## Deploy

Static PWA, HTTPS required, **self-hostable**, captures **no logs/data**. Canonical
host is `flock.forgesworn.dev` (Hetzner + Caddy, access logs off). The relay and
map tiles are build-time configurable (`VITE_DEFAULT_RELAY`, `VITE_TILE_URL`) so a
self-hoster points at their own. `npm run deploy` builds + rsyncs. See
[`docs/DEPLOY.md`](docs/DEPLOY.md).

## Conventions

- **British English** — colour, initialise, behaviour, licence.
- **ESM-only** — `"type": "module"`, target ES2022.
- **TDD** — failing test first, then implement.
- **Pure functions** for group/state management — return new state, never mutate.
- **Git:** `type: description` commit messages. **No `Co-Authored-By` lines.**

## Licence

[MIT](https://github.com/forgesworn/flock/blob/main/LICENSE) — consistent with the rest of the ForgeSworn toolkit.
