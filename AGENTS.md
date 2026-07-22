# AGENTS.md — flock

Instructions in this file apply to the entire repository.

## Project Summary
- Coercion-resistant family & friends safety and privacy-preserving location sharing.
- A thin application layer over `@forgesworn/flock` (the pure kit), `canary-kit`, and `spoken-token`, over Nostr.
- A PWA (`app/`) packaged as a Capacitor native app for locked-phone operation (Android; iOS foreground-only).
- ESM-only (`"type": "module"`), TypeScript, targeting ES2022.

## Key Commands
- `npm run dev` — Vite dev server for the PWA (`app/`)
- `npm run build` — build the PWA → `dist-app/` and enforce bundle budgets
- `npm run build:native` — build the PWA for the native (Capacitor) shell
- `npm test` — app, native-bridge, and compatibility Vitest suites
- `npm run test:e2e` — two-person Playwright e2e over the configured relay (the full suite is >10 min; target one spec with `-- e2e/<file>.spec.ts`)
- `npm run test:native` — Kotlin JVM tests for the native publish pipeline (JDK 21)
- `npm run typecheck` — strict app/native TypeScript project
- `npm run lint` — all project TypeScript/JavaScript
- `npm run gen:vectors` — regenerate native golden vectors (only on a deliberate wire-format change)
- `npm run apk` / `npm run apk:release` / `npm run apk:verify` — build/sign/verify the Android APK

## Repository Structure
- `app/` — the PWA source (the radar tracker, circle UI, decoy, App Lock, beacon pipeline)
- `native/` — the Capacitor shell: TS bridges + Kotlin (`android-src/`) for the background publisher and the locked-phone radar guide service
- `docs/` — `VISION.md`, `ARCHITECTURE.md`, `PRIVACY.md`, `ROADMAP.md`, `FORGESWORN-TOOLKIT.md`, and `plans/`
- `FLOCK.md` — protocol spec (event kinds, payloads, privacy invariants)
- `e2e/` — Playwright two-person specs; `compatibility/v1/` — golden vectors mirrored against the Kotlin port
- `dist-app/` — build output (generated); `android/` — the generated Capacitor project (generated)

## Coding Conventions
- Use British English spelling in identifiers and prose: `colour`, `behaviour`, `licence`, `metre`, `neighbour`.
- The shared logic lives in the pinned `@forgesworn/flock` kit. **Protocol/guidance changes begin in `flock-kit`**, pass its package gates, then land here as an explicit `package.json` SHA bump — do not restore a local `src/` alias or edit installed dependency files.
- **NIP-44** encryption (not deprecated NIP-04); **NIP-59** gift wraps; **NIP-40** `expiration` tag.
- Keep changes minimal and consistent with the existing module layout. Prefer TDD: add or update a failing test first.
- Maintain ESM-compatible imports/exports.

## Working Guidelines
- **No competitor/market analysis in this repository** — Git history survives a later public-visibility change, so only product requirements and Flock's own threat-model decisions belong here.
- Do not edit generated output (`dist-app/`, `android/`) or installed dependencies by hand.
- Regenerate golden vectors (`npm run gen:vectors`) only on a deliberate wire-format change, and keep the Kotlin port in parity.
- For any change that spans two people over the wire, run the relevant `test:e2e` spec before considering it done.
- Build a release APK (`npm run apk:release`) on a clean tree; every update must be signed with the one canonical key.

## Release Notes
- Conventional commit prefixes: `feat:` new features, `fix:` corrections, `refactor:` restructuring, `docs:` documentation, `chore:` tooling.
- Do NOT include `Co-Authored-By` lines in commits.
- Tests and typecheck should pass before a change is considered complete.
