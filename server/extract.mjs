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
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.env.PORT ?? 8788)
const BIN = process.env.GO_PMTILES_BIN ?? 'go-pmtiles'
const MAXZOOM_CAP = Number(process.env.EXTRACT_MAXZOOM ?? 15)
const MAX_SPAN_KM = Number(process.env.EXTRACT_MAX_SPAN_KM ?? 60)

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
    try {
      const bytes = await extract(parsed.bbox, parsed.maxzoom) // NB: bbox intentionally not logged
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'content-length': bytes.length }).end(bytes)
    } catch (e) {
      res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(e.message || e) }))
    }
  })
})

server.listen(PORT, () => console.error(`flock extract service on :${PORT} (bin=${BIN}, maxzoom≤${MAXZOOM_CAP}, span≤${MAX_SPAN_KM}km)`))
