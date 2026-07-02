# flock

> Coercion-resistant family & friends safety and privacy-preserving location sharing.

**Status:** 🛠️ Preview live at **https://flock.forgesworn.dev/**. The
`@forgesworn/flock` library (14 modules — see the table below) and the PWA
(onboarding, status orb, SOS/pick-me-up, map+geofences, secure invites, reseed,
dead-man's-switch) are built and tested, on a **shipped privacy-by-architecture
foundation** (gift-wrap-everything, nsec-tree personas/epochs, multi-circle —
see [`docs/PRIVACY.md`](docs/PRIVACY.md)). **Works today (foreground):** SOS /
pick-me-up, night-out sharing, check-ins, geofences on a live map, meeting
points. **Not yet:** background breach alerts with the app closed — that needs
the native shell, gated on the Phase 0 GrapheneOS spike. Start with
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (the stack & why),
[`docs/FORGESWORN-TOOLKIT.md`](docs/FORGESWORN-TOOLKIT.md) (how flock uses the
ForgeSworn freedom-tech toolset), [`docs/plans/DESIGN.md`](docs/plans/DESIGN.md),
the protocol spec [`FLOCK.md`](FLOCK.md), the tracked backlog
[`docs/ROADMAP.md`](docs/ROADMAP.md), [`llms.txt`](llms.txt) (AI-facing summary
+ exact API signatures), the runnable
[`examples/quickstart.ts`](examples/quickstart.ts), and the
[feasibility research](docs/research/2026-06-30-feasibility-research.md).

`flock` extends [`canary-kit`](https://github.com/forgesworn/canary-kit) (which itself
extends `spoken-token`) into a location-aware safety tool for two audiences:

- **Families.** Children carry a phone; guardians define optional geofenced safe areas.
  The child's location is **withheld by default** and only disclosed to guardians on a
  triggering event:
  1. leaving a safe area (geofence breach),
  2. a **"pick me up"** request, or
  3. an **"I need help / SOS"** alert.
- **Friends on a night out.** Symmetric, consent-based, **ephemeral** rough location
  sharing — "who's still at the bar / who's gone home", spotting if someone gets lost,
  time-boxed to the night via NIP-40 expiry.

All transport is **decentralised over Nostr**. Each device evaluates its own geofence
**locally** and only ever broadcasts **encrypted** alerts. No server holds plaintext
location.

## ⚠️ The make-or-break constraint

**No web/PWA platform can do reliable background geofencing in 2026** (high-confidence,
adversarially verified — see the research doc). The W3C Geofencing API is dead (archived
2019); the only PWA background primitive (Periodic Background Sync) is Chromium-only,
needs an installed PWA, and lets the *browser* decide if/when it fires; on iOS Safari it
doesn't work at all.

**Therefore:** the PWA delivers everything that works in the foreground (manual SOS /
pick-me-up, night-out sharing, live map while open). **True background breach detection
requires the native Capacitor wrapper.** PWA-first, native-fallback — by necessity, not
preference.

| Capability | iOS PWA | Android PWA | GrapheneOS | Native (Capacitor) |
|---|:--:|:--:|:--:|:--:|
| Foreground location | ✅ | ✅ | ✅ | ✅ |
| **Background geofence breach** | ❌ | ❌ | ❌ | ✅ **only path** |
| Push notifications | ✅¹ | ✅ | ⚠️ UnifiedPush | ✅ |
| Manual SOS / pick-me-up (app open) | ✅ | ✅ | ✅ | ✅ |

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
| `checkin` | Dead-man's-switch — encrypted "I'm OK" heartbeats (custom cadence); `ok`/`overdue`/`missed`, local self-reminders, "I've got this" ack + escalation | ✅ tested |
| `noreport` | Inverse fences — cap disclosure over sensitive addresses (withhold \| coarse) | ✅ tested |
| `buzz` | Encrypted "look at your phone" ping with reason vocabulary | ✅ tested |
| `allclear` | Stand-down signal, with a coerced flag | ✅ tested |
| `fences` | Circle-wide safe-place sync (latest-wins, capped set) | ✅ tested |
| `rendezvous` | "Be back by / meet at" — ETA + at-risk arrival assessment | ✅ tested |
| `meeting` | Fair meeting-point request/share (midpoint computed on-device) | ✅ tested |
| `disband` | Circle dissolution signal | ✅ tested |
| `offgrid` | Deliberate "going dark" — pre-announced; never suppresses help/pickup | ✅ tested |
| `spokenverify` | Face-to-face pick-up verification words + silent duress word | ✅ tested |
| `app/` (PWA) | Foreground UI — onboarding, status orb, SOS/pick-me-up, circle invites + presence; real Nostr publish/subscribe + geolocation | ✅ MVP |
| `native/` (Capacitor) | Background geofencing + UnifiedPush — config + bridge scaffolded, reuses the same policy/transport | 🧱 scaffold |

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
| Group lifecycle (guardians + kids / night-out crew) | `createGroup`, `addMember`, `removeMember`, `reseed`, kind 30078 | role tags |
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
