import type { CapacitorConfig } from '@capacitor/cli'

// Capacitor wraps the built PWA (dist-app) as a native iOS/Android app, adding
// the one thing the web platform cannot do: true background geolocation. See
// native/README.md for setup and docs/plans/2026-06-30-phase0-graphene-spike.md
// for the GrapheneOS de-risking spike.

const config: CapacitorConfig = {
  appId: 'cc.trotters.flock',
  appName: 'flock',
  webDir: 'dist-app',
  backgroundColor: '#0e1116',
  android: {
    // GrapheneOS: no Google Play Services. The community background-geolocation
    // plugin uses the platform LocationManager (raw GPS) + a foreground service,
    // so it needs no Google APIs. Permissions/usage strings live in the native
    // project; see native/README.md.
    //
    // WebView debugging: OFF by default (Capacitor's own default already tracks
    // the manifest's debuggable flag, so a release build never exposes this) —
    // explicit here only so a real-hardware Playwright test session can opt in
    // via FLOCK_E2E_HARDWARE=1 without touching the signing key, so installing
    // over an existing app is a normal update (no data loss). Never set for a
    // build shipped to the public get-page.
    webContentsDebuggingEnabled: process.env.FLOCK_E2E_HARDWARE === '1',
    // The Tor route talks to the relay's v3 `.onion` twin as plain ws:// (Tor
    // IS the transport security; no CA issues `.onion` certs to pin). Chromium
    // kills any insecure WebSocket from an https origin at the CONSTRUCTOR —
    // measured in this WebView 2026-07-11 — so mixed content must be allowed
    // for the onion route to exist at all. The loosening is fenced at the
    // network layer: the committed network-security-config (patch-android.mjs)
    // keeps cleartext BLOCKED for every host except `.onion`, and profile
    // avatars are https-only (app/src/profiles.ts), so no clearnet request
    // can quietly downgrade because of this flag.
    allowMixedContent: true,
  },
}

export default config
