# Verifiable builds — defending against a compelled malicious update

**Status:** Plan · **Date:** 2026-07-06 · **Owner:** flock

## Why this exists

flock's privacy architecture (`docs/PRIVACY.md`) assumes the relay is hostile and
architects around it: a subpoena to the relay operator returns opaque ciphertext and
connection metadata, nothing more. That defends the **wire**. It does nothing for the
one order that bypasses end-to-end encryption entirely — a court compelling **us, the
software authors**, to ship a **targeted backdoored build** to a specific user.

This is the Lavabit shape (compelled to hand over the means to intercept one user) and
the Apple–San-Bernardino shape (compelled to sign a modified build). It defeats every
cryptographic property in the product because it attacks the **endpoint**, not the
transport: a build that exfiltrates the on-device plaintext location, or the circle
seed, or the App-lock PIN, needs no relay compromise at all.

We cannot make ourselves *unable* to comply — we hold the signing key and the host. What
we **can** do is make compliance **detectable**: reproducible artefacts whose bytes
anyone can independently reproduce from source, with their hashes published somewhere we
do not control. A targeted build then cannot be shipped silently — and *detectability is
the deterrent*, the same logic behind binary transparency (Chrome, Go's checksum DB) and
F-Droid's reproducible-builds programme. An order to backdoor a build that would be
visibly caught is an order far less likely to be sought or granted.

## Two surfaces, very different starting postures

| Surface | Ships from | Signed? | Hash published? | Tamper-evident to the user today? |
|---|---|---|---|---|
| **APK** (`flock-release.apk`) | `downloads/` on our host, built by `native/build-apk.sh` | Yes — single RSA-4096 key, `apksigner` | Yes — `deploy.sh` writes `flock-<build>.apk.sha256` | **Partly.** Android enforces same-key updates; a hash is published — but the hash is served by the *same host* as the APK, so a compelled host serves both a swapped APK and a matching hash. Not reproducible, so no independent check. |
| **PWA** (`dist-app/`) | rsync'd static files, served by Caddy; `sw.js` is `no-cache` | No | No | **No.** A compelled host swaps `index.html`/`sw.js`/JS chunks invisibly; the service worker fetches the new `sw.js` and the update reaches every user. This is the soft target. |

The APK already has a real integrity story to *harden*. The PWA has *none* — and by its
nature (code served fresh from a compellable host on every visit) it is the harder
problem. **Conclusion up front: steer at-risk users to the APK, and make the APK the
verifiable artefact.** The PWA gets best-effort tamper-evidence; it will never match a
signed, reproducible, out-of-band-attested binary.

## Goals / non-goals

**Goals**

- A third party can rebuild the released **APK** from a tagged commit and get the
  **identical bytes** (or an identical hash of the meaningful payload).
- The released hash is **published out-of-band** — on channels we do not control — so a
  host/APK swap is detectable without trusting our host.
- A **transparency record**: an append-only, publicly checkable log of "build X = hash H
  at commit C", so a *targeted* build (served to one user, absent from the log) stands out.
- Best-effort **PWA** tamper-evidence and a clear, honest statement of its limits.

**Non-goals**

- Making ourselves unable to comply with a lawful order (impossible while we hold the key
  — and a destructive design risks obstruction liability, per the decoy rationale).
- Reproducibility of the *debug* APK or dev PWA builds — release artefacts only.
- Replacing the signing key with a hardware-custody scheme (worth considering later; out
  of scope here).

## Plan — APK (the priority; it can actually be made verifiable)

1. **Deterministic build.** Make `native/build-apk.sh release` reproducible:
   - Pin every input version — Capacitor 8, the Gradle wrapper, the Android Gradle
     Plugin, `build-tools`, JDK 21 (already pinned to the Homebrew `openjdk@21`) — and
     record them in the build stamp.
   - Zero out build timestamps and force deterministic ordering/compression in the APK
     (`SOURCE_DATE_EPOCH`, `zipalign` already runs; add reproducible-zip flags). The
     `android/` project is generated (gitignored) but generated *deterministically* from
     committed scripts (`patch-android.mjs`, `native/assets/`) — verify that regeneration
     from a clean tree yields identical inputs.
   - Compare the **unsigned** APK (the signature block is inherently non-deterministic):
     two independent builds of the same commit must produce byte-identical
     `app-release-unsigned.apk`, or identical `apksigner`-normalised content hashes.
2. **Document the rebuild.** A `docs/verify-apk.md`: exact toolchain versions, the one
   command to rebuild, and how to diff against the published hash — written so an
   outsider with no flock context can follow it (F-Droid-style).
3. **Publish the hash out-of-band.** `deploy.sh` already emits `flock-<build>.apk.sha256`
   beside the download. Additionally publish that hash where we do **not** control the
   bytes: a signed git tag, a Nostr note from the project key, the release notes on a
   third-party forge/mirror — pick ≥2. The point is a comparison anchor off our host.
4. **Independent mirror.** Host the signed release APK on at least one channel we don't
   operate (a mirror, IPFS/CID, or a well-known third party) so "download" and "verify"
   are not both answered by the same server.
5. **Reproducible-build attestation.** Once (1) holds, have (ideally) a second party run
   the rebuild and co-sign the hash — an F-Droid-style "reproducible: ✓". This is what
   turns "we published a hash" into "someone who isn't us confirmed the hash".

## Plan — PWA (best-effort; honest about the ceiling)

A web app is code fetched from the host on every load; a compelled host is, by
construction, able to serve different bytes to different clients. We cannot fully close
this. We can raise the cost and add tamper-*evidence*:

1. **Signed build manifest.** At build time, emit a manifest of every asset's
   SHA-256, signed by the project key. Ship it; have the service worker verify each
   cached asset against it and refuse/warn on mismatch. (Stops a *partial* swap of one
   chunk, not a wholesale swap of manifest + verifier together.)
2. **Subresource Integrity** on the entry HTML for the main bundle, so a swapped JS
   chunk under an unchanged `index.html` is rejected by the browser.
3. **Pin the service worker / update transparency.** Log SW version → hash to the same
   transparency record as the APK, so a forced `sw.js` push is at least *recorded*.
4. **Publish the PWA build hash out-of-band too**, same channels as the APK, so a
   careful user *can* compare — even though most never will.
5. **Steer risk.** In the app's own security note and `get.html`, state plainly: the
   **APK is the verifiable artefact**; the PWA trades verifiability for
   zero-install reach. At-risk users (the coercion threat model) should install the APK.

## Out-of-band publication & transparency log (shared)

The single most valuable addition, cheap to start:

- An **append-only, public record**: `build → commit → APK hash → PWA hash → date`,
  signed by the project key, published on a channel we don't control (a Nostr note per
  release is a natural fit given the stack; a git tag on a mirror is a fallback).
- Because it is append-only and public, a **targeted** build — one that never appears in
  the log yet reached a user — is anomalous on its face. That is the whole mechanism:
  not prevention, **detection**.
- Pairs with the **warrant canary** proposed in `docs/PRIVACY.md` (legal-process
  section): the canary covers the gag order, the transparency log covers the silent swap.

## Honest limits

- **We can still be ordered to comply.** Reproducibility makes a *silent, targeted* build
  detectable; it does not make a *published, universal* backdoor impossible. The defence
  is deterrence-by-detectability, not immunity.
- **The PWA cannot reach APK-grade assurance.** Code served fresh from a compellable host
  is the wrong medium for strong tamper-evidence. Treat the manifest/SRI work as
  raising cost, and make the APK the artefact we stake the claim on.
- **Reproducibility is fragile.** Toolchain drift breaks byte-identity; this needs CI
  that rebuilds and diffs on every release tag, or it rots.
- **A mirror we set up is still ours.** "Independent" means genuinely third-party
  (F-Droid, a distinct operator, a content-addressed store) — a second box on our own
  account does not satisfy the threat.

## Acceptance

- [ ] Two independent release builds of the same tag produce identical APK content hashes.
- [ ] `docs/verify-apk.md` lets an outsider reproduce and diff without help.
- [ ] The release APK hash is published on ≥2 channels not served by our host.
- [ ] The signed asset manifest ships with the PWA and the SW verifies against it.
- [ ] An append-only, project-key-signed transparency record exists, one entry per release.
- [ ] `get.html` / the in-app security note states the APK-is-verifiable, PWA-is-reach
      trade-off plainly.

## Related

- `docs/PRIVACY.md` — "When a court comes knocking" (the threat this plan answers) and
  the `.onion`/Tor endpoint (the *prospective*-order defence, a separate lever).
- `native/build-apk.sh`, `deploy/deploy.sh` — the build/publish path this hardens.
- `docs/plans/2026-07-04-mesh-bridge-goal.md` Task B — Tor endpoint (complementary).
