#!/bin/sh
# Build the flock Android APK: sh native/build-apk.sh [debug|release|verify|locks]
# (or `npm run apk` / `npm run apk:release` / `npm run apk:verify`). See native/README.md.
#
# debug   → android/app/build/outputs/apk/debug/app-debug.apk
# release → android/app/build/outputs/apk/release/flock-release.apk (signed)
# verify  → build the UNSIGNED release APK and print its sha256 — the
#           reproducibility anchor a third party compares against the published
#           hash to confirm the shipped build matches this source (never mints
#           or touches the signing key). See docs/verify-apk.md.
# locks   → regenerate the committed Gradle dependency lock state
#           (native/gradle-locks/**) from a real release resolution — the
#           deliberate dependency-update ritual (native/flock-locking.gradle).
#           Review the lockfile diff and commit it.
#
# release signs with native/release.keystore + keystore.properties (both gitignored,
# BACKED UP OUT-OF-BAND). Android only installs updates signed by the SAME key, so:
#   - if the keystore is MISSING, the build ERRORS (never silently mints a second key);
#   - the signed cert is checked against the pinned canonical fingerprint and aborts on
#     mismatch. Deliberately creating the first-ever key needs FLOCK_MINT_KEYSTORE=1.
# See docs/SIGNING.md.
set -e
cd "$(dirname "$0")/.."

MODE="${1:-debug}"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"

# A release/verify build without the committed lock state would silently
# resolve dependencies unlocked — exactly the drift the locks exist to catch.
# (debug and the `locks` ritual itself are exempt.)
if [ "$MODE" = "release" ] || [ "$MODE" = "verify" ]; then
  if [ ! -f native/gradle-locks/app.lockfile ]; then
    echo "✗ native/gradle-locks/ is missing or incomplete — the dependency lock state" >&2
    echo "  must be committed (regenerate deliberately: sh native/build-apk.sh locks)." >&2
    exit 1
  fi
fi

# Capacitor 8 pins a Java 21 toolchain; prefer the Homebrew JDK 21 if present.
BREW_JDK=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
[ -d "$BREW_JDK" ] && export JAVA_HOME="$BREW_JDK"

# Fresh clone: the (gitignored) native project doesn't exist yet — generate it.
[ -d android ] || npx cap add android

npm run build:native
npx cap sync android
node native/patch-android.mjs
# Launcher icons + splash (sources committed in native/assets, derived from
# app/public/icon.svg) — regenerated every build so a fresh android/ gets them.
npx @capacitor/assets generate --android --assetPath native/assets >/dev/null

cd android
if [ "$MODE" = "release" ]; then
  ./gradlew assembleRelease --console=plain -q
  BT="$(ls "$SDK/build-tools" | sort -V | tail -1)"
  TOOLS="$SDK/build-tools/$BT"
  KS=../native/release.keystore
  PROPS=../native/keystore.properties
  # The ONE canonical release cert. Every flock update MUST be signed with this key
  # (Android enforces same-key updates). Pinned here so a wrong/missing keystore fails
  # loudly instead of silently shipping an un-updatable build. See docs/SIGNING.md.
  CANONICAL_CERT="320ab5bcee9ebee33a22daa618e79d14e81f1ab80276c3dd9637efab25869877"
  if [ ! -f "$KS" ]; then
    # Never silently mint a new key — that is exactly how a second, orphaned signing
    # key gets created (an APK that can't update existing installs). Minting is a
    # deliberate, first-release-only act, gated behind FLOCK_MINT_KEYSTORE=1.
    if [ "${FLOCK_MINT_KEYSTORE:-0}" != "1" ]; then
      echo "✗ No release keystore at native/release.keystore." >&2
      echo "  Restore your backed-up native/release.keystore + native/keystore.properties" >&2
      echo "  (canonical cert SHA-256 $CANONICAL_CERT — docs/SIGNING.md) and re-run." >&2
      echo "  Deliberately creating the FIRST-EVER key (no users, or a full re-key that" >&2
      echo "  forces every device to reinstall)? Re-run: FLOCK_MINT_KEYSTORE=1 npm run apk:release" >&2
      exit 1
    fi
    PASS="$(openssl rand -hex 24)"
    "$JAVA_HOME/bin/keytool" -genkeypair -keystore "$KS" -alias flock \
      -keyalg RSA -keysize 4096 -validity 10950 \
      -storepass "$PASS" -dname "CN=flock"
    printf 'storePass=%s\n' "$PASS" > "$PROPS"
    echo "⚠ Minted a NEW native/release.keystore — BACK IT UP NOW. This key does NOT match" >&2
    echo "  existing installs; every device must uninstall/reinstall. Update CANONICAL_CERT" >&2
    echo "  (build-apk.sh) + docs/SIGNING.md to the new fingerprint below:" >&2
    "$JAVA_HOME/bin/keytool" -list -v -keystore "$KS" -alias flock -storepass "$PASS" 2>/dev/null | grep -i "SHA256:" >&2
  fi
  PASS="$(sed -n 's/^storePass=//p' "$PROPS")"
  OUT=app/build/outputs/apk/release
  "$TOOLS/zipalign" -f -p 4 "$OUT/app-release-unsigned.apk" "$OUT/flock-release.apk"
  "$TOOLS/apksigner" sign --ks "$KS" --ks-key-alias flock --ks-pass "pass:$PASS" "$OUT/flock-release.apk"
  "$TOOLS/apksigner" verify "$OUT/flock-release.apk"
  # Fail loud if this isn't the canonical production key — catches a wrong keystore
  # before it ships an un-updatable build (skipped when deliberately minting a new key).
  GOT="$("$TOOLS/apksigner" verify --print-certs "$OUT/flock-release.apk" 2>/dev/null | sed -n 's/.*certificate SHA-256 digest: //p' | head -1)"
  if [ "${FLOCK_MINT_KEYSTORE:-0}" != "1" ] && [ "$GOT" != "$CANONICAL_CERT" ]; then
    echo "✗ Signed APK cert ($GOT) ≠ canonical production key ($CANONICAL_CERT)." >&2
    echo "  Wrong keystore — this build can't update installed flocks. Aborting." >&2
    exit 1
  fi
  echo "APK: android/$OUT/flock-release.apk  (signer: ${GOT:-unknown})"
elif [ "$MODE" = "locks" ]; then
  # Regenerate the committed dependency lock state from a REAL release
  # resolution (see native/flock-locking.gradle for why not a resolve-all
  # sweep); assembleDebug rides along so dev builds are pinned too. The
  # lockFile redirection writes the per-project lock state straight into
  # native/gradle-locks/; only the root buildscript lockfile lands in the
  # generated tree and must be copied back to the committed store.
  ./gradlew assembleRelease assembleDebug --write-locks --console=plain -q
  cp buildscript-gradle.lockfile ../native/gradle-locks/buildscript-gradle.lockfile
  echo "lock state written to native/gradle-locks/ — review the diff and commit:"
  (cd .. && git status --short native/gradle-locks/)
elif [ "$MODE" = "verify" ]; then
  # Reproducibility check: build the unsigned release APK and print its hash.
  # `clean` so nothing cached masks a mismatch; no signing (a verifier holds no
  # key — the signed APK isn't independently reproducible, the unsigned one is).
  ./gradlew clean assembleRelease --console=plain -q
  OUT=app/build/outputs/apk/release
  echo "unsigned APK: android/$OUT/app-release-unsigned.apk"
  echo "reproducibility anchor (sha256):"
  shasum -a 256 "$OUT/app-release-unsigned.apk"
  echo "→ compare to the published flock-<build>-unsigned.apk.sha256 (docs/verify-apk.md)."
else
  ./gradlew assembleDebug --console=plain -q
  echo "APK: android/app/build/outputs/apk/debug/app-debug.apk"
fi
