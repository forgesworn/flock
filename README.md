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

The shipped privacy foundation includes NIP-59 gift wrapping of every signal,
nsec-tree personas/epochs, multi-circle support, app lock, and a decoy view; see
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

All sensitive transport is **decentralised over Nostr** and NIP-59 gift-wrapped.
Signals for a whole circle (beacons, buzz, lost and find requests, pins and the
rest) are wrapped **once**, to the circle's shared inbox key derived from its
seed; every member derives the same key, so a sender never loops over members.
Invites, reseeds, direct messages and private location shares are wrapped once
per recipient, to that person's personal inbox. Relays receive opaque outer
kind-1059 events; authorised devices unwrap the inner application signal
(normally kind 20078). Each device evaluates its own geofence locally. No Flock service or relay receives plaintext location,
although relays and network providers can still observe connection and timing metadata.

## Quick start

Prerequisites:

- Node ≥ 24 (`engines` in `package.json`).
- An SSH key registered with GitHub. `@forgesworn/flock` (from
  [`forgesworn/flock-kit`](https://github.com/forgesworn/flock-kit)), `mesh-kit`
  and `keystore-kit` are installed over `git+ssh`, so `npm install` fails
  without it.
- JDK 21, only for `npm run test:native` (the Kotlin JVM tests; no Android SDK
  needed) and the APK build.

```sh
git clone git@github.com:forgesworn/flock.git && cd flock && npm install && npm run dev
```

Then open the localhost URL Vite prints. Before a change is done, run
`npm run typecheck`, `npm run lint` and `npm test`.

## Using the library

The library decides policy and builds **unsigned** events; the caller encodes
geohashes, signs, gift-wraps and publishes. This is the live-sharing beacon path
the app takes, end to end. Run it from a checkout after `npm install`, since the
imports resolve to this app's pinned dependencies. Replace the placeholder relay
before publishing for real. `finalizeEvent` sits inside the `Signer`: the inner
signal stays unsigned (a NIP-59 rumour) and `giftWrap` signs the seal. A circle
signal is wrapped once, to the shared circle inbox (`deriveInbox(seedHex).pk`);
do not loop over members. Only invites, reseeds, direct messages and private
shares are wrapped per recipient, to a personal inbox.

```ts
import { encode } from 'geohash-kit'
import { finalizeEvent, generateSecretKey, getPublicKey, nip44 } from 'nostr-tools'
import { deriveInbox } from '@forgesworn/covey-kit'
import { giftWrap, publishSigned, type Signer } from '@forgesworn/roost-kit'
import { decideEmission } from '@forgesworn/flock/policy'
import { buildLocationSignal, signalTypeForReason } from '@forgesworn/flock/signals'

const sk = generateSecretKey()
const signer: Signer = {
  pubkey: getPublicKey(sk),
  signEvent: async (t) => finalizeEvent({ ...t, created_at: t.created_at ?? Math.floor(Date.now() / 1000) }, sk),
  nip44Encrypt: async (peer, text) => nip44.encrypt(text, nip44.getConversationKey(sk, peer)),
  nip44Decrypt: async (peer, text) => nip44.decrypt(text, nip44.getConversationKey(sk, peer)),
}
const groupId = 'demo-circle'
const seedHex = 'a'.repeat(64) // stand-in: the real seed comes from canary-kit's createGroup
const fix = { lat: 51.5074, lon: -0.1278 }

// Night-out mode, coarse precision 6: { action: 'coarse', precision: 6, reason: 'nightout' }
const plan = decideEmission({ mode: 'nightout', position: fix, trigger: 'none' }, { coarse: 6 })
const type = signalTypeForReason(plan.reason) // 'nightout' -> 'beacon'
if (plan.action !== 'withhold' && type && type !== 'help') {
  const inner = await buildLocationSignal({
    groupId, seedHex, signalType: type,
    geohash: encode(fix.lat, fix.lon, plan.precision), precision: plan.precision, // caller encodes
  })
  // One wrap per signal, to the circle's shared inbox (every member derives the
  // same key from the seed), so there is no loop over members.
  // Unsigned inner -> signed kind 1059.
  const wrap = await giftWrap(signer, deriveInbox(seedHex).pk, inner)
  await publishSigned(['wss://relay.example'], { ...wrap }) // placeholder relay
}
```

[`examples/quickstart.ts`](examples/quickstart.ts) is a wider, offline tour of the
library modules: geofence, disclosure policy, SOS/help, a night-out group with
derived presence, and a check-in. It builds events but never signs or publishes.
Run it with `node examples/quickstart.ts` (Node ≥ 24 strips the types); after
`npm install` it needs no build step. It prints lines such as
`breached home fence: true` and
`plan: { action: 'full', precision: 9, reason: 'breach' }`. It uses the
legacy, library-only `'family'` mode for its geofence demonstration, whereas the
app always passes `'nightout'`.

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
| App-closed inbound Nostr alerts | ❌ | ❌ | ✅ **Stay reachable** service (on by default once a real identity exists; can be turned off) |
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
| `native/` (Capacitor) | Android APK with Kotlin background publish, Stay reachable inbound relay service (on by default once a real identity exists; can be turned off), native notifications, Tor/Orbot routing, and a built locked-phone radar guide. Outbound publish is hardware-verified; radar/Orbot evidence still has explicit pending rows in the roadmap | ✅ Android; 🧪 field checks |

**App gates:** `npm run build` · `npm run test:coverage` · `npm run typecheck` · `npm run lint` · `npm run test:e2e`

**PWA:** `npm run dev` (localhost) · `npm run build:app` (→ `dist-app/`, including bundle budgets) · `npm run preview:app`

The PWA is vanilla TS + Vite, fonts self-hosted (Fraunces + Hanken Grotesk — no
Google CDN), installable (manifest + service worker). It builds inner kind-20078
signals, then encrypts and gift-wraps them before publishing: one outer
kind-1059 event per circle signal, addressed to the circle's shared inbox, and
one per recipient for invites, reseeds, direct messages and private shares.
Members unwrap and decrypt locally. The web app is
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
| Metadata-hiding transport | NIP-59 gift wrap / NIP-17, NIP-44 | mandatory wrapping of every signal: one wrap to the circle's shared inbox; per-recipient wraps only for invites, reseeds, direct messages and private shares |

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
