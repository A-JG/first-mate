#!/usr/bin/env bash
# Builds FirstMate.apk with the Android SDK's own tools (no Gradle, no libraries).
#   android/build.sh            -> android/build/FirstMate.apk
# Needs: Android SDK (platform 36, build-tools), a JDK with javac and keytool.
set -euo pipefail
cd "$(dirname "$0")"

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
BT="$SDK/build-tools/$(ls "$SDK/build-tools" | sort -V | tail -1)"
JAR="$SDK/platforms/$(ls "$SDK/platforms" | grep -E '^android-[0-9]+$' | sort -V | tail -1)/android.jar"
OUT=build
rm -rf "$OUT" && mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex"

# Default server address: this computer on Tailscale (editable in the app).
DEFAULT="${FIRSTMATE_SERVER:-}"
if [ -z "$DEFAULT" ] && command -v tailscale >/dev/null; then
  DEFAULT="$(tailscale ip -4 2>/dev/null | head -1):7373" || true
fi
[ "$DEFAULT" = ":7373" ] && DEFAULT=""
mkdir -p "$OUT/gen/com/firstmate/app"
cat > "$OUT/gen/com/firstmate/app/Defaults.java" <<JAVA
package com.firstmate.app;
final class Defaults {
    static final String SERVER = "$DEFAULT";
}
JAVA

echo "· resources"
"$BT/aapt2" compile --dir res -o "$OUT/res.zip"
"$BT/aapt2" link -I "$JAR" --manifest AndroidManifest.xml -o "$OUT/base.apk" \
  --java "$OUT/gen" --min-sdk-version 29 --target-sdk-version 34 --auto-add-overlay "$OUT/res.zip"

echo "· java"
javac -nowarn -Xlint:none -source 8 -target 8 -encoding UTF-8 -bootclasspath "$JAR:$BT/core-lambda-stubs.jar" -d "$OUT/classes" \
  $(find src "$OUT/gen" -name '*.java') 2>&1 | grep -v "bootstrap class path\|source value 8\|target value 8\|To suppress warnings\|^warning: \[options\]\|^4 warnings\|^3 warnings" || true
[ -f "$OUT/classes/com/firstmate/app/RadioService.class" ] || { echo "javac failed"; exit 1; }

echo "· dex"
"$BT/d8" --min-api 29 --lib "$JAR" --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')
(cd "$OUT/dex" && zip -q -j ../base.apk classes.dex)

echo "· sign"
KS=firstmate.keystore
if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -storepass firstmate -keypass firstmate -alias firstmate \
    -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=First Mate" >/dev/null 2>&1
fi
"$BT/zipalign" -f -p 4 "$OUT/base.apk" "$OUT/aligned.apk"
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:firstmate --key-pass pass:firstmate --out "$OUT/FirstMate.apk" "$OUT/aligned.apk"
"$BT/apksigner" verify "$OUT/FirstMate.apk"
echo "Built $(pwd)/$OUT/FirstMate.apk  ($(du -h "$OUT/FirstMate.apk" | cut -f1); default server: ${DEFAULT:-none})"
