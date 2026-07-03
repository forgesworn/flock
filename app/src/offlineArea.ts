// "Save this area" — download a circle's offline vector basemap once and keep it in
// OPFS, so the map then renders from a local file with **zero** network calls at view
// time (no when/where-you-look leak) and works offline. See basemap.ts / ROADMAP Phase G.
//
// Flow: areaBounds(zones) → POST /api/extract (server-side clip of the Protomaps build,
// so the tile CDN never sees the user) → OPFS → a maplibre style backed by a pmtiles
// FileSource. The browser only ever talks to this origin.

import { PMTiles, FileSource } from 'pmtiles'
import type maplibregl from 'maplibre-gl'
import { areaBounds, type BBox } from './area'
import { registerPmtilesProtocol, pmtilesStyle } from './basemap'
import type { Geofence, NoReportZone } from '@forgesworn/flock'

const opfsName = (circleId: string): string => `flock-basemap-${circleId}.pmtiles`

// Same-origin by default (proxied → extract service); overridable at build time
// for the native shell (no same-origin server inside the APK) and self-hosters.
const EXTRACT_URL = import.meta.env.VITE_EXTRACT_URL || '/api/extract'

/** OPFS is the durable, near-native store for the (few-MB) basemap file. */
function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory()
}

/** Download the offline basemap for a circle's area and persist it to OPFS.
 *  Returns the saved size, or null if the circle has no area to bound. */
export async function saveArea(circleId: string, fences: Geofence[], zones: NoReportZone[] = []): Promise<{ bytes: number } | null> {
  const bbox = areaBounds(fences, zones, { bufferMetres: 2000 })
  if (!bbox) return null
  const res = await fetch(EXTRACT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bbox: [bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat], maxzoom: 15 }),
  })
  if (!res.ok) throw new Error(`extract failed (${res.status})`)
  const buf = await res.arrayBuffer()
  const root = await opfsRoot()
  const fh = await root.getFileHandle(opfsName(circleId), { create: true })
  const w = await fh.createWritable()
  await w.write(buf)
  await w.close()
  try { await navigator.storage.persist?.() } catch { /* best effort — reduces eviction */ }
  return { bytes: buf.byteLength }
}

/** The saved basemap's size for this circle, or null if none is saved. */
export async function savedAreaInfo(circleId: string): Promise<{ bytes: number } | null> {
  try {
    const fh = await (await opfsRoot()).getFileHandle(opfsName(circleId))
    return { bytes: (await fh.getFile()).size }
  } catch { return null }
}

/** The saved basemap's covered bounds (from the archive header), or null if none is
 *  saved — used to flag members who fall outside the offline map. */
export async function savedAreaBBox(circleId: string): Promise<BBox | null> {
  try {
    const fh = await (await opfsRoot()).getFileHandle(opfsName(circleId))
    const h = await new PMTiles(new FileSource(await fh.getFile())).getHeader()
    return { minLon: h.minLon, minLat: h.minLat, maxLon: h.maxLon, maxLat: h.maxLat }
  } catch { return null }
}

/** Forget a circle's saved basemap. */
export async function removeSavedArea(circleId: string): Promise<void> {
  try { await (await opfsRoot()).removeEntry(opfsName(circleId)) } catch { /* already gone */ }
}

/** A maplibre style backed by the circle's OPFS basemap, or null if none is saved.
 *  Registers the archive with the shared pmtiles protocol (keyed by file name). */
export async function savedAreaStyle(circleId: string): Promise<maplibregl.StyleSpecification | null> {
  let file: File
  try {
    const fh = await (await opfsRoot()).getFileHandle(opfsName(circleId))
    file = await fh.getFile()
  } catch { return null }
  registerPmtilesProtocol().add(new PMTiles(new FileSource(file)))
  return pmtilesStyle(file.name) // → pmtiles://flock-basemap-<circle>.pmtiles, matches FileSource.getKey()
}
