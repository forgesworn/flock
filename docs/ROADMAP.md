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
- [ ] **Multi-relay** — publish/subscribe across a configurable relay set (our relays); rotate. *(Awaiting the canonical relay list; default `relay.trotters.cc`.)*

## Phase B — Group lifecycle

- [ ] **Multi-circle state** — a person in many circles at once.
- [ ] **Transient vs long-lived** — "just tonight" (NIP-40 auto-expiry) vs family (ongoing).
- [x] Create / join (in-person QR + remote gift-wrap) — *done, to be re-based on Phase A.*
- [x] Reseed / remove member — *done (hand-rolled); migrate to **dominion**.*
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

## Phase F — Meeting

- [ ] **rendezvous-kit** — fair pick-up / regroup point for N people.

## Phase G — Platform & release

- [ ] **Capacitor native shell** — background geofencing (scaffolded; Phase 0 spike first).
- [ ] **UnifiedPush** — de-Googled alerts.
- [ ] **anvil** — release CI (like canary-kit).

## Open inputs needed

- **Canonical relay set** ("our relays") — only `relay.trotters.cc` confirmed; need the full list for multi-relay.
