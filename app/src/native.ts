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

/**
 * Whether a newer sideloaded APK is available to install.
 *
 * Compares the running build against the LATEST PUBLISHED APK build
 * (`downloads/apk.json`, bumped only when a new APK ships) — NEVER the website
 * deploy. The site redeploys on nearly every commit, but a new APK ships far less
 * often, so comparing to the site's `/version.json` made the shell nag "update
 * available" after every content deploy even when no new APK existed.
 *
 * Both stamps are git short-hashes, optionally suffixed `+dev` for a dirty tree;
 * the suffix is ignored so a developer's own dirty build of a commit doesn't read
 * as out-of-date against the clean release of that same commit. An empty/absent
 * published build (offline, or no APK shipped yet) is never an update.
 */
export function isApkUpdateAvailable(installed: string, published: string | null | undefined): boolean {
  if (!published) return false
  const base = (b: string): string => b.split('+')[0]
  return base(published) !== base(installed)
}
