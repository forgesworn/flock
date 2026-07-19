// Flock BLE diagnostics — a dev-only field-test surface for the shared
// capacitor-mesh-ble transport. It drives Flock's own native/ble.ts adapter
// (the discreet `hops=0` / crowd `hops>0` policy) so you can prove advertise,
// scan, GATT, peer links, fragmentation/reassembly and reconnect on real
// hardware with NO GPS, NO circle and NO relay — the gap the product's
// map-centric UI can't show. Ships nothing to users: nothing links here, it is
// reachable only via `?diag=ble` (or a `VITE_FLOCK_DIAG=ble` build), and the
// whole module is a dynamic-import chunk (so @capacitor/core stays out of the
// normal web bundle exactly as elsewhere).
//
// Port of meatchat/app/src/screens/ble-diagnostics.tsx, reimplemented in Flock's
// vanilla-TS, render-once-then-patch idiom (Meatchat is Preact).

import {
  startBle,
  stopBle,
  broadcastBle,
  sendBle,
  getBleStatus,
  addBleStatusListener,
} from '../../native/ble'

// A fixed, valid BLE service UUID so two diagnostic devices pair deterministically
// (the product rotates its advertId per circle; a diagnostic wants a stable target).
const DIAG_SERVICE_UUID = '9d3b1f7a-0c4e-4a2b-b9a1-0d1a9f7c3e11'

type Status = Record<string, unknown>

interface LogLine { at: string; text: string }

function num(s: Status, k: string): number {
  const v = s[k]
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
function flag(s: Status, k: string): boolean {
  return s[k] === true
}
function text(s: Status, k: string, d = ''): string {
  const v = s[k]
  return typeof v === 'string' && v.length > 0 ? v : d
}
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
}
function clock(): string {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
function randomSelfId(): string {
  const suffix =
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 8)
      : Math.floor(Math.random() * 0xffff_ffff).toString(16).padStart(8, '0')
  return `diag-${suffix}`
}

const STYLE = `
.fbd{max-width:34rem;margin:0 auto;padding:1rem 1rem 4rem;font-family:'Hanken Grotesk Variable',system-ui,sans-serif;color:#e8eef2}
.fbd h1{font-family:'Fraunces Variable',Georgia,serif;font-size:1.5rem;margin:0}
.fbd__head{display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem}
.fbd__panel{background:#161c22;border:1px solid #26313a;border-radius:14px;padding:1rem;margin-bottom:1rem}
.fbd__phead{display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem}
.fbd__phead strong{text-transform:capitalize}
.fbd__grid{display:grid;grid-template-columns:1fr 1fr;gap:.5rem;font-size:.9rem}
.fbd__grid span{background:#0f1418;border-radius:8px;padding:.5rem .625rem;display:flex;flex-direction:column;gap:.15rem}
.fbd__grid b{font-size:.7rem;text-transform:uppercase;letter-spacing:.04em;color:#8fa3b0}
.fbd__flags{display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.75rem}
.fbd__pill{font-size:.75rem;padding:.25rem .6rem;border-radius:999px;border:1px solid #2c3a44;color:#7d8f9b}
.fbd__pill--on{color:#7ee2a8;border-color:#2f6b4a;background:#122019}
.fbd__field{display:flex;flex-direction:column;gap:.3rem;margin-bottom:.75rem}
.fbd__field span{font-size:.78rem;color:#9fb2be}
.fbd input,.fbd select{width:100%;box-sizing:border-box;background:#0f1418;border:1px solid #2a353d;border-radius:8px;color:#e8eef2;padding:.55rem .65rem;font:inherit;font-size:.95rem}
.fbd__actions{display:flex;gap:.5rem;flex-wrap:wrap}
.fbd button{border-radius:10px;padding:.6rem 1rem;font:inherit;font-weight:600;border:1px solid #2c3a44;background:#1b232a;color:#e8eef2;cursor:pointer}
.fbd button.primary{background:#e5497d;border-color:#e5497d;color:#fff}
.fbd button:disabled{opacity:.45;cursor:not-allowed}
.fbd .link{background:none;border:none;color:#8bb4ff;padding:0;font-weight:600;cursor:pointer}
.fbd__err{color:#ff8f8f;font-size:.85rem;margin:.5rem 0 0}
.fbd__peers{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.4rem}
.fbd__peer{background:#0f1418;border-radius:8px;padding:.5rem .65rem;font-size:.85rem}
.fbd__peer button{font-size:.72rem;padding:.2rem .5rem;margin-top:.35rem}
.fbd__hint{color:#7d8f9b;font-size:.85rem}
.fbd__log{list-style:none;margin:0;padding:0;font-family:ui-monospace,monospace;font-size:.78rem;max-height:16rem;overflow:auto}
.fbd__log li{display:flex;gap:.6rem;padding:.15rem 0;border-bottom:1px solid #1b2228}
.fbd__log time{color:#6f818d;flex:none}
`

export function renderBleDiagnostics(host: HTMLElement): void {
  if (!document.getElementById('fbd-style')) {
    const style = document.createElement('style')
    style.id = 'fbd-style'
    style.textContent = STYLE
    document.head.appendChild(style)
  }

  const params = new URLSearchParams(location.search)
  let running = false
  let busy = false
  let sent = 0
  let received = 0
  const log: LogLine[] = []
  let statusHandle: { remove: () => void } | null = null

  host.className = 'fbd'
  host.innerHTML = `
    <header class="fbd__head">
      <h1>Flock BLE diagnostics</h1>
      <button class="link" data-act="refresh">Refresh</button>
    </header>

    <section class="fbd__panel">
      <div class="fbd__phead"><strong data-f="platform">…</strong><span class="fbd__hint" data-f="updated">updated never</span></div>
      <div class="fbd__grid">
        <span><b>Bluetooth</b><i data-f="bluetooth">—</i></span>
        <span><b>Permissions</b><i data-f="permissions">—</i></span>
        <span><b>Peers</b><i data-f="peers">0/0</i></span>
        <span><b>Queue</b><i data-f="queue">0</i></span>
        <span><b>TX</b><i data-f="tx">0 frames · 0 chunks</i></span>
        <span><b>RX</b><i data-f="rx">0 frames · 0 chunks</i></span>
      </div>
      <div class="fbd__flags">
        <span class="fbd__pill" data-flag="running">running</span>
        <span class="fbd__pill" data-flag="advertising">advertising</span>
        <span class="fbd__pill" data-flag="scanning">scanning</span>
        <span class="fbd__pill" data-flag="gattServer">gatt</span>
      </div>
      <p class="fbd__err" data-f="error" hidden></p>
    </section>

    <section class="fbd__panel">
      <label class="fbd__field"><span>Room</span><input data-in="room" value="${esc(params.get('room') || 'flock-ble-diagnostics')}"></label>
      <label class="fbd__field"><span>Self id (my pubkey stand-in)</span><input data-in="self" value="${esc(params.get('self') || randomSelfId())}"></label>
      <label class="fbd__field"><span>Mode</span>
        <select data-in="mode">
          <option value="0">Discreet (single-hop, hops=0)</option>
          <option value="3">Crowd (mesh flood, hops=3)</option>
        </select>
      </label>
      <div class="fbd__actions">
        <button class="primary" data-act="start">Start BLE</button>
        <button data-act="restart" disabled>Restart</button>
        <button data-act="stop" disabled>Stop</button>
      </div>
    </section>

    <section class="fbd__panel">
      <div class="fbd__phead"><strong>Test frame</strong><span class="fbd__hint" data-f="frames">0 sent · 0 received</span></div>
      <label class="fbd__field"><span>Target peer id <small>(empty broadcasts)</small></span><input data-in="target"></label>
      <label class="fbd__field"><span>Payload</span><input data-in="payload" value="ping"></label>
      <button class="primary" data-act="send" disabled>Send test frame</button>
    </section>

    <section class="fbd__panel">
      <div class="fbd__phead"><strong>Peers</strong><span class="fbd__hint" data-f="known">0 mapped ids</span></div>
      <ul class="fbd__peers" data-f="peerlist"></ul>
      <p class="fbd__hint" data-f="nopeers">No peers discovered yet.</p>
    </section>

    <section class="fbd__panel">
      <div class="fbd__phead"><strong>Event log</strong><button class="link" data-act="clear">Clear</button></div>
      <ol class="fbd__log" data-f="log"></ol>
    </section>
  `

  const q = <T extends HTMLElement = HTMLElement>(sel: string) => host.querySelector(sel) as T
  const roomEl = q<HTMLInputElement>('[data-in="room"]')
  const selfEl = q<HTMLInputElement>('[data-in="self"]')
  const modeEl = q<HTMLSelectElement>('[data-in="mode"]')
  const targetEl = q<HTMLInputElement>('[data-in="target"]')
  const payloadEl = q<HTMLInputElement>('[data-in="payload"]')
  const startBtn = q<HTMLButtonElement>('[data-act="start"]')
  const restartBtn = q<HTMLButtonElement>('[data-act="restart"]')
  const stopBtn = q<HTMLButtonElement>('[data-act="stop"]')
  const sendBtn = q<HTMLButtonElement>('[data-act="send"]')

  function setField(name: string, value: string) {
    const el = host.querySelector(`[data-f="${name}"]`)
    if (el) el.textContent = value
  }
  function syncButtons() {
    startBtn.disabled = busy || running || !roomEl.value.trim() || !selfEl.value.trim()
    restartBtn.disabled = busy || !running
    stopBtn.disabled = busy || !running
    sendBtn.disabled = !running
    roomEl.disabled = running || busy
    selfEl.disabled = running || busy
    modeEl.disabled = running || busy
  }
  function append(line: string) {
    log.unshift({ at: clock(), text: line })
    log.splice(80)
    const ol = host.querySelector('[data-f="log"]')
    if (ol) ol.innerHTML = log.map((l) => `<li><time>${l.at}</time><span>${esc(l.text)}</span></li>`).join('')
  }
  function applyStatus(s: Status) {
    setField('platform', text(s, 'platform', 'unknown'))
    const updated = num(s, 'updatedAt')
    setField('updated', `updated ${updated ? new Date(updated).toLocaleTimeString() : 'never'}`)
    setField('bluetooth', text(s, 'bluetooth', 'unknown'))
    setField('permissions', text(s, 'permissions', 'unknown'))
    setField('peers', `${num(s, 'writablePeers')}/${num(s, 'connectedPeers')}`)
    setField('queue', String(num(s, 'queuedChunks')))
    setField('tx', `${num(s, 'txFrames')} frames · ${num(s, 'txChunks')} chunks`)
    setField('rx', `${num(s, 'rxFrames')} frames · ${num(s, 'rxChunks')} chunks`)
    setField('known', `${num(s, 'knownPeers')} mapped ids`)
    for (const name of ['running', 'advertising', 'scanning', 'gattServer']) {
      host.querySelector(`[data-flag="${name}"]`)?.classList.toggle('fbd__pill--on', flag(s, name))
    }
    const missing = Array.isArray(s.missingPermissions) ? (s.missingPermissions as unknown[]).filter((v) => typeof v === 'string') : []
    const lastError = text(s, 'lastError')
    const errEl = host.querySelector('[data-f="error"]') as HTMLElement | null
    const msg = missing.length ? `Missing permissions: ${missing.join(', ')}` : lastError
    if (errEl) { errEl.textContent = msg; errEl.hidden = !msg }

    const peers = Array.isArray(s.peers) ? (s.peers as Status[]) : []
    const list = host.querySelector('[data-f="peerlist"]') as HTMLElement | null
    const none = host.querySelector('[data-f="nopeers"]') as HTMLElement | null
    if (none) none.hidden = peers.length > 0
    if (list) {
      list.innerHTML = peers.map((p) => {
        const ids = Array.isArray(p.peerIds) ? (p.peerIds as unknown[]).filter((v) => typeof v === 'string') as string[] : []
        const name = ids[0] || text(p, 'address') || text(p, 'uuid') || 'unknown peer'
        const meta = `${flag(p, 'writable') ? 'writable' : 'connecting'} · ${num(p, 'queuedChunks')} queued${num(p, 'mtu') ? ` · MTU ${num(p, 'mtu')}` : ''}`
        const picks = ids.map((id) => `<button data-pick="${esc(id)}">${esc(id.slice(0, 10))}</button>`).join(' ')
        return `<li class="fbd__peer"><strong>${esc(name)}</strong><br><span class="fbd__hint">${esc(meta)}</span>${picks ? `<div>${picks}</div>` : ''}</li>`
      }).join('')
      list.querySelectorAll('[data-pick]').forEach((el) =>
        el.addEventListener('click', () => { targetEl.value = (el as HTMLElement).dataset.pick || '' }))
    }
  }
  async function refresh() {
    try { applyStatus(await getBleStatus()) } catch (e) { append(`status failed: ${errText(e)}`) }
  }
  function errText(e: unknown): string {
    return e instanceof Error ? e.message : 'unknown error'
  }

  async function start() {
    busy = true; syncButtons()
    try {
      const room = roomEl.value.trim()
      const selfId = selfEl.value.trim()
      const hops = Number(modeEl.value) || 0
      await startBle({ room, selfId, serviceUuid: DIAG_SERVICE_UUID, hops }, (data, from) => {
        received += 1
        setField('frames', `${sent} sent · ${received} received`)
        append(`rx ${from ? from.slice(0, 10) : 'unknown'} · ${data.length}B`)
      })
      running = true
      append(`started ${hops > 0 ? 'crowd' : 'discreet'} room=${room} self=${selfId}`)
      await refresh()
    } catch (e) {
      running = false
      append(`start failed: ${errText(e)}`)
      await refresh()
    } finally { busy = false; syncButtons() }
  }
  async function stop() {
    busy = true; syncButtons()
    try { await stopBle(); running = false; append('stopped'); await refresh() }
    finally { busy = false; syncButtons() }
  }
  async function restart() {
    busy = true; syncButtons()
    try {
      append('restarting BLE')
      await stopBle(); running = false
      await new Promise((r) => window.setTimeout(r, 600))
      const room = roomEl.value.trim(); const selfId = selfEl.value.trim(); const hops = Number(modeEl.value) || 0
      await startBle({ room, selfId, serviceUuid: DIAG_SERVICE_UUID, hops }, (data, from) => {
        received += 1
        setField('frames', `${sent} sent · ${received} received`)
        append(`rx ${from ? from.slice(0, 10) : 'unknown'} · ${data.length}B`)
      })
      running = true; append('restarted'); await refresh()
    } catch (e) { running = false; append(`restart failed: ${errText(e)}`); await refresh() }
    finally { busy = false; syncButtons() }
  }
  async function send() {
    if (!running) return
    const target = targetEl.value.trim()
    const payload = payloadEl.value.trim() || 'ping'
    const data = JSON.stringify({ id: `${selfEl.value}-${Date.now()}`, text: payload, at: new Date().toISOString() })
    if (target) { await sendBle(target, data); append(`tx direct ${target.slice(0, 10)} · ${payload}`) }
    else { await broadcastBle(data); append(`tx broadcast · ${payload}`) }
    sent += 1
    setField('frames', `${sent} sent · ${received} received`)
  }

  host.querySelector('[data-act="refresh"]')?.addEventListener('click', () => void refresh())
  host.querySelector('[data-act="clear"]')?.addEventListener('click', () => { log.length = 0; const ol = host.querySelector('[data-f="log"]'); if (ol) ol.innerHTML = '' })
  startBtn.addEventListener('click', () => void start())
  restartBtn.addEventListener('click', () => void restart())
  stopBtn.addEventListener('click', () => void stop())
  sendBtn.addEventListener('click', () => void send())
  roomEl.addEventListener('input', syncButtons)
  selfEl.addEventListener('input', syncButtons)

  syncButtons()
  void refresh()
  addBleStatusListener((s) => applyStatus(s))
    .then((h) => { statusHandle = h })
    .catch(() => { /* status pushes unavailable (e.g. web) — the Refresh button still polls */ })
  window.addEventListener('pagehide', () => { statusHandle?.remove(); void stopBle() })
}
