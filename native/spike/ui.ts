// Minimal on-device readout for the spike. No framework — re-rendered on a timer
// (so background-recorded fixes appear when you reopen the app) and after each
// button press. Shows the live pass/fail numbers and lets you copy the raw
// session JSON off the phone.

import { computeMetrics } from './metrics'
import type { SpikeSession } from './metrics'
import * as h from './harness'

function clock(t: number): string {
  return new Date(t).toLocaleTimeString()
}

function passChip(v: boolean | null): string {
  if (v == null) return '<span class="chip muted">—</span>'
  return v ? '<span class="chip ok">PASS</span>' : '<span class="chip bad">FAIL</span>'
}

function escapeJson(s: SpikeSession): string {
  // Guard the textarea against any stray "</" in the device user-agent string.
  return JSON.stringify(s).replace(/</g, '\\u003c')
}

export function render(root: HTMLElement): void {
  const s = h.getSession()
  const m = computeMetrics(s)
  const watching = h.isWatching()
  const zone = s.zone
  const recent = [...s.fixes].slice(-12).reverse()

  root.innerHTML = `
    <header>
      <h1>flock · Phase 0 spike</h1>
      <p class="sub">Background location — GrapheneOS / Android</p>
    </header>

    <section class="card">
      <div class="row"><span class="k">Watcher</span><span class="v ${watching ? 'on' : 'off'}">${watching ? 'running' : 'stopped'}</span></div>
      <div class="row"><span class="k">Safe zone</span><span class="v">${zone ? `set · r=${zone.radiusMetres} m` : 'not set'}</span></div>
      <div class="btns">
        <button id="zone">Set safe zone here</button>
        <input id="radius" type="number" value="150" min="25" step="25" aria-label="radius in metres" />
        <button id="${watching ? 'stop' : 'start'}" class="primary">${watching ? 'Stop watch' : 'Start watch'}</button>
      </div>
    </section>

    <section class="card">
      <div class="grid">
        <div><b>${m.fixes}</b><small>fixes</small></div>
        <div><b>${Math.round(m.spanSec / 60)}m</b><small>span</small></div>
        <div><b>${m.intervalMedianS}s</b><small>median gap</small></div>
        <div><b>${m.intervalP90S}s</b><small>p90 gap</small></div>
        <div><b>${m.intervalMaxS}s</b><small>max gap</small></div>
        <div><b>${m.movingSamples ? m.movingIntervalP90S + 's' : '—'}</b><small>p90 moving (${m.movingSamples})</small></div>
      </div>
      <div class="row"><span class="k">#1 cadence ≤60 s while moving</span>${passChip(m.pass.cadence)}</div>
      <div class="row"><span class="k">#2 breach detected ≤90 s</span>${passChip(m.pass.breach)}</div>
      <div class="row"><span class="k">#3 gaps &gt; 5 min (judge w/ your walk log)</span><span class="v">${m.gapsOver5min.length}</span></div>
      ${m.breaches.length ? `<div class="row"><span class="k">breach latency</span><span class="v">${m.breaches.map((b) => (b.detectionSec == null ? '?' : b.detectionSec + 's')).join(', ')}</span></div>` : ''}
    </section>

    <section class="card">
      <div class="row"><span class="k">Recent fixes</span><span class="v">${recent.length ? '' : 'none yet'}</span></div>
      <ul class="fixes">${recent
        .map((x) => `<li><span>${clock(x.t)}</span><span>±${Math.round(x.acc)}m</span><span class="${x.out ? 'out' : 'in'}">${x.out ? 'OUT' : 'in'}</span></li>`)
        .join('')}</ul>
    </section>

    <section class="card">
      <div class="btns"><button id="export">Copy session JSON</button><button id="reset" class="danger">Reset</button></div>
      <textarea id="dump" readonly>${escapeJson(s)}</textarea>
    </section>
  `
  wire(root)
}

function flash(btn: HTMLElement, text: string): void {
  const original = btn.textContent
  btn.textContent = text
  setTimeout(() => { btn.textContent = original }, 1200)
}

function wire(root: HTMLElement): void {
  const byId = (id: string): HTMLElement | null => root.querySelector('#' + id)

  byId('zone')?.addEventListener('click', async () => {
    const r = Number((root.querySelector('#radius') as HTMLInputElement | null)?.value || 150)
    try { await h.setZoneHere(r) } catch { alert('No location yet — inject one (emulator: ⋮ → Location), then try again.') }
    render(root)
  })
  byId('start')?.addEventListener('click', async () => { await h.startWatch(); render(root) })
  byId('stop')?.addEventListener('click', async () => { await h.stopWatch(); render(root) })
  byId('reset')?.addEventListener('click', async () => {
    if (confirm('Clear the recorded session?')) { await h.resetSession(); render(root) }
  })
  byId('export')?.addEventListener('click', async () => {
    const btn = byId('export')
    const json = JSON.stringify(h.getSession())
    try {
      await navigator.clipboard.writeText(json)
      if (btn) flash(btn, 'Copied ✓')
    } catch {
      ;(root.querySelector('#dump') as HTMLTextAreaElement | null)?.select()
      if (btn) flash(btn, 'Select + copy ↓')
    }
  })
}
