# Dark Prague (HCPP, 2–4 Oct 2026) — flock table demo plan

Audience: people whose profession is metadata privacy (Nym, DarkFi, Nostr devs).
The demo must survive adversarial prodding. Rule from the gopherkind talk prep:
state the limits first, unprompted; never claim "private" without the threat
model in the same breath.

## The demo script (what we show, in order)

1. **Two phones, one circle.** Invite by QR/link and by six spoken words —
   the e2e suite (`invite.spec.ts`) proves both paths over the live relay.
2. **Precision slider.** Same person, region → neighbourhood → exact; the map
   shows exactly what the circle sees. "Go private" stops it visibly.
3. **Lost-phone ring/find** from the other phone (consent-gated exact ping).
4. **The kicker: verify the APK.** On the table laptop: `git verify-tag
   release/<build>` against `docs/transparency/allowed_signers`, then the
   on-host anchor + ledger agreement, then `apksigner verify --print-certs`
   against the canonical cert in `docs/SIGNING.md`. "A compelled, targeted
   build would stand out" — detection, not prevention. Say exactly that.
5. **GrapheneOS, no Google anything.** Background publish while locked is
   hardware-measured GREEN — the receipt is in `docs/ROADMAP.md`.

## Fenced OUT of the demo (pending evidence — do not improvise these live)

- **Locked-phone radar guide** — built, JVM/golden-vector tested, hardware pass
  PENDING (Pixel 10 Pro). Foreground radar only.
- **Live Orbot/Tor routing** — toggle ships, onion relay list empty until the
  onion service runbook lands; emulated pass showed ANRs. Say "Tor routing is
  wired, live-route validation is an open row", don't demo it.
- **Radar v2 field acceptance** (car/walking) — human pass pending.

## Must close BEFORE travel

- [ ] **Attest the live build.** `downloads/flock.apk` is build `7363e51` with
  NO signed tag / ledger line (found 2026-08-08; content verified honest by
  clean rebuild — every dex/resource byte-identical). Without the tag, demo
  step 4 fails at `git verify-tag`. Needs the release-signing key from the
  out-of-band backup: rebuild + `npm run attest` for `7363e51`, or cut and
  attest a fresh release from main. Tracked in ROADMAP Phase G.
- [ ] Rehearse the full script twice on the actual demo phones, once on
  conference-grade congested wifi.
- [ ] Charge + update both demo phones; the APK already bundles
  `prague.pmtiles` (offline Prague map) — confirm it renders with wifi off.
- [ ] Printed card for the table: relay metadata caveat (relays and network
  providers see connection/timing metadata — `docs/PRIVACY.md`), PWA is
  foreground-only by platform limitation, at-risk users should prefer the APK
  over the hosted web app.

## Table infrastructure

- Demo must not depend on venue wifi: both phones pre-joined to the circle,
  offline Prague map bundled, relay reachable over mobile data as fallback.
- Laptop charged with the repo cloned and tags fetched (`git fetch --tags`) so
  `git verify-tag` works offline-ish (needs only the clone).

## Status log

- 2026-08-08: gates green on main (typecheck, lint, 400 Vitest, Kotlin JVM,
  bundle budgets, smoke incl. live relay round-trip). Demo-core e2e green:
  invite/share/precision/radar/lost-phone/make-it-ring/find-my-phone (fixed a
  strict-mode selector break in invite.spec.ts — posture badge vs tab). `tar`
  critical CVEs pinned out via root override; seven no-fix findings remain in
  icon-generation tooling only (SECURITY.md). Live-APK content verified == source
  at `7363e51`; attestation gap recorded above.
