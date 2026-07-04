// System-notification bridge (Capacitor shell).
//
// The web app's toasts render into the WebView — invisible the moment the
// screen is off or another app is in front, which is precisely when "🚨 Help
// raised" or an incoming message matters most. When the app is hidden, app.ts
// mirrors its toasts here as real Android notifications (heads-up + sound per
// system settings).
//
// @capacitor/local-notifications is pure AOSP — no Google APIs, so this works
// on GrapheneOS. POST_NOTIFICATIONS is already in the manifest for the
// background watcher's foreground service.
//
// Notifications are split across channels so a private 1:1 message, a note to
// the whole circle, and a safety alert each land as a distinct, separately
// tunable notification — different heading, its own sound/importance in Android
// settings, and its own stacked group (Signal-style, one conversation per
// stack) rather than one undifferentiated "flock" pile.

import { LocalNotifications } from '@capacitor/local-notifications'

/** Which stream a notification belongs to — picks channel, heading fallback and stacking. */
export type NotifyKind = 'dm' | 'group' | 'alert' | 'general'

export interface NotifyOptions {
  kind?: NotifyKind
  /** Heading line — the sender (DM) or circle (group). Defaults to 'flock'. */
  title?: string
  /** Stacks related notifications together (one conversation / circle per stack). */
  group?: string
}

// Android channels are immutable once created — importance/visibility set here
// stick for the install, and a later change needs a NEW id (bump the suffix).
// We request visibility PUBLIC (show sender + message on the lock screen —
// Signal's default, chosen over redaction; see AskUserQuestion). NOTE: Android
// normalises an app's channel visibility to NO_OVERRIDE — an app can make a
// channel MORE private (PRIVATE/SECRET) but can't force it more public than the
// user's global lock-screen setting, so content shows per that global setting
// (as Signal's does too). Verified on the A32: content visible on the lock
// screen while flock was closed + screen-off.
const V_PUBLIC = 1
const IMP_HIGH = 4 // heads-up + sound
const IMP_DEFAULT = 3 // no heads-up

const CHANNELS = [
  { id: 'flock-dm-v1', name: 'Direct messages', description: 'Private 1:1 messages from a circle member', importance: IMP_HIGH, visibility: V_PUBLIC, vibration: true, lights: true, lightColor: '#7c9cff' },
  { id: 'flock-group-v1', name: 'Group messages', description: 'Buzzes and notes shared with your whole circle', importance: IMP_HIGH, visibility: V_PUBLIC, vibration: true },
  { id: 'flock-alert-v1', name: 'Safety alerts', description: 'Lost-phone and urgent safety signals', importance: IMP_HIGH, visibility: V_PUBLIC, vibration: true, lights: true, lightColor: '#ff6b6b' },
  { id: 'flock-general-v1', name: 'General', description: 'Timers and other flock notifications', importance: IMP_DEFAULT, visibility: V_PUBLIC },
] as const

const CHANNEL_ID: Record<NotifyKind, string> = {
  dm: 'flock-dm-v1',
  group: 'flock-group-v1',
  alert: 'flock-alert-v1',
  general: 'flock-general-v1',
}

let seq = 1

/** Create the notification channels (idempotent — safe to call every boot). */
async function ensureChannels(): Promise<void> {
  try {
    await Promise.all(CHANNELS.map((c) => LocalNotifications.createChannel(c)))
  } catch { /* pre-Android-8 or unavailable — schedule() falls back to a default channel */ }
}

/** Ask for notification permission once, at boot — asking later (from the
 *  background, mid-emergency) is too late to show a prompt. Also provisions the
 *  channels so the first real notification already lands on the right one. */
export async function ensureNotifyPermission(): Promise<void> {
  try {
    const s = await LocalNotifications.checkPermissions()
    if (s.display !== 'granted') await LocalNotifications.requestPermissions()
  } catch { /* denied or unavailable — notify() becomes a no-op */ }
  await ensureChannels()
}

/** Raise a system notification on the channel for its kind. Body is the app's
 *  own toast text; title/group differentiate the stream (DM vs group vs alert). */
export async function notify(body: string, opts: NotifyOptions = {}): Promise<void> {
  const kind = opts.kind ?? 'general'
  try {
    await LocalNotifications.schedule({
      notifications: [{
        id: seq++,
        title: opts.title || 'flock',
        body,
        channelId: CHANNEL_ID[kind],
        ...(opts.group ? { group: opts.group } : {}),
      }],
    })
  } catch { /* permission denied — nothing else to do */ }
}
