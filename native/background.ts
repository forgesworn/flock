// Native background-geolocation bridge (Capacitor) — REFERENCE SCAFFOLD.
//
// This file is not part of the web build or the library gates. It documents the
// exact integration to add once the Capacitor shell is set up (see
// native/README.md). It reuses the SAME flock policy + transport as the PWA, so
// background fixes follow the identical disclosure-on-event rules:
//   - family : emit nothing unless a geofence breach (full precision)
//   - nightout: emit a coarse beacon, throttled
// "help"/SOS stays a foreground, user-initiated action.
//
// Plugin: @capacitor-community/background-geolocation (free; LocationManager +
// foreground service — no Google APIs, so it works on GrapheneOS).

import { registerPlugin } from '@capacitor/core'
import { encode } from 'geohash-kit'
import {
  decideEmission,
  signalTypeForReason,
  buildLocationSignal,
} from '@forgesworn/flock'
import * as store from '../app/src/store'
import * as svc from '../app/src/services'
import { makeLocalSigner } from '../app/src/signer'

interface BgLocation { latitude: number; longitude: number; accuracy: number; time: number }
interface BgError { code: string; message: string }

interface BackgroundGeolocationPlugin {
  addWatcher(
    options: {
      backgroundTitle?: string
      backgroundMessage?: string
      requestPermissions?: boolean
      stale?: boolean
      distanceFilter?: number
    },
    callback: (location?: BgLocation, error?: BgError) => void,
  ): Promise<string>
  removeWatcher(options: { id: string }): Promise<void>
}

const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation')

let lastBeacon = 0

/** Start the background watcher. Call once on app start when on a native platform. */
export function startBackgroundWatch(): Promise<string> {
  return BackgroundGeolocation.addWatcher(
    {
      backgroundTitle: 'flock is keeping watch',
      backgroundMessage: 'Your location is only shared if you leave a safe zone or raise help.',
      requestPermissions: true,
      stale: false,
      distanceFilter: 25, // metres — battery-friendly; only fires on real movement
    },
    (location, error) => {
      if (error || !location) return
      void onBackgroundFix(location)
    },
  )
}

export function stopBackgroundWatch(id: string): Promise<void> {
  return BackgroundGeolocation.removeWatcher({ id })
}

async function onBackgroundFix(loc: BgLocation): Promise<void> {
  const s = store.load()
  if (!s.circle || !s.identity?.skHex) return // background path assumes a local key
  const position = { lat: loc.latitude, lon: loc.longitude }

  const plan = decideEmission({
    mode: s.circle.mode,
    position,
    trigger: 'none',
    geofences: s.circle.mode === 'family' ? s.geofences : undefined,
  })
  const type = signalTypeForReason(plan.reason)
  if (!type || type === 'help' || plan.action === 'withhold') return // withheld: emit nothing

  const now = Math.floor(Date.now() / 1000)
  if (plan.reason === 'nightout' && now - lastBeacon < 45) return // throttle coarse beacons
  lastBeacon = now

  const geohash = encode(position.lat, position.lon, plan.precision)
  const template = await buildLocationSignal({
    groupId: s.circle.id,
    seedHex: s.circle.seedHex,
    signalType: type,
    geohash,
    precision: plan.precision,
  })
  await svc.publishEvent(s.relayUrl, template, makeLocalSigner(s.identity.skHex))
}
