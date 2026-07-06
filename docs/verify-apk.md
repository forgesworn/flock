# Verifying the flock Android APK is built from this source

flock's privacy rests on end-to-end encryption — but the one court order that
bypasses it entirely is a compelled **targeted, backdoored build** shipped to one
user (see `docs/PRIVACY.md`, "When a court comes knocking", and the plan in
`docs/plans/2026-07-06-verifiable-builds.md`). We cannot make ourselves unable to
comply with a lawful order. We *can* make compliance **detectable**: the release
APK is **reproducible**, so anyone can rebuild it from a tagged commit and confirm
the shipped bytes match this public source. A build that didn't match — a build
carrying something this source does not — would stand out.

This page is the procedure. It needs no flock context and no trust in us beyond the
source you are reading.

## What is verified

The **unsigned** release APK is **byte-for-byte reproducible** from a clean commit.
Measured 2026-07-06: four independent clean builds (two raw Gradle, the full
`build-apk.sh release` pipeline, and `npm run apk:verify`) produced an identical
`app-release-unsigned.apk` (sha256 `d663c61f…` for that dev tree). The build carries
no wall-clock timestamp — both the build id and the "built at" date derive from the
commit (`vite.config.ts`), so the same commit yields the same bytes whoever builds
it, whenever, in any timezone.

The **signed** APK (`flock-release.apk`, what you install) is *not* something a third
party can reproduce, because only we hold the signing key. That is expected: you
verify the *unsigned* content matches this source, then separately trust our
signature over it (Android enforces that every update is signed by the same key).

## Toolchain (the versions this was verified with)

Reproducibility is only guaranteed against the same major toolchain. Pinned by the
repo where possible (`package-lock.json`, the Gradle wrapper, `patch-android.mjs`):

| Component | Version | Pinned by |
|---|---|---|
| JDK | 21 (verified 21.0.11) | `build-apk.sh` (Homebrew `openjdk@21`) |
| Node / npm | 24 / 11 (verified 24.14.0 / 11.9.0) | — (use the same major) |
| Capacitor | 8.4.1 | `package-lock.json` |
| Android Gradle Plugin | 8.13.0 | `@capacitor/android` template |
| Gradle | 8.14.3 | `android/gradle/wrapper` |
| Kotlin Gradle plugin | 2.1.0 | `native/patch-android.mjs` |
| Android SDK | platform 36, build-tools 35.0.0 | `android/variables.gradle` |
| minSdk / compileSdk / targetSdk | 24 / 36 / 36 | `android/variables.gradle` |

## How to verify

```sh
# 1. Get the exact source for the release you want to check.
git clone https://github.com/forgesworn/flock && cd flock
git checkout <release-tag-or-commit>     # MUST match the build you're verifying
git status --porcelain                   # must be empty — a dirty tree is marked +dev

# 2. Exact dependencies, and a JDK 21.
npm ci
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home  # or your JDK 21

# 3. Build the unsigned release APK and print its hash.
npm run apk:verify
#   (on a fresh clone this first runs `npx cap add android` to generate the
#    gitignored native project from the committed scripts, then builds.)
```

The command prints:

```
reproducibility anchor (sha256):
<64-hex>  app/build/outputs/apk/release/app-release-unsigned.apk
```

## Compare against the published hash

Compare the printed hash to the released anchor, published in **two** places so a
compromised or compelled host cannot swap both the APK and its hash unnoticed:

1. **On the download host** — `https://flock.forgesworn.dev/downloads/flock.apk.unsigned.sha256`
   (emitted by `deploy/deploy.sh` alongside the APK).
2. **Off-host** — a signed git tag and/or a Nostr note from the project key
   (the append-only transparency record, per the plan doc). *This* is the copy
   that matters: it lives somewhere we do not serve, so a targeted build absent
   from it is anomalous on its face.

Match on both → the shipped release is built from this exact source. Then confirm
the APK you actually downloaded is properly signed and by the expected key:

```sh
apksigner verify --print-certs flock.apk     # exit 0; certificate SHA-256 matches the published fingerprint
```

## Known limits (stated honestly)

- **Reproducibility ≠ immunity.** It makes a *silent, targeted* build detectable.
  It does not make a *published, universal* change impossible — that is what
  reading the source and the transparency log is for.
- **Toolchain drift breaks byte-identity.** A different AGP/Gradle/JDK *major*
  version can change output. Verify with the versions above; CI should rebuild and
  diff on each release tag so a regression is caught, not discovered later.
- **Transitive dependency drift.** Direct versions are pinned; a far-future rebuild
  could still resolve different transitive artefacts. Gradle dependency locking is
  a future hardening step (plan doc).
- **The signing key is trust, not proof.** Reproducibility proves the *content*
  matches source; that the update is signed by *our* key is a separate trust
  anchor (`native/release.keystore`, backed up out-of-band, never in the repo).

## Related

- `docs/PRIVACY.md` — the threat this answers ("When a court comes knocking").
- `docs/plans/2026-07-06-verifiable-builds.md` — the full plan (PWA side, transparency log).
- `native/build-apk.sh` (`verify` mode), `deploy/deploy.sh` (publishes the anchor),
  `vite.config.ts` (commit-derived, timezone-independent build stamp).
