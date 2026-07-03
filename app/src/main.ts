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
  })
}
