# CLAUDE.md — flock

Coercion-resistant family & friends safety and privacy-preserving location
sharing. A thin application layer over `canary-kit` (which extends
`spoken-token`), adding disclosure-on-event location, geofencing, and ephemeral
night-out sharing over Nostr.

**Private repo — `forgesworn/flock`.** Owned by us; full push access.

## Read first

- `README.md` — overview, module status, the make-or-break platform constraint.
- `FLOCK.md` — protocol spec (event kinds, payloads, privacy invariants).
- `docs/plans/DESIGN.md` — architecture + phased roadmap.
- `docs/research/2026-06-30-feasibility-research.md` — the cited feasibility research.

## Commands

- `npm run build` — compile the library (`src/` → `dist/`)
- `npm test` — run library tests (vitest)
- `npm run typecheck` / `npm run lint` — library type-check / lint (`src/` only)
- `npm run smoke` — build + run the Nostr transport round-trip smoke test
  (in-process; set `FLOCK_RELAY=wss://…` to also round-trip via a live relay)
- `npm run dev` — Vite dev server for the PWA (`app/`)
- `npm run build:app` — build the PWA → `dist-app/`
- `npm run preview:app` — preview the built PWA

## Structure

### Library (`src/`) — pure, framework-free, tested

- `geofence.ts` — on-device circle/polygon fence evaluation; `isBreach` (haversine + ray-casting)
- `policy.ts` — disclosure-on-event decision: `withhold | coarse | full` by mode/trigger/breach
- `signals.ts` — `beacon`/`breach`/`pickup` beacons + `help` duress alert → kind-20078 events
- `nightout.ts` — ephemeral groups (NIP-40), presence ("still out / gone home"), separation ("lost")
- `index.ts` — barrel; re-exports the full `canary-kit` + `canary-kit/nostr` surface plus flock additions

### PWA (`app/`) — vanilla TS + Vite

- `src/store.ts` — identity (nostr key), circle, persistence (localStorage), invite codes
- `src/services.ts` — Nostr publish/subscribe (`nostr-tools`), geolocation `watchPosition`
- `src/app.ts` — UI controller (render-on-state), wires the library to transport
- `src/styles.css` — calm dusk design system
- `public/` — manifest, service worker, icon

### Native (`native/`) — Capacitor shell (scaffold)

Background geofencing on iOS/Android/GrapheneOS. See `docs/plans/2026-06-30-phase0-graphene-spike.md`.

## Security-critical paths

Be extra careful when modifying:

- `src/policy.ts` — the disclosure-on-event decision; a wrong default leaks or withholds location.
- `src/signals.ts` — key domain separation (beacon key vs duress key) must hold.
- `src/geofence.ts` — breach = outside *every* fence; getting this wrong mis-fires or misses alerts.
- `app/src/store.ts` — identity + seed handling. **localStorage is NOT secure key storage** (MVP only).

## Privacy invariants (from FLOCK.md §6)

1. Withholding location must be **observationally identical** to sharing — never a detectable "tell".
2. A `help`/duress trigger must look identical to normal use; duress vocabulary must be generative.
3. Beacon and duress payloads use **distinct derived keys** — never share key material.
4. Geofence membership is evaluated **on-device**; raw coordinates never leave except as an encrypted beacon after a triggering event.

## Conventions

- **British English** — colour, initialise, behaviour, licence.
- **ESM-only** — `"type": "module"`, target ES2022.
- **TDD** — failing test first, then implement. Library modules stay pure (return new state, no mutation).
- **Geohash encoding + encryption stay at the edge** — the library decides policy and builds events; it does not encode geohashes or own transport (mirrors `canary-kit`).
- **Git:** `type: description` commits. **No `Co-Authored-By` lines.**
- Library gates (`build`/`test`/`lint`) cover `src/` only; the PWA (`app/`) is built by Vite.
