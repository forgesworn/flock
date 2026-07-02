#!/usr/bin/env node
// flock — offline-basemap extract service (local dev now; deployable to the host later).
//
//   POST /api/extract   { "bbox": [minLon, minLat, maxLon, maxLat], "maxzoom": 15 }
//     → streams a PMTiles archive clipped to that bbox from the Protomaps daily build.
//
// This is the server half of "save this area" (see app/src/offlineArea.ts). The
// browser only ever talks to *this origin*; the service — not the user — range-reads
// the remote planet build, so the tile CDN never sees a user's IP or area of interest.
//
// Privacy: the bbox is NEVER logged; responses are `no-store`. Keep it that way.
//
// Env: PORT (8788) · GO_PMTILES_BIN (`go-pmtiles` on PATH) · FLOCK_PMTILES_SOURCE
//      (default: newest https://build.protomaps.com/<YYYYMMDD>.pmtiles) ·
//      EXTRACT_MAXZOOM cap (15) · EXTRACT_MAX_SPAN_KM guard (60).

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOST = process.env.HOST ?? '127.0.0.1' // localhost-only; Caddy reverse-proxies to it
const PORT = Number(process.env.PORT ?? 8788)
const BIN = process.env.GO_PMTILES_BIN ?? 'go-pmtiles'
const MAXZOOM_CAP = Number(process.env.EXTRACT_MAXZOOM ?? 15)
const MAX_SPAN_KM = Number(process.env.EXTRACT_MAX_SPAN_KM ?? 60)
// The endpoint is public, so bound the blast radius: cap concurrent extracts (each
// spawns go-pmtiles + range-reads the remote build) so a flood can't exhaust the
// shared box. Excess requests get 429 rather than piling up.
const MAX_CONCURRENT = Number(process.env.EXTRACT_MAX_CONCURRENT ?? 3)
let inflight = 0

// Per-IP rate limit — an extract is heavyweight AND its bbox ≈ someone's home, so
// abuse is both a DoS and a privacy probe. Sliding window, in-memory only, keyed by
// a per-process salted hash of the client IP: nothing is persisted or logged, and
// even a memory inspection reveals no addresses (no-log posture holds).
const RATE_MAX = Number(process.env.EXTRACT_RATE_MAX ?? 6)
const RATE_WINDOW_MS = Number(process.env.EXTRACT_RATE_WINDOW_S ?? 600) * 1000
const rateSalt = randomBytes(16)
const rate = new Map() // ipHash → recent request timestamps
function rateLimited(req) {
  const ip = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || ''
  const key = createHash('sha256').update(rateSalt).update(ip).digest('base64')
  const now = Date.now()
  const hits = (rate.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS)
  if (hits.length >= RATE_MAX) { rate.set(key, hits); return true }
  hits.push(now)
  rate.set(key, hits)
  if (rate.size > 10_000) { // prune idle buckets so the map can't grow unbounded
    for (const [k, v] of rate) if (!v.some((t) => now - t < RATE_WINDOW_MS)) rate.delete(k)
  }
  return false
}

// Resolve the newest daily planet build once, then reuse for the day.
let cached = null // { url, day: 'YYYYMMDD' }
async function resolveSource() {
  if (process.env.FLOCK_PMTILES_SOURCE) return process.env.FLOCK_PMTILES_SOURCE
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  if (cached && cached.day === day) return cached.url
  const base = new Date()
  for (let i = 0; i < 14; i++) {
    const d = new Date(base.getTime() - i * 864e5).toISOString().slice(0, 10).replace(/-/g, '')
    const url = `https://build.protomaps.com/${d}.pmtiles`
    try {
      const res = await fetch(url, { method: 'HEAD' })
      if (res.ok) { cached = { url, day }; return url }
    } catch { /* try the previous day */ }
  }
  throw new Error('no Protomaps daily build reachable in the last 14 days')
}

function spanKm([minLon, minLat, maxLon, maxLat]) {
  const midLat = (minLat + maxLat) / 2
  return {
    w: (maxLon - minLon) * 111.32 * Math.cos((midLat * Math.PI) / 180),
    h: (maxLat - minLat) * 111.32,
  }
}

function validateBody(body) {
  const bbox = body?.bbox
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every((n) => Number.isFinite(n))) {
    return { error: 'bbox must be [minLon, minLat, maxLon, maxLat]' }
  }
  const [minLon, minLat, maxLon, maxLat] = bbox
  if (minLon >= maxLon || minLat >= maxLat) return { error: 'bbox min must be < max' }
  if (minLat < -85 || maxLat > 85 || minLon < -180 || maxLon > 180) return { error: 'bbox out of range' }
  const { w, h } = spanKm(bbox)
  if (Math.max(w, h) > MAX_SPAN_KM) return { error: `area too large (${Math.round(Math.max(w, h))} km > ${MAX_SPAN_KM} km cap)` }
  const maxzoom = Math.min(Number.isFinite(body.maxzoom) ? body.maxzoom : MAXZOOM_CAP, MAXZOOM_CAP)
  return { bbox, maxzoom }
}

async function extract(bbox, maxzoom) {
  const source = await resolveSource()
  const dir = await mkdtemp(join(tmpdir(), 'flock-extract-'))
  const out = join(dir, 'area.pmtiles')
  try {
    await new Promise((resolve, reject) => {
      const args = ['extract', source, out, `--bbox=${bbox.join(',')}`, `--maxzoom=${maxzoom}`, '--quiet']
      const p = spawn(BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] })
      let err = ''
      p.stderr.on('data', (b) => { err += b })
      p.on('error', reject)
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`go-pmtiles exit ${code}: ${err.slice(0, 200)}`))))
    })
    return await readFile(out)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (req.method === 'GET' && url.pathname === '/healthz') { res.writeHead(200).end('ok'); return }
  if (req.method !== 'POST' || url.pathname !== '/api/extract') { res.writeHead(404).end(); return }

  let raw = ''
  req.on('data', (c) => { raw += c; if (raw.length > 1e4) req.destroy() })
  req.on('end', async () => {
    let parsed
    try { parsed = validateBody(JSON.parse(raw || '{}')) } catch { parsed = { error: 'invalid JSON' } }
    if (parsed.error) { res.writeHead(parsed.error.includes('too large') ? 413 : 400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: parsed.error })); return }
    // After validation (a fat-fingered client isn't locked out by 400s), before work.
    if (rateLimited(req)) { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' }).end(JSON.stringify({ error: 'too many saves from this connection — try again in a few minutes' })); return }
    if (inflight >= MAX_CONCURRENT) { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '5' }).end(JSON.stringify({ error: 'busy — try again shortly' })); return }
    inflight++
    try {
      const bytes = await extract(parsed.bbox, parsed.maxzoom) // NB: bbox intentionally not logged
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'content-length': bytes.length }).end(bytes)
    } catch (e) {
      res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(e.message || e) }))
    } finally {
      inflight--
    }
  })
})

server.listen(PORT, HOST, () => console.error(`flock extract service on ${HOST}:${PORT} (bin=${BIN}, maxzoom≤${MAXZOOM_CAP}, span≤${MAX_SPAN_KM}km, maxConcurrent=${MAX_CONCURRENT}, rate=${RATE_MAX}/${RATE_WINDOW_MS / 1000}s per IP)`))
