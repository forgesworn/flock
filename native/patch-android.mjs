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
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const manifestPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../android/app/src/main/AndroidManifest.xml',
)

const PERMISSIONS = [
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_LOCATION',
  'android.permission.POST_NOTIFICATIONS',
]

let xml = readFileSync(manifestPath, 'utf8')
let changed = false

for (const p of PERMISSIONS) {
  if (!xml.includes(`"${p}"`)) {
    xml = xml.replace('</manifest>', `    <uses-permission android:name="${p}" />\n</manifest>`)
    changed = true
  }
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

if (changed) {
  writeFileSync(manifestPath, xml)
  console.error('patched android/app/src/main/AndroidManifest.xml')
} else {
  console.error('AndroidManifest.xml already patched')
}
