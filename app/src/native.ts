// The Capacitor shell (native APK) injects `window.Capacitor` before the page
// loads; the web build never defines it. Detecting via the injected global
// keeps @capacitor/core out of the web bundle entirely — the bridge module
// (native/background.ts) is only ever loaded dynamically inside the shell.
export function isNativeShell(): boolean {
  const c = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
  return c?.isNativePlatform?.() === true
}
