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
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
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
for (const f of ['StayReachableService.java', 'StayReachablePlugin.java', 'FlockNotifyPlugin.java', 'FlockBlePlugin.java', 'MainActivity.java']) {
  copyFileSync(resolve(JAVA_SRC, f), resolve(JAVA_DEST, f))
}
console.error('copied stay-reachable native sources into android/')

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
  // BLE-nearby transport (FlockBlePlugin): phone-to-phone off-relay delivery when
  // circle members are co-located. ADVERTISE + CONNECT are bare; SCAN carries
  // neverForLocation (we never derive location from BLE) and is added separately
  // below with that flag. flock already declares FINE/COARSE location (geofencing).
  'android.permission.BLUETOOTH_ADVERTISE',
  'android.permission.BLUETOOTH_CONNECT',
]

let xml = readFileSync(manifestPath, 'utf8')
let changed = false

for (const p of PERMISSIONS) {
  if (!xml.includes(`"${p}"`)) {
    xml = xml.replace('</manifest>', `    <uses-permission android:name="${p}" />\n</manifest>`)
    changed = true
  }
}

// BLUETOOTH_SCAN needs the neverForLocation flag (a plain name-only <uses-permission>
// can't express it), and BLE is declared as an optional feature. Idempotent.
if (!xml.includes('BLUETOOTH_SCAN')) {
  xml = xml.replace('</manifest>',
    `    <uses-feature android:name="android.hardware.bluetooth_le" android:required="false" />\n` +
    `    <uses-permission android:name="android.permission.BLUETOOTH_SCAN" android:usesPermissionFlags="neverForLocation" />\n</manifest>`)
  changed = true
}

if (xml.includes('android:allowBackup="true"')) {
  xml = xml.replace('android:allowBackup="true"', 'android:allowBackup="false"')
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
if (!xml.includes('.StayReachableService')) {
  const service = `        <service
            android:name=".StayReachableService"
            android:exported="false"
            android:foregroundServiceType="specialUse">
            <property
                android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"
                android:value="Receives end-to-end encrypted messages and safety alerts while the app is closed." />
        </service>
`
  xml = xml.replace('</application>', `${service}    </application>`)
  changed = true
}

if (changed) {
  writeFileSync(manifestPath, xml)
  console.error('patched android/app/src/main/AndroidManifest.xml')
} else {
  console.error('AndroidManifest.xml already patched')
}
