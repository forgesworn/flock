// Entry for the Phase 0 spike app. Loads any session recorded earlier (so a walk
// you did with the app backgrounded shows up when you reopen it), paints the
// readout, and re-paints on a timer to surface fixes that landed in the
// background.

import './styles.css'
import { loadSession } from './harness'
import { render } from './ui'

const el = document.getElementById('app')
if (el) {
  void loadSession().then(() => {
    render(el)
    setInterval(() => render(el), 5000)
  })
}
