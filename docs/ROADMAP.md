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

- [ ] **Signer abstraction** (`FlockSigner`: `signEvent` + `nip44`) → **signet-login** (`SignetSigner`); LocalSigner fallback. Key out of the app.
- [ ] **nsec-tree** personas + epochs — unlinkable per-circle identities; reseed = epoch+1.
- [ ] **Gift-wrap everything** via a rotating **group-inbox** key — relay sees only `kind:1059` from random keys (no real pubkeys, types, or roster).
- [~] **Relay strategy** (adopted from `pallasite/src/credits.ts` → `app/src/relays.ts`): sensitive flock traffic → our **no-log relay only** (`relay.trotters.cc`); the broad public set (`PROFILE_RELAYS`) is reserved for reading **kind:0 profiles**. Full multi-relay fan-out of sensitive traffic waits for gift-wrap-everything (spraying before then would leak metadata to public relays).

## Phase B — Group lifecycle

- [ ] **Multi-circle state** — a person in many circles at once.
- [ ] **Transient vs long-lived** — "just tonight" (NIP-40 auto-expiry) vs family (ongoing).
- [x] Create / join (in-person QR + remote gift-wrap) — *done, to be re-based on Phase A.*
- [x] Reseed / remove member — *done (hand-rolled); migrate to **dominion**.*
- [x] **Buzz** — one-tap encrypted ping to the circle with a chosen reason (preset or custom; adults can assign their own); receiver's phone **vibrates + shows a banner**; optional **targeted** buzz (parent → child). `buzz.ts` lib + Circle UI.
- [ ] **Disband / destroy a group** — owner tombstones the group (canary-kit `dissolveGroup` + replaceable-state tombstone / NIP-40 immediate expiry); members' apps drop it and wipe local keys.
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
- [ ] **LoRa mesh transport** — phone ↔ a pocket LoRa device over **BLE**, via **Meshtastic** or **MeshCore**. flock signals ride as opaque **E2E-encrypted bytes** over the LoRa mesh → works **fully off-grid** (no relay, no cell, no internet) — the ultimate "the relay can't track you". Web Bluetooth (Android/GrapheneOS Chromium) for the PWA; **Capacitor BLE** for iOS. Slots behind the same transport seam as Nostr/mesh-kit. (canary-kit already lists Meshtastic as a target.)

## Phase F — Meeting

- [ ] **rendezvous-kit** — fair pick-up / regroup point for N people.

## Phase G — Platform & release

- [ ] **Capacitor native shell** — background geofencing (scaffolded; Phase 0 spike first).
- [ ] **UnifiedPush** — de-Googled alerts.
- [ ] **anvil** — release CI (like canary-kit).

## Resolved inputs

- **Relay set** ✅ — adopted from `pallasite/src/credits.ts` into `app/src/relays.ts`:
  private = `relay.trotters.cc` (ours, sensitive traffic); public profile set =
  trotters/nos.lol/damus/nostr.band/primal/ditto (kind:0 reads only).
