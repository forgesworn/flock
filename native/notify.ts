// System-notification bridge (Capacitor shell).
//
// The web app's toasts render into the WebView — invisible the moment the
// screen is off or another app is in front, which is precisely when "🚨 Help
// raised" matters most. When the app is hidden, app.ts mirrors its toasts
// here as real Android notifications (heads-up + sound per system settings).
//
// @capacitor/local-notifications is pure AOSP — no Google APIs, so this works
// on GrapheneOS. POST_NOTIFICATIONS is already in the manifest for the
// background watcher's foreground service.

import { LocalNotifications } from '@capacitor/local-notifications'

let seq = 1

/** Ask for notification permission once, at boot — asking later (from the
 *  background, mid-emergency) is too late to show a prompt. */
export async function ensureNotifyPermission(): Promise<void> {
  try {
    const s = await LocalNotifications.checkPermissions()
    if (s.display !== 'granted') await LocalNotifications.requestPermissions()
  } catch { /* denied or unavailable — notify() becomes a no-op */ }
}

/** Raise a system notification. Body is the app's own toast text. */
export async function notify(body: string): Promise<void> {
  try {
    await LocalNotifications.schedule({
      notifications: [{ id: seq++, title: 'flock', body }],
    })
  } catch { /* permission denied — nothing else to do */ }
}
