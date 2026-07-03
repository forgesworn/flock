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

if (changed) {
  writeFileSync(manifestPath, xml)
  console.error('patched android/app/src/main/AndroidManifest.xml')
} else {
  console.error('AndroidManifest.xml already patched')
}
