// "Stay reachable" bridge (Capacitor shell).
//
// Starts/stops the location-free foreground service (StayReachableService) that
// keeps flock's process alive while the app is closed, so the relay
// subscription keeps receiving and incoming messages fire real notifications —
// Signal-parity on a locked screen, no Google APIs. app.ts owns the policy
// (opt-in toggle, decoy/reset teardown); this module is a thin bridge.

import { registerPlugin } from '@capacitor/core'

interface StayReachablePlugin {
  start(): Promise<void>
  stop(): Promise<void>
  isIgnoringBatteryOptimizations(): Promise<{ value: boolean }>
  requestIgnoreBatteryOptimizations(): Promise<void>
}

const StayReachable = registerPlugin<StayReachablePlugin>('StayReachable')

/** Start the keep-alive foreground service. */
export function startStayReachable(): Promise<void> {
  return StayReachable.start().catch(() => { /* plugin missing on old shell — no-op */ })
}

/** Stop it (toggle off / reset / decoy-hide). The ongoing notification must
 *  never outlive an explicit teardown. */
export function stopStayReachable(): Promise<void> {
  return StayReachable.stop().catch(() => { /* already gone */ })
}

/** Is flock exempt from Doze battery optimisation? (Parity holds overnight only
 *  when it is — aggressive OEMs freeze the service otherwise.) */
export async function isBatteryExempt(): Promise<boolean> {
  try { return (await StayReachable.isIgnoringBatteryOptimizations()).value } catch { return false }
}

/** Ask the OS to exempt flock from battery optimisation (shows the system
 *  dialog). No-ops if already exempt or unsupported. */
export function requestBatteryExemption(): Promise<void> {
  return StayReachable.requestIgnoreBatteryOptimizations().catch(() => { /* blocked ROM */ })
}
