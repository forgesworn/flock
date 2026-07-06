# Verifiable builds — defending against a compelled malicious update

**Status:** Complete except one external input — reproducibility, off-host attestation,
dependency locking and the PWA layer are **shipped** (see the completion goal,
`2026-07-06-verifiable-builds-completion-goal.md`); channel #2 publishing waits only on
the **project Nostr key** being minted (`docs/transparency/project-npub`). ·
**Date:** 2026-07-06 · **Owner:** flock

> **Measured 2026-07-06.** The unsigned release APK is byte-for-byte reproducible:
> four independent clean builds produced an identical `app-release-unsigned.apk`.
> The one non-determinism source in our control (a wall-clock build date) is fixed —
> the build stamp now derives from the commit, timezone-independent (`vite.config.ts`).
> A verifier entrypoint (`npm run apk:verify`) and the published anchor hash
> (`deploy/deploy.sh` → `flock.apk.unsigned.sha256`) ship. Procedure:
> `docs/verify-apk.md`.
>
> **Off-host transparency added 2026-07-06.** The anchor is no longer only on our
> host: an append-only, SSH-signed record now rides git. A dedicated ed25519
> release key (`native/release-signing-key`, gitignored like the keystore; `.pub`
> + `docs/transparency/allowed_signers` committed) signs a `release/<build>` tag
> whose message embeds `build → commit → unsigned/signed APK sha256`, mirrored in
> `docs/transparency/RELEASES.jsonl`. `npm run attest` mints it (local only, never
> pushes, never touches the APK key); `git verify-tag` checks it. Signing chain
> proven end-to-end (`npm run attest -- --selftest`; a rogue key is correctly
> rejected). **Remaining:** publish the first real release tag; a second off-host
> channel (project-key Nostr note); making the repo public so outsiders can see the
> tags; Gradle dependency locking; the PWA side (manifest/SRI).

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

1. **Deterministic build. ✅ DONE (measured 2026-07-06).** The unsigned release APK
   is byte-identical across four independent clean builds. The fix was removing the
   sole wall-clock input: `__FLOCK_BUILT_AT__` now derives from the committer epoch
   (`vite.config.ts`), timezone-independent, matching the already-commit-derived
   build hash. Added `npm run apk:verify` (`build-apk.sh verify` — unsigned build +
   anchor hash, never touches the key) and anchor publication in `deploy.sh`.
   The AGP 8.13 / Gradle 8.14 packaging proved deterministic as-is (zip timestamps
   already normalised) — no extra Gradle config was needed. Full detail below:
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
3. **Publish the hash out-of-band. ✅ MECHANISM DONE (2026-07-06); channels accrue.**
   `deploy.sh` emits the on-host anchor; additionally the hash is now attested in an
   append-only, SSH-signed record that rides git off our host — `scripts/attest-release.mjs`
   (`npm run attest`) appends `docs/transparency/RELEASES.jsonl` and mints a signed
   `release/<build>` tag, verifiable with `git verify-tag` against
   `docs/transparency/allowed_signers`. Chain proven (selftest passes; rogue key
   rejected). Still to do: the first *real* release tag; a Nostr note from the project
   key as the second fully-independent channel; repo made public so the tags are
   externally visible. See `docs/transparency/README.md`.
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

- [x] Two independent release builds of the same tag produce identical APK content
      hashes. **(Met 2026-07-06 — four builds, identical unsigned APK.)**
- [x] `docs/verify-apk.md` lets an outsider reproduce and diff without help.
- [~] The release APK hash is published on ≥2 channels not served by our host.
      *(On-host anchor ships via `deploy.sh`; off-host channel #1 — the SSH-signed
      `release/<build>` git tag + `RELEASES.jsonl` — ships and is verifiable.
      Channel #2 — the project-key Nostr note — is **built and wired**
      (`npm run attest:nostr`, 2026-07-06): it publishes the ledger record verbatim
      as an addressable note and refuses to run until the project publishing key is
      minted and `docs/transparency/project-npub` carries its npub. Operation waits
      only on that key.)*
- [x] The signed asset manifest ships with the PWA and the SW verifies against it.
      **(Met 2026-07-06 — the build emits `asset-manifest.json`, `deploy.sh` signs it
      with the release key (`ssh-keygen -Y sign`, namespace `flock-pwa-manifest`),
      and the SW verifies the signature + every listed asset it caches, quiet-retry
      on deploy races, persistent in-page warning on a confirmed mismatch, SRI on the
      entry HTML as the SW-independent layer. The manifest hash rides the attestation
      record, schema /2.)**
- [x] An append-only, key-signed transparency record exists, one entry per release.
      **(Mechanism met 2026-07-06 — `docs/transparency/`, signed tags, verified
      end-to-end; entries accrue per release. Key is the dedicated release key, not
      yet the Nostr project key.)**
- [x] `get.html` / the in-app security note states the APK-is-verifiable, PWA-is-reach
      trade-off plainly. **(Met 2026-07-06 — `get.html` carries the trade-off + the
      deeper off-host verify path; the in-app "This copy of flock" card, in advanced
      settings, says it per-platform.)**
- [x] *(Added by the completion goal)* Transitive dependency drift is **locked**, not
      a stated future risk — committed Gradle lockfiles enforced on every
      release/verify build; forced drift fails loudly. **(Met 2026-07-06.)**

## Related

- `docs/PRIVACY.md` — "When a court comes knocking" (the threat this plan answers) and
  the `.onion`/Tor endpoint (the *prospective*-order defence, a separate lever).
- `native/build-apk.sh`, `deploy/deploy.sh` — the build/publish path this hardens.
- `docs/plans/2026-07-04-mesh-bridge-goal.md` Task B — Tor endpoint (complementary).
