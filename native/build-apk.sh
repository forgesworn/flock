#!/bin/sh
# Build the flock Android APK: sh native/build-apk.sh [debug|release|verify]
# (or `npm run apk` / `npm run apk:release` / `npm run apk:verify`). See native/README.md.
#
# debug   → android/app/build/outputs/apk/debug/app-debug.apk
# release → android/app/build/outputs/apk/release/flock-release.apk (signed)
# verify  → build the UNSIGNED release APK and print its sha256 — the
#           reproducibility anchor a third party compares against the published
#           hash to confirm the shipped build matches this source (never mints
#           or touches the signing key). See docs/verify-apk.md.
#
# First release run mints native/release.keystore + keystore.properties (both
# gitignored). BACK THEM UP: Android only installs updates signed by the SAME
# key — lose it and every device must uninstall/reinstall (losing local state).
set -e
cd "$(dirname "$0")/.."

MODE="${1:-debug}"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"

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
  if [ ! -f "$KS" ]; then
    PASS="$(openssl rand -hex 24)"
    "$JAVA_HOME/bin/keytool" -genkeypair -keystore "$KS" -alias flock \
      -keyalg RSA -keysize 4096 -validity 10950 \
      -storepass "$PASS" -dname "CN=flock"
    printf 'storePass=%s\n' "$PASS" > "$PROPS"
    echo "Minted native/release.keystore — back it up (updates need this exact key)." >&2
  fi
  PASS="$(sed -n 's/^storePass=//p' "$PROPS")"
  OUT=app/build/outputs/apk/release
  "$TOOLS/zipalign" -f -p 4 "$OUT/app-release-unsigned.apk" "$OUT/flock-release.apk"
  "$TOOLS/apksigner" sign --ks "$KS" --ks-key-alias flock --ks-pass "pass:$PASS" "$OUT/flock-release.apk"
  "$TOOLS/apksigner" verify "$OUT/flock-release.apk"
  echo "APK: android/$OUT/flock-release.apk"
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
