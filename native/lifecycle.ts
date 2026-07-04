// Native app lifecycle — fire a callback whenever flock returns to the
// foreground. A backgrounded Android WebView suspends JS timers, so anything
// that must run "when the user comes back" (e.g. the sideload update check)
// can't rely on setInterval alone. Capacitor's App events follow the Activity
// lifecycle and fire reliably on resume.
import { App } from '@capacitor/app'

/** Call `cb` each time the app is brought to the foreground. */
export async function onResume(cb: () => void): Promise<void> {
  await App.addListener('resume', () => cb())
  // Some Android builds deliver only appStateChange; treat becoming-active as a resume.
  await App.addListener('appStateChange', ({ isActive }) => { if (isActive) cb() })
}
