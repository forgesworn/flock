# flock — architecture & stack

The whole thing, and *why* each piece is what it is.

## The layered stack

```
┌─ PWA (app/) ──────────── vanilla TypeScript + Vite ─────────────────┐
│  render-on-state UI · maplibre map · self-hosted fonts              │
│  store · services · invite · map · app (controller)                │
└───────────────┬─────────────────────────────────────────────────────┘
                │ imports
┌───────────────▼─ @forgesworn/flock (src/) ── pure, tested TS lib ───┐
│  geofence · policy · signals · nightout · checkin                  │
└───────────────┬─────────────────────────────────────────────────────┘
                │ extends
┌───────────────▼─ canary-kit ────────────────────────────────────────┐
│  groups · encrypted beacons · duress · NIP-59/44 · AES envelopes   │
└───────────────┬─────────────────────────────────────────────────────┘
                │ extends
┌───────────────▼─ spoken-token ──────────────────────────────────────┐
│  HMAC-counter → words derivation (the root primitive)              │
└──────────────────────────────────────────────────────────────────────┘

transport ▶ Nostr (nostr-tools) → relay.trotters.cc   kinds 20078 / 30078 / 1059
identity  ▶ local nsec (today) → signet-login SignetSigner (planned, pluggable)
native    ▶ Capacitor shell (scaffold) → true background geofencing
host      ▶ Hetzner + Caddy → flock.forgesworn.dev (auto-TLS, no logs)
```

## What & why, layer by layer

### Cryptographic core — `spoken-token` → `canary-kit` (reused)
- **What:** group lifecycle, encrypted location beacons, duress alerts, AES-256-GCM
  envelopes (`deriveGroupKey`/`encryptEnvelope`), and the Nostr event builders +
  NIP-59 gift-wrap transport all come from `canary-kit`, which extends
  `spoken-token`'s HMAC-counter→words derivation.
- **Why:** flock = "canary-kit + location". Security-critical crypto must be
  battle-tested, not hand-rolled — **flock adds zero new crypto primitives.** It
  composes existing, audited ones (and where it needed an envelope for check-ins,
  it reused `canary-kit/sync`'s rather than writing its own).

### flock library — `@forgesworn/flock` (`src/`)
- **What:** five pure modules — `geofence` (point-in-polygon + haversine),
  `policy` (the disclosure-on-event decision), `signals` (alert/beacon builders),
  `nightout` (ephemeral groups, presence, separation), `checkin` (dead-man's-switch).
- **Why pure + framework-free:** the library *decides policy* and *builds events*;
  it never owns transport, persistence, or encoding. Geohash encoding and
  encryption stay at the edge (mirroring `canary-kit`). That makes it fully
  testable (70 tests, ~96% coverage), portable, and reusable by a native shell or
  any other consumer.
- **Tooling:** TypeScript (Node16 modules, ES2022), **vitest** (+ v8 coverage 80%
  gates), type-aware **eslint**. Matches `canary-kit`'s conventions exactly.

### Transport — Nostr
- **What:** events over relays (`relay.trotters.cc`). Kind **20078** ephemeral
  signals (beacon/breach/pickup/help/checkin), kind **30078** replaceable group +
  geofence state, kind **1059** NIP-59 gift wraps (invites/reseed), **NIP-44**
  encryption throughout, **NIP-40** expiration for ephemeral night-out groups.
- **Why:** no central server ever holds plaintext location. Each device evaluates
  its own geofence locally and broadcasts only *encrypted* alerts. Decentralised,
  self-hostable, and a fundamentally different (smaller) privacy threat surface
  than a Life360-style central database.
- **Library:** `nostr-tools` (signing, relay pool, NIP-59 / NIP-46 / NIP-19).

### Identity / signing
- **Today:** a local Nostr keypair (`nostr-tools`) in `localStorage`. Works, but
  the nsec sits in browser storage — flagged in-app, fine for preview only.
- **Planned:** `signet-login`'s **`SignetSigner`** (NIP-46 bunker / Sign-in-with-
  Signet / NIP-07 / Amber) — the key lives in the signer, **never in flock**.
  Introduced behind a **pluggable `Signer` interface** (`signEvent` + `nip44`),
  so `LocalSigner` and `SignetSigner` are interchangeable. Even gift-wrapped
  invites work: the seal's NIP-44 + signing run on the remote signer; only the
  throwaway outer-wrap key is local.
- **Why:** remote signing keeps the private key out of the app entirely — the
  correct hardening for a coercion-aware safety tool.

### App — PWA (`app/`)
- **What:** vanilla **TypeScript + Vite**, a small render-on-state controller.
- **Why vanilla (no React/Svelte):** smallest possible bundle (**~36 KB gzip**
  main; maplibre lazy-loaded only on the Map tab), instant install, no framework
  lock-in, and it matches `canary-kit`'s own app. A safety PWA must load fast on
  any phone.
- **Map:** **maplibre-gl** with OpenStreetMap tiles. Why not Google/Mapbox:
  open-source, no API-key lock-in, and the tile source is build-time configurable
  so self-hosters avoid leaking the viewport to a third party.
- **Fonts:** **Fraunces** + **Hanken Grotesk**, self-hosted via `@fontsource`.
  Why: no Google Fonts CDN — nothing phones home.
- **Bits:** `geohash-kit` (encode/decode at the edge), `qrcode-generator`
  (invite/npub QR). **PWA:** hand-rolled service worker (network-first
  navigations so updates land) + web manifest — no plugin, precise control.

### Platform reach
- **PWA** covers the *foreground* on iOS / Android / **GrapheneOS** — no app
  store, instant. But no web platform can do **background** geofencing in 2026
  (the make-or-break finding).
- **Capacitor native shell** (scaffolded) is the *only* path to true background
  breach detection. It wraps the **same** PWA and reuses the **same** flock
  policy + transport; the free `@capacitor-community/background-geolocation`
  plugin uses raw `LocationManager` (no Google APIs) so it runs on GrapheneOS.
- **De-Googled push:** UnifiedPush or a persistent relay socket (no FCM on Graphene).

### Hosting / deploy
- **flock.forgesworn.dev** on the Hetzner box behind **Caddy**
  (automatic Let's Encrypt TLS, **access logging off**).
- **Why:** own the whole stack, capture no logs/data, and stay self-hostable —
  the relay and map tiles are build-time configurable (`VITE_DEFAULT_RELAY`,
  `VITE_TILE_URL`) so anyone can run their own instance against their own infra.

## The themes that drive every choice

1. **Reuse proven crypto** — `spoken-token`/`canary-kit`, never hand-rolled.
2. **Decentralised, no central trust** — Nostr; the host/relay never sees plaintext location.
3. **Privacy by default** — disclosure-on-event, self-hosted fonts/tiles, no analytics, no logs.
4. **Own-your-stack / self-hostable** — Hetzner + Caddy, configurable relay/tiles.
5. **Lightweight & portable** — vanilla TS + Vite, tiny bundle, PWA-first, native only where it must be.
6. **Layered & pure** — spoken-token → canary-kit → flock lib → app; each lower layer pure and independently testable.
