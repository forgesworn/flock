import './styles.css'
import '@fontsource-variable/fraunces'
import '@fontsource-variable/hanken-grotesk'
import { mount } from './app'

const el = document.getElementById('app')
if (el) mount(el)

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* ignore */ })
  })
}
