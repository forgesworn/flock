// flock — minimal runtime-cache service worker.
// Makes the app installable and offline-capable for visited assets without
// needing to know Vite's hashed filenames at build time.
//
// It is also the PWA's tamper-evidence layer (docs/plans/
// 2026-07-06-verifiable-builds-completion-goal.md, workstream B): the build
// ships asset-manifest.json ({assetPath: sha256}) signed by the release key
// (asset-manifest.json.sig, same key that signs release/<build> git tags).
// This worker verifies the signature (sw-verify.js, WebCrypto Ed25519) and
// checks every manifest-listed asset it caches against its hash — a partial
// swap (one JS chunk under an otherwise-intact manifest) is refused from cache
// and surfaced to the page as a visible warning. Honest ceiling: a compelled
// host that swaps assets AND manifest AND this worker together defeats the
// check — that is why the APK is the verifiable artefact (docs/verify-apk.md)
// and the in-app copy steers at-risk users there.
importScripts('./sw-verify.js')

const CACHE = 'flock-runtime-v3'
// Offline basemap assets (glyphs/sprite under /basemap/*) live in their own cache so
// they survive a runtime-cache version bump — a saved offline map keeps its labels
// across deploys. OPFS holds the tiles themselves and the SW never touches it.
const BASEMAP_CACHE = 'flock-basemap-v1'
// Integrity bookkeeping: the last verified manifest + the sticky "this origin
// has shipped a signed manifest before" marker (its silent disappearance is
// itself suspicious).
const INTEGRITY_CACHE = 'flock-integrity-v1'
const SEEN_MARKER = './__flock-manifest-seen'

// Raw ed25519 public half of native/release-signing-key (docs/transparency/
// allowed_signers) — the ONLY key a manifest may be signed with.
const MANIFEST_PUBKEY_HEX = '8e43dc5c2de234f1c6b75bc9720fd4313f8a24bdb5e5c00f20d00ba09b075b12'
const MANIFEST_NAMESPACE = 'flock-pwa-manifest'

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k !== CACHE && k !== BASEMAP_CACHE && k !== INTEGRITY_CACHE).map((k) => caches.delete(k)))
      await self.clients.claim()
      await refreshManifest()
    })(),
  )
})

// ── Integrity: signed manifest ───────────────────────────────────────────────
// { state: 'ok', assets } | { state: 'absent' | 'bad' | 'unsupported' | 'offline' }
let manifest = null

/** Fetch + verify the signed manifest. Distinguishes a 404 ('absent' — the
 *  host isn't shipping one) from a network failure ('offline' — no evidence of
 *  anything); only 'bad' is proof of a wrong signature. Never throws. */
async function fetchManifest() {
  let mRes, sRes
  try {
    ;[mRes, sRes] = await Promise.all([
      fetch('./asset-manifest.json', { cache: 'no-store' }),
      fetch('./asset-manifest.json.sig', { cache: 'no-store' }),
    ])
  } catch {
    return { state: 'offline' }
  }
  try {
    if (!mRes.ok || !sRes.ok) return { state: 'absent' }
    const bytes = new Uint8Array(await mRes.arrayBuffer())
    const sigText = await sRes.text()
    const verdict = await self.flockVerify.verifyManifestSig(crypto.subtle, bytes, sigText, MANIFEST_PUBKEY_HEX, MANIFEST_NAMESPACE)
    // 'not-a-signature': no signature is being shipped (e.g. an unsigned
    // self-host behind an SPA fallback that serves HTML for the missing .sig)
    // — same standing as absent. 'bad' stays loud: a real SSHSIG that fails.
    if (verdict === 'not-a-signature') return { state: 'absent' }
    if (verdict !== 'ok') return { state: verdict === 'bad' ? 'bad' : 'unsupported' }
    let assets
    try { assets = JSON.parse(new TextDecoder().decode(bytes)).assets } catch { return { state: 'absent' } }
    if (!assets || typeof assets !== 'object') return { state: 'absent' }
    return { state: 'ok', assets }
  } catch {
    return { state: 'offline' }
  }
}

/** Re-load the manifest (activate + every navigation, off the response path)
 *  and keep the sticky seen-marker honest: signed-before + now-absent → warn. */
async function refreshManifest() {
  try {
    manifest = await fetchManifest()
    const cache = await caches.open(INTEGRITY_CACHE)
    if (manifest.state === 'ok') {
      await cache.put(SEEN_MARKER, new Response('1'))
    } else if (manifest.state === 'bad') {
      await alertClients('bad-signature')
    } else if (manifest.state === 'absent' && (await cache.match(SEEN_MARKER))) {
      await alertClients('manifest-missing')
    }
  } catch { /* the verifier must never become a reliability regression */ }
}

// Alerts also queue for replay: when the MISMATCHED response is the navigation
// itself (an index.html swap — the likeliest real attack), the page isn't
// listening yet when the alert fires. It announces readiness once loaded
// (main.ts) and gets everything it missed.
const pendingAlerts = []

async function alertClients(kind, path) {
  if (pendingAlerts.length < 10) pendingAlerts.push({ kind, path })
  const clients = await self.clients.matchAll({ includeUncontrolled: true })
  for (const c of clients) c.postMessage({ type: 'flock-integrity', kind, path })
}

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'flock-integrity-ready' && event.source) {
    for (const a of pendingAlerts) event.source.postMessage({ type: 'flock-integrity', kind: a.kind, path: a.path })
  }
})

/** Manifest key for a same-origin request, relative to this worker's scope. */
function assetPathOf(url) {
  const scopePath = new URL(self.registration.scope).pathname
  let rel = url.pathname.startsWith(scopePath) ? url.pathname.slice(scopePath.length) : url.pathname.replace(/^\//, '')
  if (rel === '' || rel.endsWith('/')) rel += 'index.html'
  return rel
}

/** Verify a fresh network response against the manifest, then cache it.
 *  On mismatch: re-fetch the manifest once (a deploy may have raced this
 *  response — quiet-and-retry, loud only when real), refuse to cache, and
 *  surface the warning. Serving is never blocked — the banner is the defence,
 *  a bricked app is not. */
async function verifiedPut(cache, request, res, rel) {
  try {
    if (!manifest || manifest.state === 'offline') await refreshManifest()
    if (!manifest || manifest.state !== 'ok' || !manifest.assets[rel]) {
      await cache.put(request, res)
      return
    }
    const got = await self.flockVerify.sha256Hex(crypto.subtle, new Uint8Array(await res.clone().arrayBuffer()))
    if (got === manifest.assets[rel]) {
      await cache.put(request, res)
      return
    }
    const fresh = await fetchManifest()
    if (fresh.state === 'ok') {
      manifest = fresh
      if (!fresh.assets[rel]) return // no longer covered — don't cache, don't alarm
      if (got === fresh.assets[rel]) {
        await cache.put(request, res)
        return
      }
      await alertClients('asset-mismatch', rel) // confirmed against a fresh, signature-valid manifest
    } else if (fresh.state === 'bad') {
      await alertClients('bad-signature')
    }
    // absent/offline/unsupported: can't re-confirm — skip caching, stay quiet
  } catch {
    try { await cache.put(request, res) } catch { /* ignore */ }
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  // Never touch relay/websocket or cross-origin (tiles, etc.) traffic.
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // Network-first for navigations (HTML) so app updates are picked up;
  // fall back to cache when offline. Vite asset filenames are content-hashed,
  // so referencing fresh HTML always pulls the right (cacheable) assets.
  if (request.mode === 'navigate') {
    event.waitUntil(refreshManifest())
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE)
        try {
          // `reload` bypasses the HTTP cache so a deploy is picked up even when
          // index.html carries no Cache-Control (otherwise the SW's network-first
          // fetch can be served a stale HTML from the browser cache, pinning the
          // old hashed CSS/JS — which silently kept a broken build live).
          const res = await fetch(request, { cache: 'reload' })
          if (res && res.status === 200) await verifiedPut(cache, request, res.clone(), assetPathOf(url))
          return res
        } catch {
          return (await cache.match(request)) || (await cache.match('./index.html')) || Response.error()
        }
      })(),
    )
    return
  }

  // Cache-first for hashed assets (immutable), revalidating in the background.
  // Basemap glyphs/sprite go to the deploy-surviving cache; everything else runtime.
  event.respondWith(
    (async () => {
      const cache = await caches.open(url.pathname.startsWith('/basemap/') ? BASEMAP_CACHE : CACHE)
      const cached = await cache.match(request)
      const network = fetch(request)
        .then(async (res) => {
          if (res && res.status === 200 && res.type === 'basic') await verifiedPut(cache, request, res.clone(), assetPathOf(url))
          return res
        })
        .catch(() => cached)
      return cached || network
    })(),
  )
})
