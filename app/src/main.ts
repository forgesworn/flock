import './styles.css'
import '@fontsource-variable/fraunces'
import '@fontsource-variable/hanken-grotesk'
import { mount } from './app'
import { isNativeShell } from './native'

const el = document.getElementById('app')

// Dev-only BLE diagnostics surface (app/src/ble-diagnostics.ts). Reachable ONLY
// via `?diag=ble` or a `VITE_FLOCK_DIAG=ble` build — nothing in the product links
// here, so real users never see it. Dynamic-imported so the shared BLE plugin
// (and @capacitor/core) stays out of the normal bundle, matching app.ts.
const diag = new URLSearchParams(location.search).get('diag') || import.meta.env.VITE_FLOCK_DIAG
if (el && diag === 'ble') {
  void import('./ble-diagnostics').then((m) => m.renderBleDiagnostics(el))
} else if (el) {
  mount(el)
}

// The Capacitor shell serves the bundled assets directly — a service worker
// adds nothing there except stale-cache risk across APK updates; web-only.
if ('serviceWorker' in navigator && !isNativeShell()) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* ignore */ })
  })
}
