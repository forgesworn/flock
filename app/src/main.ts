import './styles.css'
import '@fontsource-variable/fraunces'
import '@fontsource-variable/hanken-grotesk'
import { mount } from './app'
import { isNativeShell } from './native'

const el = document.getElementById('app')
if (el) mount(el)

// The Capacitor shell serves the bundled assets directly — a service worker
// adds nothing there except stale-cache risk across APK updates; web-only.
if ('serviceWorker' in navigator && !isNativeShell()) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* ignore */ })
    // Ask the SW to replay integrity alerts this page may have missed — e.g.
    // when the tampered response was this very navigation.
    navigator.serviceWorker.controller?.postMessage({ type: 'flock-integrity-ready' })
  })
  // Integrity warnings from the SW's signed-manifest check (sw.js): an asset
  // that doesn't match the published, release-key-signed manifest — or a
  // manifest that failed verification / vanished after having shipped. Loud,
  // persistent, outside the app's own render cycle: if the served code has
  // been altered, the app's UI is exactly what can't be trusted to show it.
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data: unknown = event.data
    if (!data || typeof data !== 'object' || (data as { type?: string }).type !== 'flock-integrity') return
    if (document.getElementById('flock-integrity-banner')) return
    const kind = (data as { kind?: string }).kind
    const banner = document.createElement('div')
    banner.id = 'flock-integrity-banner'
    banner.setAttribute('role', 'alert')
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#5d1f24;color:#fff;'
      + 'padding:12px 16px calc(12px + env(safe-area-inset-top, 0px));font:14px/1.5 system-ui,sans-serif;text-align:center'
    const what = kind === 'manifest-missing'
      ? "This site's integrity record has disappeared."
      : 'This copy of flock does not match what we published.'
    banner.innerHTML = `<strong>${what}</strong> Someone between you and flock may have changed it — `
      + 'don’t enter anything sensitive here. The Android app can be checked independently: '
      + '<a href="https://flock.forgesworn.dev/get.html" style="color:#fff">get the app</a>.'
    document.body.appendChild(banner)
  })
}
