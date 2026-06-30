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
  },
}

export default config
