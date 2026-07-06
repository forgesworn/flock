# Security policy

flock is coercion-resistant safety and privacy-preserving location-sharing
software. A security bug here is not an abstraction — it can put a real person's
location or safety at risk. We would much rather hear about a problem early and
privately than read about it later.

## Reporting a vulnerability

**Report privately — never in a public issue or pull request.** A public report of
a live weakness is itself a risk to the people relying on flock.

- **Preferred:** GitHub **private vulnerability reporting** — the repository's
  **Security** tab → **Report a vulnerability**
  (`https://github.com/forgesworn/flock/security/advisories/new`). This opens a
  private advisory visible only to the maintainers.
- **If you need an out-of-band or encrypted channel,** open a minimal private
  advisory asking for one, or reach the maintainer through the
  [ForgeSworn](https://github.com/forgesworn) organisation.

Please include what you found, how to reproduce it, the impact you believe it has,
and any suggested fix. If a report touches the coercion-resistance invariants
below, say so — those get priority.

### What matters most

The invariants in [`FLOCK.md`](FLOCK.md) §6 and [`docs/PRIVACY.md`](docs/PRIVACY.md)
are load-bearing. Reports that break any of these are the highest severity:

1. **Withholding location is observationally identical to sharing** — never a
   detectable "tell".
2. **A duress / `help` trigger looks identical to normal use** — duress vocabulary
   is generative.
3. **Beacon and duress payloads use distinct derived keys** — key material is never
   shared across domains.
4. **Geofence membership is evaluated on-device** — raw coordinates never leave the
   device except as an encrypted beacon after a triggering event.

Also in scope: any path that de-anonymises a user to a relay or host beyond what
`docs/PRIVACY.md` already documents; any way to decrypt a signal without the circle
seed; any path that publishes location the policy says to withhold; and any way to
distinguish the **decoy view** or a locked (App lock) install from a genuine fresh
install.

### Response expectation

flock is maintained by a small team — there is no 24/7 security desk. We aim to
acknowledge a report within a few days and to keep you updated as we investigate.
We will credit reporters who want credit and coordinate disclosure timing with you.

## Read the threat model first

flock's threat model is written down. Many apparent "issues" are documented,
deliberate trade-offs — please check before reporting:

- [`docs/PRIVACY.md`](docs/PRIVACY.md) — the relay / host / coercer threat model,
  and **"When a court comes knocking"** (the legal-process posture).
- [`FLOCK.md`](FLOCK.md) §6 — the wire protocol's privacy invariants.
- [`docs/verify-apk.md`](docs/verify-apk.md) — how to independently rebuild the
  release APK and confirm it matches this source.
- [`docs/transparency/`](docs/transparency/) — the off-host, signed record of every
  release (`RELEASES.jsonl` + signed `release/<build>` tags).

## Verifying what you run

The strongest supply-chain attack on a product like this is a **targeted,
backdoored build** shipped to a single user (the Lavabit / Apple–San-Bernardino
shape). flock's answer is a **reproducible APK** plus an **off-host, signed
transparency log**: rebuild the unsigned APK from a tagged commit
(`npm run apk:verify`) and confirm its hash against the signed `release/<build>`
git tag and the published anchor. Full procedure in
[`docs/verify-apk.md`](docs/verify-apk.md).

At-risk users should prefer the **APK** — a signed, reproducible binary — over the
web app, which is served from a host that can be compelled.

## Scope

In scope: this repository (the flock app and `@forgesworn/flock` library). Out of
scope: the ForgeSworn dependency kits (report those to their own repositories),
third-party Nostr relays, and the wider Nostr network.
