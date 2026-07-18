# CLAUDE.md — flock

Coercion-resistant family & friends safety and privacy-preserving location
sharing. A thin application layer over `canary-kit` (which extends
`spoken-token`), adding disclosure-on-event location, geofencing, and ephemeral
night-out sharing over Nostr.

**Private repo — `forgesworn/flock`.** Owned by us; full push access.

Detailed competitor/market comparisons must stay outside this repository even
while it is private: Git history would survive a later public visibility change.
Only product requirements and Flock's own threat-model decisions belong here.

## Read first

- `docs/VISION.md` — the goal: why this exists, who it's for, the non-negotiable design principles, and what "done" looks like.
- `README.md` — overview, module status, the make-or-break platform constraint.
- `docs/ARCHITECTURE.md` — the full stack and the rationale for each choice.
- `docs/FORGESWORN-TOOLKIT.md` — how flock maps onto the ForgeSworn freedom-tech toolset (the real focus).
- `docs/PRIVACY.md` — relay threat model + privacy-by-architecture; no-report zones, off-grid mode, multi-group.
- `docs/ROADMAP.md` — the tracked feature backlog (single source of truth; full features, no bugs).
- `FLOCK.md` — protocol spec (event kinds, payloads, privacy invariants).
- `docs/plans/DESIGN.md` — original 2026-06-30 build plan, retained as
  historical decision context; do not use it for current feature state.
- `docs/research/2026-06-30-feasibility-research.md` — the cited feasibility research.

## Commands

- `npm run build` — compile the library (`src/` → `dist/`)
- `npm test` — run the complete Vitest suite
- `npm run test:e2e` — two-person Playwright e2e over the configured relay. Local
  runs default to the production-shaped relay; CI starts a fresh RAM-only local
  relay. Use `FLOCK_E2E_RELAY=wss://…` for an explicit pre-deploy relay smoke pass;
  target one spec with `-- e2e/<file>.spec.ts` (the full suite is >10 min).
- `npm run typecheck` — strict library TypeScript project
- `npm run lint` — all project TypeScript/JavaScript
- `npm run test:coverage` — complete Vitest suite + enforced 80% coverage gates
- `npm run smoke` — build + run the Nostr transport round-trip smoke test
  (in-process; set `FLOCK_RELAY=wss://…` to also round-trip via a live relay)
- `npm run dev` — Vite dev server for the PWA (`app/`)
- `npm run build:app` — build the PWA → `dist-app/`
- `npm run preview:app` — preview the built PWA
- `npm run test:native` — Kotlin JVM tests for the native publish pipeline (JDK 21)
- `npm run gen:vectors` — regenerate the native golden vectors (only on deliberate wire-format change)

## Structure

### Library (`src/`) — pure, framework-free, tested

- `geofence.ts` — on-device circle/polygon fence evaluation; `isBreach` (haversine + ray-casting)
- `policy.ts` — disclosure-on-event decision: `withhold | coarse | full` by mode/trigger/breach
- `signals.ts` — `beacon`/`breach`/`pickup` beacons + `help` duress alert → kind-20078 events
- `nightout.ts` — ephemeral groups (NIP-40), presence ("still out / gone home"), separation ("lost")
- `joined.ts` / `lost.ts` / `findping.ts` / `radar.ts` — current app support
- `index.ts` — barrel; re-exports the full `canary-kit` + `canary-kit/nostr`
  surface plus nineteen Flock additions

### PWA (`app/`) — vanilla TS + Vite

- `src/store.ts` — identity (nostr key), circle, persistence (localStorage), invite codes
- `src/services.ts` — Nostr publish/subscribe (`nostr-tools`), geolocation `watchPosition`
- `src/app.ts` — UI controller (render-on-state), wires the library to transport
- `src/styles.css` — calm dusk design system
- `public/` — manifest, service worker, icon

### Native (`native/`) — Capacitor shell (Android ships)

Background geofencing on Android/GrapheneOS (no Google APIs). `npm run apk` /
`npm run apk:release` build a sideloadable APK (`native/build-apk.sh`); the
generated `android/` project is gitignored — all native config lives in the
committed scripts (`patch-android.mjs`, `native/assets/`). The background
watcher (fix capture) and native publish mirror are tied to the sharing toggle
and torn down on reset/hide. Locked walking and stationary deep-Doze outbound
publishing are hardware-measured green on GrapheneOS. Separate open evidence
rows remain for locked radar, live Orbot routing, and broader inbound battery/
device coverage; see `docs/ROADMAP.md`.

Background publish is native (Kotlin, `native/android-src/kotlin*`): while the
app is backgrounded the fix→policy→gift-wrap→relay pipeline runs without the
WebView (which Android suspends — see docs/plans/2026-07-05-native-background-publish-design.md).
Wire-format parity is enforced by public golden vectors (`compatibility/v1/`,
`npm run gen:vectors`) and JVM tests (`npm run test:native`, JDK 21, no Android
SDK needed). The pure core under `native/android-src/kotlin/` must never import
`android.*`.

## Security-critical paths

Be extra careful when modifying:

- `src/policy.ts` — the disclosure-on-event decision; a wrong default leaks or withholds location.
- `src/signals.ts` — key domain separation (beacon key vs duress key) must hold.
- `src/geofence.ts` — breach = outside *every* fence; getting this wrong mis-fires or misses alerts.
- `app/src/store.ts` — identity + seed handling, and the **at-rest encryption layer** (App lock): a stray save must never clobber the ciphertext; the drain's kill-switch re-checks must stay. Without the lock, localStorage is plaintext (the in-app note says so).
- `app/src/lock.ts` / `app/src/decoy.ts` — the App lock (keystore-kit PIN wrap, grace window) and decoy sealing. The decoy must stay observationally identical to a fresh install — including **no PIN screen** and constant-work unlock failures.

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
- The strict TypeScript build covers the library; lint and Vitest cover the
  wider project, and the PWA (`app/`) is built by Vite.
