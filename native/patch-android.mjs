// Idempotently apply flock's Android config to the GENERATED (gitignored)
// Capacitor project — run after `npx cap add android` / as part of `npm run apk`.
// Keeping this as a committed script means a fresh clone reproduces the exact
// native config instead of relying on hand-edits to generated files.
//
// What it enforces (and why):
//  - Location + foreground-service permissions: the background watcher is a
//    foreground service on the platform LocationManager (no Google APIs — the
//    GrapheneOS-compatible mechanism). POST_NOTIFICATIONS is its Android 13+
//    notification permission; the WebView's foreground navigator.geolocation
//    needs FINE/COARSE declared to prompt at runtime.
//  - allowBackup=false: with the app lock off, localStorage is plaintext
//    (identity keys, circle seeds) — it must not be extractable via adb or
//    cloud backup.
//  - App Links intent filter: a scanned/tapped https://flock.forgesworn.dev
//    invite opens the APP (not the browser) on phones that have it, so the
//    joiner lands in the install with background watch — not a second identity
//    in the browser. autoVerify checks the site's /.well-known/assetlinks.json
//    (shipped in app/public, so every deploy serves it) against the APK's
//    signing cert; native/deeplink.ts feeds the arriving URL to the app.
import { readFileSync, writeFileSync, copyFileSync, cpSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const manifestPath = resolve(here, '../android/app/src/main/AndroidManifest.xml')

// The location-free "stay reachable" foreground service + its Capacitor plugin
// live as committed Java templates (native/android-src/*.java — NOT native/android/,
// which the `android/` gitignore rule would swallow) copied into the generated
// package so a fresh clone reproduces them. MainActivity is replaced to register
// the app-local plugin (npm plugins auto-register; this one can't).
const JAVA_SRC = resolve(here, 'android-src')
const JAVA_DEST = resolve(here, '../android/app/src/main/java/cc/trotters/flock')
for (const f of ['StayReachableService.java', 'StayReachablePlugin.java', 'FlockNotifyPlugin.java', 'FlockOrbotPlugin.java', 'MainActivity.java']) {
  copyFileSync(resolve(JAVA_SRC, f), resolve(JAVA_DEST, f))
}
const retiredBlePlugin = resolve(JAVA_DEST, 'FlockBlePlugin.java')
if (existsSync(retiredBlePlugin)) unlinkSync(retiredBlePlugin)
console.error('copied stay-reachable native sources into android/')

// Kotlin sources: the pure publish core (shared with native/crypto-tests) and
// the Android glue. cpSync replaces per-file copies — the trees are nested.
cpSync(resolve(here, 'android-src/kotlin/cc'), resolve(here, '../android/app/src/main/java/cc'), { recursive: true })
cpSync(resolve(here, 'android-src/kotlin-android/cc'), resolve(here, '../android/app/src/main/java/cc'), { recursive: true })
console.error('copied Kotlin publish pipeline into android/')

const PERMISSIONS = [
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_LOCATION',
  // specialUse foreground-service type for the location-free "stay reachable"
  // service (Android 14+ requires a declared type; specialUse avoids the ~6h/day
  // cap Android 15+ puts on dataSync — see StayReachableService.java).
  'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
  // Lets flock ask to be exempt from Doze battery optimisation — without it an
  // aggressive OEM (Samsung) freezes the stay-reachable service overnight.
  'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
  'android.permission.POST_NOTIFICATIONS',
  // "Make it ring" (FlockNotifyPlugin.ring): a lost phone plays a targeted buzz
  // as a loud alarm. USE_FULL_SCREEN_INTENT wakes the screen; ACCESS_NOTIFICATION_
  // POLICY lets the alarm channel bypass Do Not Disturb (best-effort — the user
  // must still grant DND access). Both degrade gracefully if absent/ungranted:
  // the alarm still sounds on the alarm audio stream, through ring-silent.
  'android.permission.USE_FULL_SCREEN_INTENT',
  'android.permission.ACCESS_NOTIFICATION_POLICY',
  // Radar guide haptics (RadarGuideService) — and it lets the WebView's own
  // navigator.vibrate work too. Normal install-time permission, no prompt.
  'android.permission.VIBRATE',
  // RadarGuideService holds a short capped partial wakelock so the beep
  // scheduler + compass stay honest with the screen off.
  'android.permission.WAKE_LOCK',
  // The in-app QR join scanner (app/src/qrscan.ts) calls getUserMedia inside the
  // WebView. Capacitor's BridgeWebChromeClient.onPermissionRequest maps a WebView
  // VIDEO_CAPTURE request to a runtime android.permission.CAMERA request — but
  // Android auto-DENIES a runtime request for a permission the manifest never
  // declares (no dialog shown), so getUserMedia rejects and the scanner shows
  // "Camera unavailable" on every Android build (measured on a Galaxy A32,
  // 2026-07-20). Declaring CAMERA lets the runtime prompt actually appear.
  'android.permission.CAMERA',
]

let xml = readFileSync(manifestPath, 'utf8')
let changed = false

for (const p of PERMISSIONS) {
  if (!xml.includes(`"${p}"`)) {
    xml = xml.replace('</manifest>', `    <uses-permission android:name="${p}" />\n</manifest>`)
    changed = true
  }
}

// Declaring CAMERA implies a hard camera requirement for Play-style filtering;
// pin it required="false" so a camera-less device can still install (the QR
// scanner just falls back to the six-word code) — mirrors the bluetooth_le
// uses-feature the mesh-ble plugin contributes.
if (!xml.includes('android.hardware.camera"')) {
  xml = xml.replace('</manifest>', '    <uses-feature android:name="android.hardware.camera" android:required="false" />\n</manifest>')
  changed = true
}

// capacitor-mesh-ble declares ACCESS_FINE_LOCATION with maxSdkVersion="30"
// (correct for a BLE library — API 31+ scans use BLUETOOTH_SCAN instead), but
// the manifest merger grafts that cap onto OUR declaration too, so on Android
// 12+ the APK stops requesting FINE at all. Coarse-only means every fix is
// fuzzed ~2 km and throttled to one per 10 minutes — and on GrapheneOS with
// network location off, no fixes at all (the "Looking for you…" card, measured
// on-device 2026-07-20). tools:node="replace" makes the app's unrestricted
// declaration win outright.
if (!xml.includes('xmlns:tools=')) {
  xml = xml.replace(/(<manifest\b)/, '$1 xmlns:tools="http://schemas.android.com/tools"')
  changed = true
}
const fineRe = /<uses-permission android:name="android\.permission\.ACCESS_FINE_LOCATION"[^>]*\/>/
const FINE_DECL = '<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" tools:node="replace" />'
if (!xml.includes(FINE_DECL)) {
  xml = xml.replace(fineRe, FINE_DECL)
  changed = true
}

if (xml.includes('android:allowBackup="true"')) {
  xml = xml.replace('android:allowBackup="true"', 'android:allowBackup="false"')
  changed = true
}

// Cleartext policy for the Tor route. The relay's v3 `.onion` twin is reached
// as plain ws:// BY DESIGN — Tor's rendezvous encryption is the transport
// security, and no CA issues `.onion` certs we could pin instead. Android's
// API-28+ default (cleartext blocked everywhere) is kept for ALL other hosts:
// this network-security-config carves out `.onion` names only, so no clearnet
// connection can silently downgrade. Renderer-side twin: allowMixedContent in
// capacitor.config.ts (Chromium otherwise kills ws:// from an https origin at
// the WebSocket constructor — measured on-device 2026-07-11).
const NSC_DIR = resolve(here, '../android/app/src/main/res/xml')
mkdirSync(NSC_DIR, { recursive: true })
writeFileSync(resolve(NSC_DIR, 'network_security_config.xml'), `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <!-- Explicitly restate the platform default: no cleartext anywhere… -->
    <base-config cleartextTrafficPermitted="false" />
    <!-- …except .onion, whose transport security is Tor itself (ws:// is the
         correct scheme — see app/src/relays.ts ONION_RELAYS). -->
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="true">onion</domain>
    </domain-config>
</network-security-config>
`)
console.error('wrote res/xml/network_security_config.xml (cleartext: .onion only)')
if (!xml.includes('android:networkSecurityConfig=')) {
  xml = xml.replace(/(<application\b)/, '$1 android:networkSecurityConfig="@xml/network_security_config"')
  changed = true
} else if (!xml.includes('android:networkSecurityConfig="@xml/network_security_config"')) {
  // Self-heal a stale value rather than add-once (the lesson from the
  // FGS-type drift: a cached generated project must not pin old config).
  xml = xml.replace(/android:networkSecurityConfig="[^"]*"/, 'android:networkSecurityConfig="@xml/network_security_config"')
  changed = true
}

// Without this, Android's default (adjustPan) leaves the WebView's own layout
// viewport oblivious to the keyboard — it just pans the whole window, so `dvh`
// units never shrink and a bottom sheet (DM/chat composer) can end up jammed
// half under the keyboard. adjustResize actually shrinks the WebView, so the
// compose sheet's own `max-height: 82dvh` does its job.
if (!xml.includes('android:windowSoftInputMode="adjustResize"')) {
  xml = xml.replace(
    /(<activity\b[^>]*android:name="\.MainActivity"[^>]*)(>)/,
    (_m, attrs, close) => `${attrs} android:windowSoftInputMode="adjustResize"${close}`,
  )
  changed = true
}

// Verified App Link for invite links/QRs. Appended after the MAIN/LAUNCHER
// intent filter of the only activity in the generated manifest.
//
// Claim ONLY path "/" — invite links are `https://host/#join=…`, whose path is
// "/" (the secret rides in the fragment). Claiming every path would swallow
// /get.html and /downloads/flock.apk into the app, making the "get the update"
// flow (and the download page generally) unreachable on any phone with flock
// installed.
const APP_LINK_HOST = 'flock.forgesworn.dev'
const APP_LINK_FILTER = `<intent-filter android:autoVerify="true">
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="https" android:host="${APP_LINK_HOST}" android:path="/" />
            </intent-filter>`
if (xml.includes(`android:host="${APP_LINK_HOST}"`) && !xml.includes('android:path="/"')) {
  // Older patch claimed every path — replace that filter with the narrow one.
  xml = xml.replace(
    /<intent-filter android:autoVerify="true">[\s\S]*?<\/intent-filter>/,
    APP_LINK_FILTER,
  )
  changed = true
} else if (!xml.includes(`android:host="${APP_LINK_HOST}"`)) {
  xml = xml.replace('</intent-filter>', `</intent-filter>\n\n            ${APP_LINK_FILTER}`)
  changed = true
}

// The location-free "stay reachable" foreground service (StayReachableService).
// specialUse type — a persistent message connection; it does NOT use location.
// The subtype <property> is mandatory for specialUse on Android 14+. Declared
// inside <application>, right before its close.
//
// This MUST correct a stale type, not merely add-once: the generated android/
// project is cached (gitignored), so an "add if absent" guard let an earlier
// `dataSync` declaration survive every rebuild while the Java moved to
// SPECIAL_USE. The mismatch makes startForeground throw
// `IllegalArgumentException: foregroundServiceType 0x40000000 is not a subset of
// 0x00000001` — which crashes the whole process the instant "stay reachable"
// starts. Manifest and StayReachableService.java must never drift.
const STAY_SERVICE = `        <service
            android:name=".StayReachableService"
            android:exported="false"
            android:foregroundServiceType="specialUse">
            <property
                android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"
                android:value="Receives end-to-end encrypted messages and safety alerts while the app is closed." />
        </service>`
// Matches an existing StayReachableService element in EITHER form — block
// (`…>…</service>`) or self-closing (`… />`). The block alternative is tempered
// with `(?!<service\b)` so it can never swallow a following <service> element.
const stayServiceRe = /<service\b[^>]*android:name="\.StayReachableService"(?:(?!<service\b)[\s\S])*?<\/service>|<service\b[^>]*android:name="\.StayReachableService"[^>]*\/>/
const existingStay = xml.match(stayServiceRe)?.[0]
if (!existingStay) {
  xml = xml.replace('</application>', `${STAY_SERVICE}\n    </application>`)
  changed = true
  console.error('added StayReachableService (specialUse) to manifest')
} else if (!existingStay.includes('android:foregroundServiceType="specialUse"')) {
  xml = xml.replace(stayServiceRe, STAY_SERVICE)
  changed = true
  console.error('corrected StayReachableService foregroundServiceType → specialUse (was stale)')
}

// FlockFixReceiver — explicit-component broadcasts only, never exported.
const FIX_RECEIVER = `        <receiver
            android:name=".FlockFixReceiver"
            android:exported="false" />`
if (!xml.includes('android:name=".FlockFixReceiver"')) {
  xml = xml.replace('</application>', `${FIX_RECEIVER}\n    </application>`)
  changed = true
  console.error('added FlockFixReceiver to manifest')
}

// FlockLocationService — the native GPS fix source (a location-typed FGS). Same
// self-heal discipline as StayReachableService above: CORRECT a stale
// foregroundServiceType, don't merely add-once, because the generated android/
// project is cached (gitignored) — an "add if absent" guard would let an old
// type survive every rebuild and then crash startForeground on API 34+.
const FLOCK_LOCATION_SERVICE = `        <service
            android:name=".FlockLocationService"
            android:exported="false"
            android:foregroundServiceType="location" />`
// Matches an existing element in either form (block or self-closing); the block
// alternative is tempered with `(?!<service\b)` so it can't swallow a following
// <service>.
const flockLocServiceRe = /<service\b[^>]*android:name="\.FlockLocationService"(?:(?!<service\b)[\s\S])*?<\/service>|<service\b[^>]*android:name="\.FlockLocationService"[^>]*\/>/
const existingFlockLoc = xml.match(flockLocServiceRe)?.[0]
if (!existingFlockLoc) {
  xml = xml.replace('</application>', `${FLOCK_LOCATION_SERVICE}\n    </application>`)
  changed = true
  console.error('added FlockLocationService (location) to manifest')
} else if (!existingFlockLoc.includes('android:foregroundServiceType="location"')) {
  xml = xml.replace(flockLocServiceRe, FLOCK_LOCATION_SERVICE)
  changed = true
  console.error('corrected FlockLocationService foregroundServiceType → location (was stale)')
}

// RadarGuideService — locked-phone radar guidance (a location-typed FGS, like
// FlockLocationService). Same self-heal discipline: CORRECT a stale
// foregroundServiceType rather than add-once (the cached generated project
// would otherwise keep an old type and crash startForeground on API 34+).
const RADAR_GUIDE_SERVICE = `        <service
            android:name=".RadarGuideService"
            android:exported="false"
            android:foregroundServiceType="location" />`
const radarGuideServiceRe = /<service\b[^>]*android:name="\.RadarGuideService"(?:(?!<service\b)[\s\S])*?<\/service>|<service\b[^>]*android:name="\.RadarGuideService"[^>]*\/>/
const existingRadarGuide = xml.match(radarGuideServiceRe)?.[0]
if (!existingRadarGuide) {
  xml = xml.replace('</application>', `${RADAR_GUIDE_SERVICE}\n    </application>`)
  changed = true
  console.error('added RadarGuideService (location) to manifest')
} else if (!existingRadarGuide.includes('android:foregroundServiceType="location"')) {
  xml = xml.replace(radarGuideServiceRe, RADAR_GUIDE_SERVICE)
  changed = true
  console.error('corrected RadarGuideService foregroundServiceType → location (was stale)')
}

if (changed) {
  writeFileSync(manifestPath, xml)
  console.error('patched android/app/src/main/AndroidManifest.xml')
} else {
  console.error('AndroidManifest.xml already patched')
}

// ── Kotlin + publish-pipeline dependencies ──────────────────────────────────
const rootGradlePath = resolve(here, '../android/build.gradle')
let rootGradle = readFileSync(rootGradlePath, 'utf8')
const AGP_ANCHOR = "classpath 'com.android.tools.build:gradle"
if (!rootGradle.includes(AGP_ANCHOR)) {
  throw new Error('patch-android: AGP classpath anchor not found — Capacitor template changed, update the patch')
}
if (!rootGradle.includes('kotlin-gradle-plugin')) {
  rootGradle = rootGradle.replace(
    new RegExp(`(\\s*)(${AGP_ANCHOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*)`),
    `$1$2$1classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:2.1.0'`,
  )
  writeFileSync(rootGradlePath, rootGradle)
  console.error('added Kotlin Gradle plugin to root build.gradle')
}

const appGradlePath = resolve(here, '../android/app/build.gradle')
let appGradle = readFileSync(appGradlePath, 'utf8')
const appGradleBefore = appGradle
const APPLY_ANCHOR = "apply plugin: 'com.android.application'"
if (!appGradle.includes(APPLY_ANCHOR)) {
  throw new Error('patch-android: application plugin anchor not found — update the patch')
}
if (!appGradle.includes('kotlin-android')) {
  appGradle = appGradle.replace(APPLY_ANCHOR, `${APPLY_ANCHOR}\napply plugin: 'kotlin-android'`)
}
const PUBLISH_DEPS = `    // Native background publish (docs/plans/2026-07-05-native-background-publish-design.md)
    implementation "org.rust-nostr:nostr-sdk:0.44.2"
    implementation "androidx.security:security-crypto:1.1.0-alpha06"
    implementation "androidx.lifecycle:lifecycle-process:2.8.7"
    implementation "com.squareup.okhttp3:okhttp:4.12.0"`
if (!appGradle.includes('org.rust-nostr:nostr-sdk')) {
  const DEPS_ANCHOR = 'dependencies {'
  if (!appGradle.includes(DEPS_ANCHOR)) throw new Error('patch-android: dependencies block not found — update the patch')
  appGradle = appGradle.replace(DEPS_ANCHOR, `${DEPS_ANCHOR}\n${PUBLISH_DEPS}`)
}

// Kotlin must match capacitor.build.gradle's Java 21 compileOptions — an
// unset jvmTarget defaults to 1.8 and hard-fails the mixed-source module.
if (!appGradle.includes('jvmToolchain')) {
  appGradle += `\nkotlin {\n    jvmToolchain(21)\n}\n`
}

if (appGradle !== appGradleBefore) {
  writeFileSync(appGradlePath, appGradle)
  console.error('patched app/build.gradle (kotlin plugin + publish deps)')
}

// ── Fix broadcast out of @capacitor-community/background-geolocation ───────
// The plugin delivers each fix to JS via the Capacitor bridge, which a
// backgrounded WebView suspends (the confirmed root cause — see the design
// doc). This patch ALSO hands every fix to FlockFixReceiver as an
// explicit-component broadcast, so the native pipeline sees fixes the JS
// can't. Applied to node_modules (regenerated on every build); the anchor
// assert makes a plugin update fail the build loudly, never silently.
const bgPluginPath = resolve(here,
  '../node_modules/@capacitor-community/background-geolocation/android/src/main/java/com/equimaps/capacitor_background_geolocation/BackgroundGeolocation.java')
let bgPlugin = readFileSync(bgPluginPath, 'utf8')
const FIX_HOOK_MARK = 'cc.trotters.flock.FIX'
if (!bgPlugin.includes(FIX_HOOK_MARK)) {
  const RECEIVE_ANCHOR = 'public void onReceive(Context context, Intent intent) {\n            String id = intent.getStringExtra("id");'
  if (!bgPlugin.includes(RECEIVE_ANCHOR)) {
    throw new Error('patch-android: background-geolocation ServiceReceiver anchor not found — plugin updated, revalidate the fix hook')
  }
  bgPlugin = bgPlugin.replace(RECEIVE_ANCHOR,
    `public void onReceive(Context context, Intent intent) {
            // flock: hand every fix to the native publish pipeline as well —
            // injected by native/patch-android.mjs, see docs/plans/
            // 2026-07-05-native-background-publish-design.md.
            Location flockFix = intent.getParcelableExtra("location");
            if (flockFix != null) {
                Intent fwd = new Intent("${FIX_HOOK_MARK}");
                fwd.setClassName(context.getPackageName(), "cc.trotters.flock.FlockFixReceiver");
                fwd.putExtra("lat", flockFix.getLatitude());
                fwd.putExtra("lon", flockFix.getLongitude());
                fwd.putExtra("accuracy", (double) flockFix.getAccuracy());
                fwd.putExtra("time", flockFix.getTime());
                context.sendBroadcast(fwd);
            }
            String id = intent.getStringExtra("id");`)
  writeFileSync(bgPluginPath, bgPlugin)
  console.error('patched background-geolocation: fix broadcast → FlockFixReceiver')
} else {
  console.error('background-geolocation fix broadcast already patched')
}
