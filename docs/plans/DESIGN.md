# flock — Architecture & Build Plan

Companion to [`../research/2026-06-30-feasibility-research.md`](../research/2026-06-30-feasibility-research.md).
Read that first for the evidence behind every constraint here.

## 1. Shape

Three deliverables, layered like `canary-kit` → `spoken-token`:

```
flock (this repo)
├── @forgesworn/flock        core library — extends canary-kit
│   ├── geofence             point-in-polygon + circular (haversine) eval, on-device
│   ├── policy               location-emission policy (withheld | coarse | full)
│   ├── signals              breach / pick-me-up signal types (kind 20078)
│   ├── nightout             ephemeral coarse sharing (geo-indistinguishable, NIP-40)
│   └── (re-exports canary-kit: beacons, duress, groups, sync, nostr)
├── app/                     PWA (Vite) — foreground sharing, manual SOS/pick-me-up, map
└── native/                  Capacitor shell — background geofence + UnifiedPush
```

The core library is framework-free and pure (like `trott-sdk` / `canary-kit`): it builds
and verifies events; it does not own transport, persistence, or lifecycle.

## 2. The location-emission policy (the heart of it)

"Privacy-protected unless triggered" is **a policy, not new crypto**. Location lives in
plaintext **only on the holder's own device**. The device evaluates geofences locally and
only `encryptBeacon`-and-publishes under a policy:

| Mode | Normal behaviour | On trigger |
|---|---|---|
| **Family / child** | emit **nothing** (or an opaque heartbeat, see §5) | emit full-precision beacon on: geofence breach, pick-me-up, or help/SOS |
| **Night-out** | emit **coarse**, geo-indistinguishable beacon on a timer (NIP-40 expiry) | emit finer beacon on "I'm lost" / help |

Crucial nuance from the intimate-threats literature (research §2.1): **withholding must not
be an observable "tell".** A silent, opaque heartbeat that looks identical whether sharing
or withholding is preferable to a visible "sharing off" state. A coerced "stop" should fire
a **silent alarm**, not flip a status anyone can see.

## 3. Protocol mapping (build on canary-kit)

| flock concept | canary-kit primitive | Nostr |
|---|---|---|
| Group (family / crew) | `createGroup`, `addMember`, `removeMember`, `reseed` | kind 30078 group-state |
| Member roles | (new) `role` tag: `guardian` \| `child` \| `peer` | p-tags + label |
| Geofence set | (new) encrypted payload via AES-256-GCM | kind 30078 stored signal, `t=geofence`, replaceable |
| Withheld/coarse beacon | `BeaconPayload`, `deriveBeaconKey`, `encryptBeacon` | kind 20078 signal, `t=beacon` |
| Breach alert | `buildSignalEvent` | kind 20078, `t=breach` |
| Pick-me-up | `buildSignalEvent` | kind 20078, `t=pickup` |
| **Help / SOS** | `buildDuressAlert`, `encryptDuressAlert` (precision-11, `scope`) | kind 20078, `t=help` |
| Ephemeral night-out | kind 30078 group-state + **NIP-40 `expiration`** | auto-expire |
| Metadata hiding | **NIP-59** gift wrap + **NIP-17**, **NIP-44** | kind 1059 |

**Open design decision:** whether to migrate live beacons/alerts from the current
AES-256-GCM envelope to NIP-59 gift-wrap (hides sender + event kind from relays). The
research rates this a sound proposal (2-1) but not the shipped path. Likely worth it for
the family/coercion case; possibly overkill for consensual night-out. Decide per-mode.

## 4. Platform strategy

- **PWA (works today, everywhere):** foreground `watchPosition`, manual SOS / pick-me-up
  buttons, live map while open, night-out coarse sharing, group management. **No background
  geofencing** — that's a hard platform limit, not a gap to engineer around.
- **Capacitor native shell (only path to background breach):** free
  `capacitor-community/background-geolocation` for raw backgrounded GPS → **on-device**
  geofence evaluation (fits decentralised model). transistorsoft is the paid alternative if
  native battery-aware region monitoring proves necessary.
- **De-Googled delivery:** UnifiedPush distributor and/or a persistent Nostr relay socket
  held open by the foreground service. No FCM dependency.

## 5. Phased build

### Phase 0 — de-risk (do before committing the architecture)
- [ ] Spike: background GPS + on-device geofence wake-ups on **GrapheneOS** (no Google APIs)
      and **iOS** via Capacitor. **This is the single biggest unknown** (research refuted the
      one claim that pinned the GrapheneOS mechanism down).
- [ ] Confirm UnifiedPush delivery end-to-end on a GrapheneOS device.
- [ ] Measure battery cost of the chosen background duty-cycle.

### Phase 1 — MVP (ships on iOS/Android/Graphene with **no** background needed)
- [x] `geofence` — on-device circle/polygon fence evaluation + `isBreach` (pure, tested).
- [x] `policy` — disclosure-on-event decision (withhold | coarse | full), tested.
- [x] `signals` — `beacon`/`breach`/`pickup` beacons + `help` duress alert → kind-20078, tested.
- [x] `nightout` — ephemeral group (NIP-40), presence ("still out / gone home"), separation, tested.
- [x] PWA shell: onboarding (create/join circle), status orb, manual **SOS** (hold-to-fire) and **pick-me-up**, circle invites (QR + code), presence list.
- [x] PWA transport: real `nostr-tools` publish/subscribe of kind-20078 signals; geolocation `watchPosition`; beacon/alert decryption via the flock library.
- [ ] Polish: live map view, push/notification on incoming help, geofence editor UI.

### Phase 2 — geofencing
- [x] On-device geofence engine (point-in-polygon + circular), breach → emission policy *(library; landed early in Phase 1)*.
- [ ] Capacitor shell; background location via community plugin.
- [ ] Wire background fixes → `decideEmission` → `buildLocationSignal` → publish.
- [ ] UnifiedPush + persistent-relay alert delivery.

### Phase 3 — coercion hardening
- [ ] Silent-alarm duress, observationally identical to normal use (reuse `canary-kit` duress).
- [ ] Generative duress vocabulary (not a small memorised set).
- [ ] Liveness challenges; anti-tamper; constant-observable-behaviour guarantees.
- [ ] Decide NIP-59 gift-wrap migration for live beacons (per-mode).

## 6. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| GrapheneOS background unproven | **High** | Phase 0 spike on real device before committing |
| iOS PWA background limits force native sooner | High | Phase 0 verifies; Phase 1 needs no background anyway |
| transistorsoft paid licence | Medium | Start with free community plugin + on-device eval |
| Plugin / Capacitor version drift | Medium | Pin versions; CI build check |
| Coercion design subtleties (the "tell") | High | Treat as first-class in Phase 3; lean on cited literature |
| Child-safety legal/duty-of-care | Medium | Separate family vs night-out modes; document data flows |

## 7. Conventions

British English · ESM-only (ES2022) · TDD · pure functions for state · `type: description`
commits · no `Co-Authored-By`. Per-repo build/test commands to be added with the package
scaffold in Phase 1.
