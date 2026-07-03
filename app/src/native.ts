// The Capacitor shell (native APK) injects `window.Capacitor` before the page
// loads; the web build never defines it. Detecting via the injected global
// keeps @capacitor/core out of the web bundle entirely — the bridge module
// (native/background.ts) is only ever loaded dynamically inside the shell.
export function isNativeShell(): boolean {
  const c = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
  return c?.isNativePlatform?.() === true
}

// Self-hosters building their own APK can point invites at their deployment.
const HOSTED_ORIGIN: string = import.meta.env?.VITE_SHARE_ORIGIN || 'https://flock.forgesworn.dev'

/** Origin for links that will be OPENED ON ANOTHER DEVICE (join/invite QRs and
 *  share links). On the web `location.origin` is exactly right — hosted,
 *  self-hosted and dev alike. Inside the native shell the WebView's origin is
 *  `https://localhost`, a dead link on any other phone, so those links point
 *  at the hosted PWA instead. */
export function shareOrigin(): string {
  return isNativeShell() ? HOSTED_ORIGIN : location.origin
}
