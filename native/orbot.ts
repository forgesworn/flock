// Tor `.onion` relay endpoint — Orbot reachability bridge (Capacitor shell).
// docs/plans/2026-07-04-mesh-bridge-goal.md Task B.
//
// A WebView's WebSocket/fetch has no SOCKS-proxy option and cannot resolve a
// `.onion` address at all without something Tor-aware in the network path.
// flock does not implement its own SOCKS client — it relies on Orbot's own
// system-wide/per-app VPN (transparent-proxy) mode, which the user turns on in
// the separate Orbot app. This module's only job is a best-effort SIGNAL that
// Orbot is actually running (a successful TCP connect to its default SOCKS
// port, 127.0.0.1:9050 — see native/android-src/FlockOrbotPlugin.java). It is
// evidence, not a guarantee: `effectiveRelays` (app/src/relays.ts) still fails
// loud rather than silently using clearnet if the route ever isn't ready.
//
// STRICTLY ADDITIVE and opt-in, like BLE-nearby (native/ble.ts): on the web
// PWA there is no plugin, so this always resolves false — the toggle's copy
// says as much ("needs the app + Orbot"). Never called unless the user has
// switched Tor routing on; the relay path is untouched otherwise.

import { registerPlugin } from '@capacitor/core'

interface FlockOrbotPlugin {
  checkSocksProxy(): Promise<{ reachable: boolean }>
}

const FlockOrbot = registerPlugin<FlockOrbotPlugin>('FlockOrbot')

/** Best-effort check that Orbot's SOCKS proxy is reachable. Never throws —
 *  resolves false on the web PWA, an older shell without the plugin, or any
 *  probe failure (Orbot not installed/running, port not listening). */
export async function detectOrbot(): Promise<boolean> {
  try {
    return (await FlockOrbot.checkSocksProxy()).reachable
  } catch {
    return false
  }
}
