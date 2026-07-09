// The in-app QR scanner — the join path that never leaves the installed app.
// An iPhone camera-app scan opens the BROWSER (iOS gives an installed web app
// no way to claim a link), and the browser tab keeps a SEPARATE identity from
// the home-screen app — so the easy join runs the other way round: open flock,
// scan from inside. Frames are decoded on-device (jsQR); no image, no code,
// nothing leaves the phone. The host decides what a decoded payload means.

import jsQR from 'jsqr'

export interface QrScanHost {
  /** Overlay layer the scanner mounts into (survives app re-renders). */
  layer: HTMLElement
  title: string
  /** The idle status line ("point the camera at…"). */
  hint: string
  /** Decide what to do with a decoded QR: `true` accepts it (scanner closes);
   *  a string keeps scanning and shows it as guidance (wrong-QR case). */
  onCode: (text: string) => true | string
  onClosed: () => void
}

interface ScanSession {
  host: QrScanHost
  el: HTMLElement
  stream: MediaStream | null
  timer: number
  closed: boolean
}

/** How often to try a decode. A QR needs no more than a few frames a second,
 *  and jsQR is the CPU-heavy part — gentler on a phone mid-night-out. */
const DECODE_MS = 250

let session: ScanSession | null = null

export function isQrScanOpen(): boolean {
  return session !== null
}

/** Stop everything NOW — camera, decode loop, DOM. Safe to call twice. */
export function closeQrScan(): void {
  const s = session
  if (!s || s.closed) return
  s.closed = true
  session = null
  window.clearInterval(s.timer)
  s.stream?.getTracks().forEach((t) => t.stop())
  s.el.remove()
  s.host.onClosed()
}

export async function openQrScan(host: QrScanHost): Promise<void> {
  closeQrScan()
  const el = mount(host)
  const s: ScanSession = { host, el, stream: null, timer: 0, closed: false }
  session = s
  const status = el.querySelector('#qrscan-status') as HTMLElement | null
  const video = el.querySelector('#qrscan-video') as HTMLVideoElement | null
  if (!status || !video) return
  try {
    // Rear camera by preference — scanning a friend's screen, not a selfie.
    s.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
  } catch {
    // Denied or absent camera: say so plainly and leave the words path open.
    if (!s.closed) status.textContent = 'Camera unavailable — ask them to read you the six words instead.'
    return
  }
  if (s.closed) { s.stream.getTracks().forEach((t) => t.stop()); return }
  video.srcObject = s.stream
  await video.play().catch(() => { /* interrupted by an immediate close */ })
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  s.timer = window.setInterval(() => {
    if (s.closed || !ctx || video.videoWidth === 0) return
    // Decode a downscaled frame — plenty for a QR, far kinder to the CPU.
    const scale = Math.min(1, 640 / video.videoWidth)
    canvas.width = Math.round(video.videoWidth * scale)
    canvas.height = Math.round(video.videoHeight * scale)
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const hit = jsQR(frame.data, frame.width, frame.height)
    if (!hit?.data) return
    const verdict = s.host.onCode(hit.data)
    if (verdict === true) closeQrScan()
    else status.textContent = verdict
  }, DECODE_MS)
}

const escText = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))

function mount(host: QrScanHost): HTMLElement {
  document.getElementById('qrscan-shell')?.remove()
  const tmp = document.createElement('div')
  tmp.innerHTML = `<div class="qrscan-shell" id="qrscan-shell" role="dialog" aria-modal="true" aria-label="${escText(host.title)}">
    <div class="qrscan-title">${escText(host.title)}</div>
    <div class="qrscan-view">
      <video id="qrscan-video" playsinline muted></video>
      <div class="qrscan-aperture"></div>
    </div>
    <div class="qrscan-status" id="qrscan-status">${escText(host.hint)}</div>
    <button class="btn qrscan-cancel" id="qrscan-cancel">Cancel</button>
  </div>`
  const el = tmp.firstElementChild as HTMLElement
  host.layer.appendChild(el)
  el.querySelector('#qrscan-cancel')?.addEventListener('click', () => closeQrScan())
  return el
}
