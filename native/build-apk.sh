#!/bin/sh
# Build the flock Android APK: sh native/build-apk.sh [debug|release]
# (or `npm run apk` / `npm run apk:release`). See native/README.md.
#
# debug   → android/app/build/outputs/apk/debug/app-debug.apk
# release → android/app/build/outputs/apk/release/flock-release.apk (signed)
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
else
  ./gradlew assembleDebug --console=plain -q
  echo "APK: android/app/build/outputs/apk/debug/app-debug.apk"
fi
