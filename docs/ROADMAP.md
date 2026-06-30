# flock — roadmap & feature backlog

Single source of truth so we ship **full features with no bugs**. Live preview:
**https://flock.forgesworn.dev/**. Foundation rework is next (see `PRIVACY.md`).

## Cross-cutting (apply to everything)

- **Mobile-first** — phone-shaped, large touch targets, one-handed, installable PWA, offline-tolerant.
- **Uber privacy** — the relay is untrusted; minimise all metadata (see `PRIVACY.md`).
- **Full e2e tests** — Playwright covering every flow (onboarding, invite both ways, beacons, SOS/pick-up, geofence breach, check-in/miss, reseed/remove, disband, off-grid, no-report zones, multi-circle). Plus the library's vitest unit suite + the relay smoke test. **No feature is "done" without an e2e.**
- **ForgeSworn toolset** — use the real tools, don't hand-roll (see `FORGESWORN-TOOLKIT.md`).
- **geohash-kit for all geo maths** — beacons + map (✅), and migrate `geofence.ts` off hand-rolled haversine onto geohash-kit `distance` / `coverage` / `precisionToRadius`.

## Phase A — Privacy-by-architecture foundation

- [x] **Signer abstraction** (`FlockSigner`) — all event signing, NIP-44, and NIP-59 gift-wrap routed through it (signer-based gift-wrap is unit-tested).
- [x] **Sign in with Signet** (`signet-login` `SignetSigner` adapter) — key in a bunker/Signet/Amber, **never in flock**; dual local/Signet identity + session restore. *(Live login needs a real Signet signer to verify end-to-end.)*
- [x] **nsec-tree circle keys** — circle seeds derived `circleRoot → circleId → epoch` (`keys.ts`); reseed = epoch+1 (deterministic, recoverable from one root, per-circle/per-root unlinkable). Tested. Per-circle *publishing* personas still to come with gift-wrap-everything.
- [x] **Gift-wrap everything** (`giftwrap.ts`) — every signal is NIP-59 wrapped to a rotating nsec-tree group-inbox key (`deriveInbox`); the relay sees only `kind:1059` from random keys to an opaque inbox — no real pubkeys, types, or roster. Tested in-process + live (`#p` round-trip on relay.trotters.cc). **Bonus:** a wrap is self-contained opaque bytes → flock is now **transport-agnostic** (ready for the LoRa path below).
- [~] **Relay strategy** (adopted from `pallasite/src/credits.ts` → `app/src/relays.ts`): sensitive flock traffic → our **no-log relay only** (`relay.trotters.cc`); the broad public set (`PROFILE_RELAYS`) is reserved for reading **kind:0 profiles**. Full multi-relay fan-out of sensitive traffic waits for gift-wrap-everything (spraying before then would leak metadata to public relays).

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

- [ ] **No-report zones** — inverse geofences (home, a relative's): location withheld/coarsened even on a triggering event. Stored encrypted, evaluated on-device.
- [ ] **Off-grid mode** — "dark for 60/120 min"; emit nothing; pre-announce planned absence so the dead-man's-switch doesn't false-alarm; **cancellable — resume early at any time**; auto-resume when the timer ends.

## Phase D — Identity & social

- [ ] **kind:0 profiles** — fetch + display member names/avatars (not just npub).
- [ ] **canary spoken-verify** — "is this really my parent picking me up?" pick-up confirmation.
- [ ] **Trust** — `nostr-attestations` / `nostr-veil` vouching (optional).

## Phase E — Recovery & resilience

- [ ] **shamir-words** (+ **cairn-kit**) — social / coercion-resistant circle recovery.
- [ ] **stash** — encrypted-to-self vault; survive device loss.
- [ ] **keystore-kit** — secure the local-signer key at rest (when published).
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
  make it**. Tested (lib) + deployed. *Still to add: map-pick a place; live
  countdown tick; rendezvous on the map.*
- [ ] **Find a fair meeting point** — **rendezvous-kit** `findRendezvous()`:
  members' coarse locations + each one's transport mode → isochrone intersection
  → **Overpass venue search** (pub/café/park, OSM, no key) → **fairness scoring**
  (`min_max` / `min_total` / `min_variance`) → ranked suggestions. "Some in bar A,
  some in bar B → where do we all go?" The pick becomes a set rendezvous.
  Engine-agnostic — start with a no-engine radius isochrone (distance/speed),
  plug a routing engine (Valhalla/ORS/OSRM) later for road-accurate times.
  rendezvous-kit deps only on `geohash-kit` (already in flock) — clean fit, and
  flock becomes its real-world driver.

## Phase G — Platform & release

- [ ] **Capacitor native shell** — background geofencing (scaffolded; Phase 0 spike first).
- [ ] **UnifiedPush** — de-Googled alerts.
- [ ] **anvil** — release CI (like canary-kit).

## Resolved inputs

- **Relay set** ✅ — adopted from `pallasite/src/credits.ts` into `app/src/relays.ts`:
  private = `relay.trotters.cc` (ours, sensitive traffic); public profile set =
  trotters/nos.lol/damus/nostr.band/primal/ditto (kind:0 reads only).
