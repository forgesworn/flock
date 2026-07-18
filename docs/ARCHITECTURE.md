# flock — architecture & stack

How the shipped system is divided, what each layer owns, and where its trust
boundaries sit. Feature state is current as of 2026-07-17;
`docs/ROADMAP.md` tracks remaining hardware and product work.

## The layered stack

```
┌─ PWA (app/) ──────────── vanilla TypeScript + Vite ─────────────────┐
│  circles · map/chat · invites · precision · lost/find · radar       │
│  offline maps · lock/decoy · signer · relay transport               │
└───────────────┬─────────────────────────────────────────────────────┘
                │ imports
┌───────────────▼─ @forgesworn/flock (flock-kit) ── pure, tested TS ──┐
│  policy/fences · signals · safety state · lost/find · radar         │
└───────────────┬─────────────────────────────────────────────────────┘
                │ extends
┌───────────────▼─ canary-kit ────────────────────────────────────────┐
│  groups · encrypted beacons · duress · NIP-59/44 · AES envelopes   │
└───────────────┬─────────────────────────────────────────────────────┘
                │ extends
┌───────────────▼─ spoken-token ──────────────────────────────────────┐
│  HMAC-counter → words derivation (the root primitive)              │
└──────────────────────────────────────────────────────────────────────┘

transport ▶ Nostr relays; sensitive traffic is outer kind 1059
identity  ▶ local key or external Signet/NIP-07/Amber/NIP-46 signer
native    ▶ shipped Android: background publish, reachability, BLE, Tor, radar
host      ▶ static PWA; canonical Caddy access logging is disabled
```

## What & why, layer by layer

### Cryptographic core — `spoken-token` → `canary-kit` (reused)
- **What:** group lifecycle, encrypted location beacons, duress alerts, AES-256-GCM
  envelopes (`deriveGroupKey`/`encryptEnvelope`), and the Nostr event builders +
  NIP-59 gift-wrap transport all come from `canary-kit`, which extends
  `spoken-token`'s HMAC-counter→words derivation.
- **Why:** flock = "canary-kit + location". Flock adds no new cipher or
  key-exchange primitive. It composes the existing dependencies and reuses
  `canary-kit/sync` envelopes instead of creating a new construction. Reuse is
  not itself proof of an audit; `SECURITY.md` records the review and release
  evidence that can actually be substantiated.

### Flock library — `@forgesworn/flock` (`forgesworn/flock-kit`)
- **What:** nineteen Flock additions: location policy (`geofence`, `noreport`,
  `policy`, `signals`); group safety state (`nightout`, `checkin`, `trail`,
  `buzz`, `allclear`, `fences`, `rendezvous`, `meeting`, `disband`, `offgrid`,
  `spokenverify`); and current app support (`joined`, `lost`, `findping`, `radar`).
- **Why pure + framework-free:** the library *decides policy* and *builds events*;
  it never owns transport, persistence, or encoding. Geohash encoding and
  encryption stay at the edge (mirroring `canary-kit`). That makes it fully
  testable, portable, and reusable by a native shell or any other consumer.
- **Tooling:** TypeScript (Node16 modules, ES2022), **vitest** with enforced V8
  coverage thresholds of 80%, and type-aware **eslint** for the library. The
  full suite contains 863 tests as of 2026-07-17; command output is
  authoritative. PWA/native/scripts/e2e code is also
  linted with an appropriate non-library configuration.

### Transport — Nostr
- **What:** application semantics live in **inner** events, normally ephemeral
  kind 20078. Before publish, the app encrypts each sensitive inner event and
  creates one NIP-59 **outer kind-1059 gift wrap per recipient**. The relay sees
  the random outer author, opaque content, expiry/route tags, timing, volume, and
  connection metadata — not the inner type, location, real author, or roster.
- **Group state:** the current PWA does not publish public kind-30078 circle
  membership state. Membership and seeds travel in encrypted invite/reseed
  messages and are evaluated on-device.
- **Why:** no central server receives plaintext location. Each device evaluates
  its own geofence locally. Multi-relay delivery, rotating inbox identities,
  timing hygiene, and optional Tor reduce trust and metadata; they do not make
  connection metadata disappear.
- **Library:** `nostr-tools` (signing, relay pool, NIP-59 / NIP-46 / NIP-19).

### Identity / signing
- **Local path:** a generated Nostr keypair stored with app state. Without App
  Lock the browser profile can read local state; with App Lock the persisted
  state is encrypted behind the configured PIN.
- **External path:** the shipped `signet-login` integration supports NIP-46
  bunker/Signet, NIP-07, Amber, `bunker://`, and `nostrconnect://`. The long-term
  key stays in the signer. Even gift-wrapped invites work: NIP-44 and seal
  signing run remotely; only the disposable outer-wrap key is local.
- **Why:** remote signing keeps the private key out of the app entirely — the
  correct hardening for a coercion-aware safety tool.

### App — PWA (`app/`)
- **What:** vanilla **TypeScript + Vite**, a render-on-state controller. The
  shipped surface includes multiple circles, QR/link/six-word invites, explicit
  default-off sharing, precision control, map/chat/DMs, temporary exact mode,
  lost/ring/find, foreground radar, offline maps, Tor controls, App Lock, and
  the decoy view.
- **Why vanilla (no React/Svelte):** no framework lock-in and direct control of
  lifecycle and privacy-sensitive state. The 2026-07-17 production build
  measures about 322 KiB raw / 109 KiB gzip for the main chunk after moving the
  163 KiB external-signer stack behind its sign-in/restore actions. MapLibre is
  still material at about 1.0 MiB raw / 271 KiB gzip because it powers the
  default Home map; both main and MapLibre chunks have enforced build budgets.
- **Map:** **maplibre-gl** with OpenStreetMap tiles. Why not Google/Mapbox:
  open-source, no API-key lock-in, and the tile source is build-time configurable
  so self-hosters avoid leaking the viewport to a third party.
- **Fonts:** **Fraunces** + **Hanken Grotesk**, self-hosted via `@fontsource`.
  Why: no Google Fonts CDN — nothing phones home.
- **Bits:** `geohash-kit` (encode/decode at the edge), `qrcode-generator`
  (invite/npub QR). **PWA:** hand-rolled service worker (network-first
  navigations so updates land) + web manifest — no plugin, precise control.

### Platform reach
- **PWA:** foreground operation on iOS, Android, and GrapheneOS. Web platforms
  still cannot provide the required locked/background location execution.
- **Android APK:** the shipped `FlockLocationService` owns the background
  fix → cadence/movement policy → encryption → per-recipient gift wrap → relay
  publish path in Kotlin, independent of WebView execution. Locked walking and
  stationary deep-Doze publishing are hardware-measured green on GrapheneOS.
- **Inbound:** the opt-in **Stay reachable** foreground service keeps the relay
  path available for app-closed Nostr alerts. Flock does not currently implement
  UnifiedPush.
- **Radar/Tor:** locked-phone radar is built and JVM/vector-tested but still
  needs its real-hardware pass. The live onion route is implemented; its final
  GrapheneOS/Orbot beacon pass remains separately tracked.
- **iOS:** there is no native iOS application; iPhone is foreground PWA only.

### Hosting / deploy
- **flock.forgesworn.dev** on the Hetzner box behind **Caddy**
  (automatic Let's Encrypt TLS, **access logging off**).
- **Why:** own the stack and stay self-hostable. Flock has no central plaintext
  location database and no analytics, but “no data anywhere” would be false:
  hosts, relays, network providers, optional online map/proxy services, and each
  local device process some state or metadata. Relay and tile configuration,
  offline maps, and the onion route let an operator/user reduce those exposures.

## The themes that drive every choice

1. **Reuse established primitives** — `spoken-token`/`canary-kit`; record actual
   review evidence rather than treating dependency reuse as an audit.
2. **Decentralised, no central trust** — Nostr; the host/relay never sees plaintext location.
3. **Privacy by default** — disclosure-on-event, self-hosted fonts, offline tile
   option, no analytics, and explicit residual metadata.
4. **Own-your-stack / self-hostable** — Hetzner + Caddy, configurable relay/tiles.
5. **Portable, with measured cost** — vanilla TS + Vite, PWA-first, native only
   where it must be, and bundle size treated as a budget rather than a slogan.
6. **Layered & pure** — spoken-token → canary-kit → flock lib → app; each lower layer pure and independently testable.
