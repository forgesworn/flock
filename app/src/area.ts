// Bounding box for the local basemap "save this area" flow (see basemap.ts and
// ROADMAP Phase G). Pure: the union of a circle's safe zones + no-report zones,
// padded by a buffer, is the region we extract an offline PMTiles basemap for.
// A transport/edge concern (not library policy), so it lives in the app.

import type { Geofence, NoReportZone } from '@forgesworn/flock'

export interface BBox { minLon: number; minLat: number; maxLon: number; maxLat: number }

const METRES_PER_DEG_LAT = 111_320
const cosLat = (lat: number): number => Math.cos((lat * Math.PI) / 180)

function fenceBBox(f: Geofence): BBox {
  if (f.kind === 'circle') {
    const dLat = f.radiusMetres / METRES_PER_DEG_LAT
    const dLon = f.radiusMetres / (METRES_PER_DEG_LAT * cosLat(f.centre.lat))
    return { minLon: f.centre.lon - dLon, minLat: f.centre.lat - dLat, maxLon: f.centre.lon + dLon, maxLat: f.centre.lat + dLat }
  }
  const lats = f.vertices.map((v) => v.lat)
  const lons = f.vertices.map((v) => v.lon)
  return { minLon: Math.min(...lons), minLat: Math.min(...lats), maxLon: Math.max(...lons), maxLat: Math.max(...lats) }
}

/**
 * The bounding box to fetch an offline basemap for: the union of every safe zone
 * and no-report zone, padded by `bufferMetres` (default 2 km). Returns null when
 * there is nothing to bound. Does not handle antimeridian crossing (UK/EU never do).
 */
export function areaBounds(
  fences: Geofence[],
  zones: NoReportZone[] = [],
  opts: { bufferMetres?: number } = {},
): BBox | null {
  const all: Geofence[] = [...fences, ...zones.map((z) => z.area)]
  if (all.length === 0) return null
  const buffer = opts.bufferMetres ?? 2000

  const b = all.reduce<BBox>((acc, f) => {
    const fb = fenceBBox(f)
    return {
      minLon: Math.min(acc.minLon, fb.minLon),
      minLat: Math.min(acc.minLat, fb.minLat),
      maxLon: Math.max(acc.maxLon, fb.maxLon),
      maxLat: Math.max(acc.maxLat, fb.maxLat),
    }
  }, fenceBBox(all[0]))

  const midLat = (b.minLat + b.maxLat) / 2
  const padLat = buffer / METRES_PER_DEG_LAT
  const padLon = buffer / (METRES_PER_DEG_LAT * cosLat(midLat))
  return { minLon: b.minLon - padLon, minLat: b.minLat - padLat, maxLon: b.maxLon + padLon, maxLat: b.maxLat + padLat }
}

/** Span (width, height) of a bbox in metres — for a "this area is too large" guard. */
export function bboxSpanMetres(b: BBox): { widthMetres: number; heightMetres: number } {
  const midLat = (b.minLat + b.maxLat) / 2
  return {
    widthMetres: (b.maxLon - b.minLon) * METRES_PER_DEG_LAT * cosLat(midLat),
    heightMetres: (b.maxLat - b.minLat) * METRES_PER_DEG_LAT,
  }
}

/** Format for a go-pmtiles extract `--bbox=min_lon,min_lat,max_lon,max_lat`. */
export function bboxToExtractArg(b: BBox): string {
  return [b.minLon, b.minLat, b.maxLon, b.maxLat].join(',')
}

/** Whether a point falls within a bbox — used to flag members outside a saved map. */
export function bboxContains(b: BBox, lat: number, lon: number): boolean {
  return lon >= b.minLon && lon <= b.maxLon && lat >= b.minLat && lat <= b.maxLat
}
