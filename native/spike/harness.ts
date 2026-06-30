// Device wiring for the Phase 0 spike. Starts the free, Google-free background
// watcher (same plugin as native/background.ts), evaluates the *real* flock
// geofence on each fix, and persists the whole session with @capacitor/preferences
// so it survives the WebView being backgrounded / torn down — which is the entire
// point of the measurement. Throwaway code: correctness over polish.

import { registerPlugin } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'
import { Geolocation } from '@capacitor/geolocation'
// Import the module under test directly (not the public barrel) so nothing but
// geofence.ts influences the breach decision we're measuring.
import { isBreach, type CircleGeofence } from '../../src/geofence'
import type { SpikeSession, SpikeFix } from './metrics'

// --- background-geolocation plugin (capacitor-community: LocationManager + a
// foreground service, no Google Play Services → runs on GrapheneOS) ---
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

const KEY = 'flock.spike.session'
let watcherId: string | null = null
let session: SpikeSession = blank()

function blank(): SpikeSession {
  return { startedAt: Date.now(), zone: null, fixes: [], breaches: [], device: navigator.userAgent }
}

export async function loadSession(): Promise<SpikeSession> {
  const { value } = await Preferences.get({ key: KEY })
  if (value) {
    try { session = JSON.parse(value) as SpikeSession } catch { /* corrupt → keep blank */ }
  }
  return session
}

async function save(): Promise<void> {
  await Preferences.set({ key: KEY, value: JSON.stringify(session) })
}

export function getSession(): SpikeSession { return session }
export function isWatching(): boolean { return watcherId !== null }

export async function resetSession(): Promise<SpikeSession> {
  session = blank()
  await save()
  return session
}

/** Capture the current position as the centre of the safe zone for this run. */
export async function setZoneHere(radiusMetres: number): Promise<void> {
  const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true })
  session.zone = { lat: pos.coords.latitude, lon: pos.coords.longitude, radiusMetres }
  await save()
}

function zoneFence(): CircleGeofence | null {
  if (!session.zone) return null
  return {
    kind: 'circle',
    centre: { lat: session.zone.lat, lon: session.zone.lon },
    radiusMetres: session.zone.radiusMetres,
  }
}

async function onFix(loc: BgLocation): Promise<void> {
  const fence = zoneFence()
  const out = fence ? isBreach({ lat: loc.latitude, lon: loc.longitude }, fence) : false
  const prev = session.fixes[session.fixes.length - 1]
  const fix: SpikeFix = { t: Date.now(), lat: loc.latitude, lon: loc.longitude, acc: loc.accuracy, out }

  // A fresh inside→outside transition is a detected breach (test #2 latency).
  if (fence && out && (!prev || !prev.out)) {
    session.breaches.push({ lastInsideT: prev && !prev.out ? prev.t : null, firstOutsideT: fix.t })
  }

  session.fixes.push(fix)
  await save()
}

/** Start the background watcher. Triggers the location permission flow on first call. */
export async function startWatch(): Promise<void> {
  if (watcherId) return
  watcherId = await BackgroundGeolocation.addWatcher(
    {
      backgroundTitle: 'flock spike',
      backgroundMessage: 'Measuring background location reliability (Phase 0).',
      requestPermissions: true,
      stale: false,
      distanceFilter: 25, // metres — matches native/background.ts; only fires on real movement
    },
    (location, error) => {
      if (error || !location) return
      void onFix(location)
    },
  )
}

export async function stopWatch(): Promise<void> {
  if (!watcherId) return
  await BackgroundGeolocation.removeWatcher({ id: watcherId })
  watcherId = null
}
