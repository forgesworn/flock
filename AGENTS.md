# AGENTS.md: flock

Coercion-resistant family and friends safety and privacy-preserving location
sharing. A thin application layer over `canary-kit` (which extends
`spoken-token`), adding disclosure-on-event location, geofencing, and ephemeral
night-out sharing over Nostr. A PWA (`app/`) packaged as a Capacitor native app
for locked-phone operation (Android; iOS is foreground-only).

**Private repo: `forgesworn/flock`.**

Detailed competitor/market comparisons must stay outside this repository even
while it is private: Git history would survive a later public-visibility
change. Only product requirements and Flock's own threat-model decisions
belong here.

## Read first

- `docs/VISION.md`: the goal, why this exists, who it's for, the
  non-negotiable design principles, and what "done" looks like.
- `README.md`: overview, module status, the make-or-break platform
  constraint.
- `docs/ARCHITECTURE.md`: the full stack and the rationale for each choice.
- `docs/FORGESWORN-TOOLKIT.md`: how flock maps onto the ForgeSworn
  freedom-tech toolset.
- `docs/PRIVACY.md`: relay threat model and privacy-by-architecture,
  including no-report zones, off-grid mode, multi-group.
- `docs/ROADMAP.md`: the tracked feature backlog (single source of truth;
  full features, no bugs).
- `FLOCK.md`: protocol spec (event kinds, payloads, privacy invariants).
- `docs/plans/DESIGN.md`: original 2026-06-30 build plan, retained as
  historical decision context; do not use it for current feature state.
- `docs/research/2026-06-30-feasibility-research.md`: the cited feasibility
  research.

## Commands

- `npm run dev`: Vite dev server for the PWA (`app/`)
- `npm run build`: build the PWA to `dist-app/` and enforce bundle budgets
- `npm run build:app`: same as `build` (alias)
- `npm run build:native`: build the PWA for the native (Capacitor) shell
- `npm run preview:app`: preview the built PWA
- `npm test`: app, native-bridge and compatibility Vitest suites
- `npm run test:coverage`: the same suites with coverage
- `npm run test:e2e`: two-person Playwright e2e over the configured relay.
  Local runs default to the production-shaped relay; CI starts a fresh
  RAM-only local relay. Use `FLOCK_E2E_RELAY=wss://…` for an explicit
  pre-deploy relay smoke pass; the full suite is over 10 minutes, so target
  one spec with `-- e2e/<file>.spec.ts`.
- `npm run test:native`: Kotlin JVM tests for the native publish pipeline
  (JDK 21, no Android SDK needed)
- `npm run typecheck`: strict app/native TypeScript project
- `npm run lint` / `npm run lint:fix`: all project TypeScript/JavaScript
- `npm run smoke`: build and exercise the pinned `@forgesworn/flock` package
  in-process; set `FLOCK_RELAY=wss://…` to also round-trip via a live relay
- `npm run gen:vectors`: regenerate the native golden vectors (only on a
  deliberate wire-format change)
- `npm run apk` / `npm run apk:release` / `npm run apk:verify`: build, sign
  and verify the Android APK (`native/build-apk.sh`)
- `npm run attest`: attest a release build
- `npm run deploy`: run `deploy/deploy.sh`

## Repository structure

### Shared library (`@forgesworn/flock`): pure, framework-free, tested

Canonical source, tests, package exports and public compatibility vectors live
in the private `forgesworn/flock-kit` repository. This app pins that
repository by full commit SHA in `package.json`; do not restore a local `src/`
alias or edit installed dependency files here. Protocol changes begin in
`flock-kit`, pass its package gates, then land here as an explicit SHA update.

- `@forgesworn/flock/geofence`: on-device circle/polygon fence evaluation
- `@forgesworn/flock/policy`: disclosure-on-event decisions
- `@forgesworn/flock/signals`: location and duress signal construction
- `@forgesworn/flock/radar`: distance, bearing, freshness and cue decisions
- `@forgesworn/flock`: the full public surface across the Flock modules
  listed in `README.md`

### PWA (`app/`): vanilla TS + Vite

- `app/src/store.ts`: identity (Nostr key), circle, persistence
  (localStorage), invite codes
- `app/src/services.ts`: Nostr publish/subscribe (`nostr-tools`),
  geolocation `watchPosition`
- `app/src/app.ts`: UI controller (render-on-state), wires the library to
  transport
- `app/src/styles.css`: the design system
- `app/public/`: manifest, service worker, icons

### Native (`native/`): Capacitor shell (Android ships)

Background geofencing on Android/GrapheneOS (no Google APIs). `npm run apk` /
`npm run apk:release` build a sideloadable APK (`native/build-apk.sh`); the
generated `android/` project is gitignored, so all native config lives in the
committed scripts (`patch-android.mjs`, `native/assets/`). The background
watcher (fix capture) and native publish mirror are tied to the sharing
toggle and torn down on reset/hide. Locked-walking and stationary deep-Doze
outbound publishing are hardware-measured green on GrapheneOS. Separate open
evidence rows remain for locked radar, live Orbot routing, and broader
inbound battery/device coverage; see `docs/ROADMAP.md`.

Background publish is native (Kotlin, `native/android-src/kotlin*`): while
the app is backgrounded the fix-policy-encrypt-gift-wrap-relay pipeline runs
without the WebView, which Android suspends (see
`docs/plans/2026-07-05-native-background-publish-design.md`). Wire-format
parity is enforced against the public golden vectors owned by `flock-kit` and
exercised by the consumer fixtures in `compatibility/v1/`, plus JVM tests
(`npm run test:native`). The pure core under `native/android-src/kotlin/`
must never import `android.*`.

### Other top-level paths

- `docs/`: `VISION.md`, `ARCHITECTURE.md`, `PRIVACY.md`, `ROADMAP.md`,
  `FORGESWORN-TOOLKIT.md`, and `plans/`
- `FLOCK.md`: protocol spec (event kinds, payloads, privacy invariants)
- `e2e/`: Playwright two-person specs
- `compatibility/v1/`: golden vectors mirrored against the Kotlin port
- `dist-app/`: build output (generated); `android/`: the generated
  Capacitor project (generated)

## Security-critical paths

Be extra careful when modifying:

- `@forgesworn/flock/policy`: the disclosure-on-event decision; a wrong
  default leaks or withholds location.
- `@forgesworn/flock/signals`: key domain separation (beacon key vs duress
  key) must hold.
- `@forgesworn/flock/geofence`: breach means outside every fence; getting
  this wrong mis-fires or misses alerts.
- `app/src/store.ts`: identity and seed handling, and the at-rest encryption
  layer (App Lock). A stray save must never clobber the ciphertext, and the
  drain's kill-switch re-checks must stay. Without the lock, localStorage is
  plaintext (the in-app note says so).
- `app/src/lock.ts` / `app/src/decoy.ts`: the App Lock (keystore-kit PIN
  wrap, grace window) and decoy sealing. The decoy must stay observationally
  identical to a fresh install, including no PIN screen and constant-work
  unlock failures.

## Privacy invariants (FLOCK.md §6)

1. Withholding location must be observationally identical to sharing: never a
   detectable "tell".
2. A `help`/duress trigger must look identical to normal use; duress
   vocabulary must be generative, never a fixed list.
3. Beacon and duress payloads use distinct derived keys: never share key
   material.
4. Geofence membership is evaluated on-device; raw coordinates never leave
   the device except as an encrypted beacon after a triggering event.

## Conventions

- British English in identifiers and prose: colour, behaviour, licence,
  metre, neighbour, initialise.
- ESM-only (`"type": "module"`), TypeScript, targeting ES2022.
- TDD: add or update a failing test first, then implement. Shared library
  modules stay pure (return new state, no mutation).
- Geohash encoding and encryption stay at the edge: the library decides
  policy and builds events; it does not encode geohashes or own transport
  (mirrors `canary-kit`).
- **NIP-44** encryption (not the deprecated NIP-04); **NIP-59** gift wraps;
  **NIP-40** `expiration` tag.
- Keep changes minimal and consistent with the existing module layout.

## Common pitfalls

- Do not restore a local `src/` alias for `@forgesworn/flock`, and do not
  edit installed dependency files. Protocol/guidance changes begin in
  `flock-kit`.
- Do not edit generated output (`dist-app/`, `android/`) by hand.
- Regenerate golden vectors (`npm run gen:vectors`) only on a deliberate
  wire-format change, and keep the Kotlin port in parity.
- For any change that spans two people over the wire, run the relevant
  `test:e2e` spec before considering it done.
- Build a release APK (`npm run apk:release`) on a clean tree; every update
  must be signed with the one canonical key.

## Verifying a change

Run `npm run typecheck`, `npm run lint` and `npm test` before considering a
change complete. For wire-format or two-device changes, also run the
relevant `test:e2e` spec.

## Commit conventions

- Conventional prefixes: `feat:` new features, `fix:` corrections,
  `refactor:` restructuring, `docs:` documentation, `chore:` tooling.
- No `Co-Authored-By` lines in commits.
