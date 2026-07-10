// Native background-geolocation bridge (Capacitor shell).
//
// A thin fix-forwarder ONLY. It starts the plugin's watcher (platform
// LocationManager + a foreground service — no Google APIs, so it works on
// GrapheneOS) and hands every fix to the app's normal pipeline. ALL policy
// stays in app.ts's onFix → autoEmit path: breadcrumbs, off-grid, no-report
// zones, accuracy-aware breach decisions and cadence gating apply identically
// to foreground and background fixes — the disclosure rules cannot diverge
// (FLOCK.md §6). This module must never decide *whether* to emit.
//
// Plugin: @capacitor-community/background-geolocation (free; LocationManager +
// foreground service — no Google APIs). The OS shows a persistent notification
// while the watcher runs; it is tied strictly to the sharing toggle, so hiding
// (decoy) and stop-sharing tear it down.

import { registerPlugin } from '@capacitor/core'
import type { PermissionState } from '@capacitor/core'

/** Mirrors app/src/services.ts `Fix` (at = unix seconds). */
export interface BgFix { lat: number; lon: number; accuracy: number; at: number }

interface BgLocation { latitude: number; longitude: number; accuracy: number; time: number }
interface BgError { code?: string; message?: string }

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
  // Capacitor auto-generates these from the plugin's @Permission("location")
  // alias (ACCESS_COARSE/FINE_LOCATION). Used to settle permission ONCE, up
  // front, before any watcher arms — see ensureLocationPermission.
  checkPermissions(): Promise<{ location: PermissionState }>
  requestPermissions(): Promise<{ location: PermissionState }>
}

const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation')

/**
 * Settle foreground/coarse location permission ONCE and await the result, so the
 * foreground `navigator.geolocation` watch and the background watcher don't both
 * race a runtime permission request. That collision is what made a fresh install
 * auto-share and then instantly self-revert: whichever requester loses the race
 * gets an immediate NOT_AUTHORIZED (the OS won't show two location dialogs at
 * once) and reverts sharing before the user has even answered. Resolves `true`
 * once permission is granted (already-granted returns without a prompt), `false`
 * on a genuine refusal. A shell whose plugin predates checkPermissions resolves
 * `true` so the watchers still get their chance (the pre-existing behaviour).
 */
export async function ensureLocationPermission(): Promise<boolean> {
  try {
    let state = await BackgroundGeolocation.checkPermissions()
    if (state.location !== 'granted') state = await BackgroundGeolocation.requestPermissions()
    return state.location === 'granted'
  } catch {
    return true
  }
}

/**
 * Start the background watcher. Fixes flow to `onFix`; a permission failure
 * (background location revoked / "Allow all the time" refused) flows to
 * `onDenied` so the caller can keep the sharing toggle honest — the same
 * contract as a foreground watch denial. Returns the watcher id.
 */
export function startBackgroundWatch(
  onFix: (fix: BgFix) => void,
  onDenied?: () => void,
): Promise<string> {
  return BackgroundGeolocation.addWatcher(
    {
      backgroundTitle: 'flock is sharing with your circle',
      backgroundMessage: 'Sharing your location with your circle while this is on.',
      requestPermissions: true,
      stale: false,
      // metres — battery-friendly, but 25 read as "stuck" for someone moving
      // within a crowd/stage area without covering much net distance (a
      // festival, not a walk across town). 10 trades a little more GPS
      // sampling for noticeably more responsive movement in a dense crowd.
      distanceFilter: 10,
    },
    (location, error) => {
      if (error) {
        if (error.code === 'NOT_AUTHORIZED') onDenied?.()
        return
      }
      if (!location) return
      onFix({
        lat: location.latitude,
        lon: location.longitude,
        accuracy: location.accuracy,
        at: Math.floor(location.time / 1000),
      })
    },
  )
}

export function stopBackgroundWatch(id: string): Promise<void> {
  return BackgroundGeolocation.removeWatcher({ id })
}
