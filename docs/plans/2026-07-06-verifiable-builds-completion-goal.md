# Verifiable builds — completing the defence (Gradle locking · PWA tamper-evidence · channel #2)

**Status:** Planned — the reproducible-APK + off-host-attestation **core is shipped**
and the **first real release is attested** (`release/dfaa8a9`, 2026-07-06). This goal
doc covers the **remaining tail** only. · **Date:** 2026-07-06 · **Owner:** flock

> This is the execution plan for the last open items of
> [`2026-07-06-verifiable-builds.md`](2026-07-06-verifiable-builds.md) (the umbrella
> plan — read it for the *why*: the compelled-backdoored-build threat, the
> detection-not-prevention logic). Nothing here re-argues that; it turns the two
> unticked acceptance boxes into concrete work.

## Where we are (done — do not redo)

- **Reproducible unsigned APK.** Byte-identical across independent clean builds; the
  build stamp derives from the commit epoch (TZ-independent). `npm run apk:verify`
  rebuilds + prints the anchor hash. Measured again this release: `dfaa8a9`'s unsigned
  APK reproduced identically ×3.
- **Off-host, signed attestation.** `npm run attest` appends
  `docs/transparency/RELEASES.jsonl` and mints an SSH-signed `release/<build>` tag
  (`build → commit → unsigned/signed APK sha256`), `git verify-tag`-checkable against
  `docs/transparency/allowed_signers`. **First real release cut & published:**
  `release/dfaa8a9`, all four channels (live APK · on-host anchor · `apk.json` ·
  off-host tag+ledger) verified to agree.
- **On-host anchor.** `deploy.sh` publishes `flock.apk.unsigned.sha256` alongside the APK.

## What's left (this doc)

Three workstreams, ordered by leverage and independence:

| | Workstream | Closes | Blocked on |
|---|---|---|---|
| **A** | Gradle dependency locking | reproducibility **drift over time** | nothing — pure config |
| **B** | PWA tamper-evidence | the **soft target** (web app) | nothing — build tooling + copy |
| **C** | Off-host channel #2 (project-key Nostr note) | single-channel transparency | the **project publishing key** (Darren) |

**Out of scope here:** the go-public flip (tracked in
[`2026-07-06-go-public-checklist.md`](2026-07-06-go-public-checklist.md) — a parallel,
maintainer-gated track); hardware/battery work; replacing the APK signing key with a
hardware-custody scheme; reproducibility of debug/dev artefacts.

---

## A. Gradle dependency locking

**Goal.** A far-future rebuild of a tagged commit resolves the **exact same transitive
dependency graph**, so the reproducibility we already measured keeps holding after
upstream repositories move. Today `docs/verify-apk.md` states this limitation honestly:
*"a far-future rebuild could still resolve different transitive artefacts."* This closes it.

**Why it matters.** Reproducibility today is a snapshot: our direct deps are pinned
(`package-lock.json`, the Gradle wrapper, `patch-android.mjs`), but Gradle still resolves
*transitive* Android/Maven artefacts at build time against version *ranges*. A resolver
change, a re-published artefact, or a new patch version silently changes bytes — and the
anchor hash we attested would no longer reproduce, weakening the whole claim.

**The design crux — `android/` is generated and gitignored.** Gradle dependency locking
writes a `gradle.lockfile` per project/configuration. But flock's `android/` project is
**generated from committed scripts** (`npx cap add android` + `patch-android.mjs`) and is
**gitignored** — so lockfiles written there vanish on regeneration. The lock state must
therefore live in a **committed** location and be **injected into the generated project**,
exactly like the existing native sources and manifest patches. This is the real work;
enabling locking itself is one line.

**Approach.**

1. **Enable locking** in the generated project via the established `patch-android.mjs`
   seam (the same mechanism that injects the Kotlin sources + manifest edits): add
   `dependencyLocking { lockAllConfigurations() }` to the root + `:app` `build.gradle`
   (and each Capacitor plugin module that resolves its own deps). Prefer an **init
   script or a single applied gradle file** injected by the patcher over hand-editing
   generated files, so the injection is idempotent and self-healing (the manifest-drift
   lesson from the FGS-type incident: "add-once" guards silently rot — make it
   re-assert on every run).
2. **Generate the lockfiles once** from a clean generate: `./gradlew :app:dependencies
   --write-locks` (widen to every module that has resolvable configurations). Capture
   the resulting `gradle.lockfile`(s).
3. **Persist them in a committed store** — e.g. `native/gradle-locks/**` mirroring the
   module layout — and have `patch-android.mjs` **copy them into `android/`** after
   `cap add`, before any Gradle invocation. Without this copy-in step the locks are lost
   on every regenerate; *this is the load-bearing part.*
4. **Prove the guard bites.** A clean generate+build resolves exactly the locked versions
   (build succeeds, bytes reproduce). Then introduce a **deliberate drift** (bump one dep)
   and confirm the build **fails** with a lock-state mismatch — a lock that never fails is
   a lock that isn't working.
5. **Document the deliberate-update ritual** (mirrors `npm run gen:vectors`): to bump a
   dependency on purpose, run `--write-locks`, copy the refreshed lockfiles back into the
   committed store, and commit — a small, reviewable diff that makes every version change
   explicit in git history.
6. **Wire into `apk:verify` / CI** so a reproducibility run now also proves the version
   pin, and lock drift is caught at build time rather than discovered at attest time.

**Optional deeper layer (note, don't necessarily do now): dependency *verification*.**
Gradle can also verify artefact **checksums/signatures** via
`gradle/verification-metadata.xml` — pinning the *bytes* of each dependency, not just its
version. Stronger (defeats a re-published-under-same-version artefact) but higher
maintenance. Locking is the targeted ask; verification is belt-and-braces worth a later
pass.

**Acceptance.**

- [ ] Lockfiles are committed (repo-tracked) and injected into the generated `android/`
      by `patch-android.mjs`; a fresh clone → `cap add` → build uses them.
- [ ] A clean rebuild resolves identical dependency versions; a forced drift **fails** the
      build with a lock mismatch.
- [ ] `docs/verify-apk.md`'s "transitive dependency drift" known-limit is updated from
      *future hardening* to *locked*.

**Risks.** Locking every configuration can surface resolution conflicts that were
previously silent (fix by aligning versions, not by loosening the lock). Plugin modules
may each need their own lockfile. Keep the injection self-healing so a Capacitor upgrade
that regenerates the project can't quietly drop the locks.

---

## B. PWA tamper-evidence

**Goal.** Raise the cost of a silent swap of the **web app** and make a partial swap
*evident*, while stating the ceiling honestly. Per the umbrella plan's conclusion: the
**APK is the verifiable artefact**; the PWA trades verifiability for zero-install reach.
This work is best-effort tamper-*evidence*, not APK-grade assurance.

**Why the PWA is the soft target.** It is code fetched fresh from a compellable host on
every visit; `sw.js` is `no-cache`, so a compelled host can serve different bytes to one
client and the service worker propagates the update. There is no signature and no
published hash today. We cannot fully close this — a host that can swap *both* the assets
*and* the verifier defeats any in-page check — but we can make anything less than a
wholesale, coordinated swap detectable, and we can steer at-risk users away from it.

**Approach (four parts, smallest-honest-win first).**

1. **Steer-to-APK copy (ship first — cheap, high-value honesty).** State plainly in
   `get.html` and the in-app security note: the **APK is the verifiable artefact**
   (reproducible + signed + off-host attested); the PWA is for reach. At-risk users (the
   coercion threat model) should install the APK and verify it (`docs/verify-apk.md`).
   This needs no build tooling and is worth landing on its own.
2. **Signed asset manifest + SW verification.** A post-build step emits
   `dist-app/asset-manifest.json` = `{ assetPath: sha256 }` for every emitted asset, plus
   a **detached signature** over it. The **service worker** carries the corresponding
   **public key** (committed, baked into the SW), fetches the manifest on
   install/activate, **verifies the signature**, then verifies each asset it caches/serves
   against the manifest hash — surfacing a **visible in-app banner** on mismatch (and
   refusing to cache the bad asset). Stops a *partial* swap (one JS chunk) under an
   otherwise-intact manifest.
3. **Subresource Integrity (SRI)** on the entry `index.html` for the main bundle(s), so a
   swapped chunk under an unchanged `index.html` is rejected by the *browser* itself
   (defence that doesn't depend on our own SW running).
4. **Record the PWA build hash off-host.** Extend the transparency record (channel #1, and
   #2 once it lands) with the signed manifest's hash, so a forced `sw.js`/asset push is at
   least *recorded* on a channel we don't serve — the same detection logic as the APK.

**Key management (decide before building part 2).** The manifest signature needs a key
whose **public** half is baked into the committed SW and whose **private** half signs at
release time. Options: (a) reuse the existing ed25519 **release-signing key**
(`native/release-signing-key`, already out-of-band custody) — fewer keys to guard; or
(b) a **dedicated PWA-manifest key**. Recommendation: reuse the release-signing key unless
there's a reason to compartmentalise; document custody either way in
`docs/transparency/README.md`.

**Honest ceiling (must be stated in the shipped copy).** The manifest and the verifying
SW are both served from the same host; a compelled operator who swaps *both together*
defeats the in-page check. SRI helps only for partial swaps under an unchanged
`index.html`, and `index.html` itself is `no-cache` and swappable. So this raises cost and
catches partial/careless tampering — it does **not** make the PWA independently
verifiable. That is *why* the APK exists as the artefact we stake the claim on.

**Acceptance.**

- [ ] `get.html` + the in-app security note carry the APK-is-verifiable / PWA-is-reach
      trade-off plainly. *(Can ship first, independently.)*
- [ ] A signed asset manifest ships with the PWA; the SW verifies cached assets against it
      and surfaces a visible mismatch.
- [ ] SRI on the entry HTML for the main bundle.
- [ ] The PWA build hash is recorded in the off-host transparency record.

**Risks.** A false-positive mismatch banner (e.g. a mid-deploy race between a new
`index.html` and old cached assets) would cry wolf — gate the check on a fully-consistent
manifest+asset set and fail *quiet-and-retry* on transient inconsistency, loud only on a
real hash mismatch. Don't let the verifier itself become a reliability regression.

---

## C. Off-host channel #2 — project-key Nostr note

**Goal.** A **second, fully independent** off-host transparency channel, so "download" and
"verify" are answered by systems that don't share a failure/compulsion domain. Channel #1
(the SSH-signed git tag + ledger) rides git/the forge; channel #2 rides **Nostr** — the
stack flock already speaks — as a **project-key note per release** embedding
`build → commit → unsigned/signed APK sha256` (and, once B lands, the PWA manifest hash).

**Blocked on (Darren).** The **project publishing key** (a stable, well-known project
Nostr identity, distinct from any user key and from the release-signing key). Until that
key exists and its npub is committed/published, this can be *built* but not *operated*.

**Approach.**

1. Define the note: an addressable/queryable kind carrying the `RELEASES.jsonl` record as
   content (or in tags), signed by the project key; published to the **no-log private
   relay(s)** (and any public mirror deemed acceptable — a *transparency* note is meant to
   be seen, unlike sensitive traffic, so the usual public-relay caution is relaxed *for
   this note only* — state that explicitly).
2. `scripts/attest-nostr.mjs` (or a `--nostr` mode on `attest-release.mjs`) publishes the
   note **after** the signed tag exists, reading the same record so the three channels are
   byte-consistent. Never blocks the core attest.
3. Verification instructions in `docs/transparency/README.md`: fetch the note by the
   committed project npub, check its signature and that its hashes equal the git tag +
   on-host anchor. Match across all three ⇒ high confidence.

**Acceptance.**

- [ ] Committed project npub + a `attest-nostr` step that publishes one signed note per
      release, reproducing the tag/ledger record.
- [ ] `docs/transparency/README.md` documents the three-channel cross-check.

---

## Sequencing

1. **A — Gradle dependency locking.** Independent, needs no keys or decisions, and directly
   hardens what shipped today. Do first.
2. **B1 — steer-to-APK copy.** Ship immediately in parallel; pure copy, high honesty value.
3. **B2–B4 — signed manifest + SRI + off-host PWA hash.** After A; decide the signing key first.
4. **C — Nostr channel #2.** When the project publishing key is available (Darren); wire it
   to publish alongside the existing attest so future releases get all three channels.

## Acceptance — rolls up to the umbrella plan

Completing this doc flips these boxes in
[`2026-07-06-verifiable-builds.md`](2026-07-06-verifiable-builds.md):

- `[ ] The release APK hash is published on ≥2 channels not served by our host` → **met**
  (channel #2 via C).
- `[ ] The signed asset manifest ships with the PWA and the SW verifies against it` → **met** (B).
- `[ ] get.html / the in-app security note states the APK-is-verifiable, PWA-is-reach
  trade-off plainly` → **met** (B1).
- New: transitive dependency drift is *locked*, not a stated future risk (A).

## Risks & honest limits (carried from the umbrella plan)

- **Detection, not immunity.** None of this makes us *unable* to comply; it makes a
  *silent, targeted* build detectable. A published, universal change is still possible —
  that is what reading the source + the transparency log is for.
- **Reproducibility rots without CI.** A/dependency-locking only stays true if a release
  job rebuilds and diffs; otherwise toolchain/lock drift is discovered late. Consider a
  release-tag CI check once the repo is public (CI is deliberately lean while private).
- **The PWA cannot reach APK-grade assurance** — by construction. Treat B as cost-raising +
  evidence, and keep the APK as the artefact the strong claim rests on.
- **"Independent" must mean genuinely third-party.** Channel #2 on Nostr is independent of
  our host and the forge; a mirror on our own account would not be.

## Related

- [`2026-07-06-verifiable-builds.md`](2026-07-06-verifiable-builds.md) — umbrella plan (the *why*).
- [`../verify-apk.md`](../verify-apk.md) — the rebuild-and-compare procedure this hardens.
- [`../transparency/README.md`](../transparency/README.md) — the off-host record; where channel #2 docs land.
- [`2026-07-06-go-public-checklist.md`](2026-07-06-go-public-checklist.md) — the parallel,
  maintainer-gated track that makes the tags externally visible.
- `native/build-apk.sh`, `native/patch-android.mjs`, `deploy/deploy.sh`, `scripts/attest-release.mjs` —
  the build/patch/publish/attest path this touches.
