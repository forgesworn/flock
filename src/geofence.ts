/**
 * On-device geofence evaluation for flock.
 *
 * Decentralised by design: each device evaluates its own fence membership
 * locally and never sends raw coordinates anywhere. A breach (leaving the
 * fence) is the trigger that flips the location-emission policy from
 * "withheld" to "disclose".
 *
 * Pure, synchronous, deterministic — no I/O, no crypto, no mutation.
 *
 * Two fence shapes are supported:
 * - **circle**  — a centre point + radius in metres (cheap; the common "safe zone").
 * - **polygon** — an ordered ring of vertices (arbitrary areas; ray-casting test).
 *
 * Geo maths (haversine distance, point-in-polygon) is delegated to `geohash-kit`
 * — our single home for geohash/geo primitives. This module owns the fence
 * types, coordinate validation, and the breach decision; the library owns the
 * maths (one tested, benchmarked implementation instead of a second copy).
 */

import { distanceFromCoords, pointInPolygon, boundsFullyInsidePolygon, boundsOverlapsPolygon, type GeohashBounds } from 'geohash-kit'

/** A WGS-84 coordinate in decimal degrees. */
export interface LatLng {
  /** Latitude in decimal degrees, -90..90. */
  lat: number
  /** Longitude in decimal degrees, -180..180. */
  lon: number
}

/** A circular safe zone: everything within `radiusMetres` of `centre`. */
export interface CircleGeofence {
  kind: 'circle'
  centre: LatLng
  radiusMetres: number
}

/** A polygonal safe zone defined by an ordered ring of vertices. */
export interface PolygonGeofence {
  kind: 'polygon'
  /** Ordered vertices; the ring is closed implicitly (last → first). */
  vertices: LatLng[]
}

/** Any supported geofence shape. */
export type Geofence = CircleGeofence | PolygonGeofence

function validateLatLng(p: LatLng, label: string): void {
  if (!p || typeof p.lat !== 'number' || typeof p.lon !== 'number' ||
      Number.isNaN(p.lat) || Number.isNaN(p.lon)) {
    throw new Error(`Invalid ${label}: lat and lon must be numbers`)
  }
  if (p.lat < -90 || p.lat > 90) {
    throw new Error(`Invalid ${label}: lat must be between -90 and 90, got ${p.lat}`)
  }
  if (p.lon < -180 || p.lon > 180) {
    throw new Error(`Invalid ${label}: lon must be between -180 and 180, got ${p.lon}`)
  }
}

/**
 * Great-circle distance between two coordinates, in metres (haversine).
 *
 * The haversine maths is delegated to geohash-kit's `distanceFromCoords`; this
 * wrapper keeps the WGS-84 range validation, since the library only guards
 * against non-finite inputs, not out-of-range latitude/longitude.
 *
 * @throws {Error} If either coordinate is out of range.
 */
export function haversineMetres(a: LatLng, b: LatLng): number {
  validateLatLng(a, 'point a')
  validateLatLng(b, 'point b')
  return distanceFromCoords(a.lat, a.lon, b.lat, b.lon)
}

/**
 * True if `point` lies within (or exactly on the edge of) the circular fence.
 *
 * @throws {Error} If the radius is not a positive number or coordinates are invalid.
 */
export function isInsideCircle(point: LatLng, fence: CircleGeofence): boolean {
  if (!Number.isFinite(fence.radiusMetres) || fence.radiusMetres <= 0) {
    throw new Error('Invalid circle geofence: radiusMetres must be a positive number')
  }
  validateLatLng(fence.centre, 'circle centre')
  return haversineMetres(point, fence.centre) <= fence.radiusMetres
}

/**
 * True if `point` lies inside the polygon (ray-casting / even-odd rule).
 *
 * The ray-casting is delegated to geohash-kit's `pointInPolygon` (planar lon/lat,
 * `[lon, lat]` order); this wrapper keeps the shape and coordinate validation.
 * Accurate for the neighbourhood-scale fences this is built for — not intended
 * for polygons that span the antimeridian or a pole.
 *
 * @throws {Error} If the polygon has fewer than 3 vertices or any coordinate is invalid.
 */
export function isInsidePolygon(point: LatLng, fence: PolygonGeofence): boolean {
  const v = fence.vertices
  if (!Array.isArray(v) || v.length < 3) {
    throw new Error('Invalid polygon geofence: need at least 3 vertices')
  }
  validateLatLng(point, 'point')
  for (const vertex of v) validateLatLng(vertex, 'polygon vertex')

  return pointInPolygon(
    [point.lon, point.lat],
    v.map((vertex): [number, number] => [vertex.lon, vertex.lat]),
  )
}

/**
 * True if `point` is inside `fence` (dispatches on fence kind).
 *
 * @throws {Error} If the fence kind is unknown or a coordinate is invalid.
 */
export function isInside(point: LatLng, fence: Geofence): boolean {
  switch (fence.kind) {
    case 'circle':
      return isInsideCircle(point, fence)
    case 'polygon':
      return isInsidePolygon(point, fence)
    default: {
      const exhaustive: never = fence
      throw new Error(`Unknown geofence kind: ${JSON.stringify(exhaustive)}`)
    }
  }
}

/**
 * True if `point` represents a **breach** — i.e. it lies outside the fence.
 *
 * A breach is the event that flips the location-emission policy from "withheld"
 * to "disclose" (publish an encrypted beacon to the group).
 *
 * @throws {Error} If the fence kind is unknown or a coordinate is invalid.
 */
export function isBreach(point: LatLng, fence: Geofence): boolean {
  return !isInside(point, fence)
}

/** How a fix sits relative to the safe zones once its positional uncertainty is
 *  taken into account. Only a confident `outside` should fire a breach. */
export type Containment = 'inside' | 'outside' | 'uncertain'

function validateAccuracy(accuracyMetres: number): void {
  if (!Number.isFinite(accuracyMetres) || accuracyMetres < 0) {
    throw new Error(`Invalid accuracyMetres: must be a finite number >= 0, got ${accuracyMetres}`)
  }
}

/** Axis-aligned box circumscribing the uncertainty disc (point ± accuracy), as a
 *  `GeohashBounds` so the polygon predicates can be reused. A box slightly
 *  over-approximates the disc — erring toward `uncertain`, the fail-safe side. */
function uncertaintyBounds(point: LatLng, accuracyMetres: number): GeohashBounds {
  const dLat = accuracyMetres / 111_320
  const dLon = accuracyMetres / (111_320 * Math.cos((point.lat * Math.PI) / 180))
  return { minLat: point.lat - dLat, maxLat: point.lat + dLat, minLon: point.lon - dLon, maxLon: point.lon + dLon }
}

/** Whether the uncertainty disc lies wholly inside / wholly outside a single fence. */
function fenceContainment(point: LatLng, accuracyMetres: number, fence: Geofence): { fullyInside: boolean; fullyOutside: boolean } {
  if (fence.kind === 'circle') {
    if (!Number.isFinite(fence.radiusMetres) || fence.radiusMetres <= 0) {
      throw new Error('Invalid circle geofence: radiusMetres must be a positive number')
    }
    validateLatLng(fence.centre, 'circle centre')
    const d = haversineMetres(point, fence.centre)
    return { fullyInside: d + accuracyMetres <= fence.radiusMetres, fullyOutside: d - accuracyMetres >= fence.radiusMetres }
  }
  const v = fence.vertices
  if (!Array.isArray(v) || v.length < 3) throw new Error('Invalid polygon geofence: need at least 3 vertices')
  validateLatLng(point, 'point')
  for (const vertex of v) validateLatLng(vertex, 'polygon vertex')
  const ring = v.map((vertex): [number, number] => [vertex.lon, vertex.lat])
  // A zero-radius disc is a crisp point — avoid a degenerate (zero-area) box.
  if (accuracyMetres <= 0) {
    const inside = pointInPolygon([point.lon, point.lat], ring)
    return { fullyInside: inside, fullyOutside: !inside }
  }
  const box = uncertaintyBounds(point, accuracyMetres)
  return { fullyInside: boundsFullyInsidePolygon(box, ring), fullyOutside: !boundsOverlapsPolygon(box, ring) }
}

/**
 * Classify a fix — with its positional uncertainty radius (e.g. the browser's
 * `GeolocationCoordinates.accuracy`) — against the **union** of safe zones:
 *
 *  - `inside`    — the uncertainty disc lies wholly within some fence (confidently safe)
 *  - `outside`   — it lies wholly beyond *every* fence (a confident breach)
 *  - `uncertain` — it straddles a boundary; neither can yet be asserted
 *
 * This is the fail-safe wrapper around the boolean `isBreach`: only `outside`
 * should fire a breach, so an imprecise fix near a fence edge never cries wolf —
 * and, escalated to a sharper fix by the caller, never silently misses one. With
 * `accuracyMetres` 0 it collapses to a crisp inside/outside. With no fences there
 * is nothing to be inside → `outside` (mirrors `isWithinAnyFence` = false).
 *
 * @throws {Error} If accuracy is negative/non-finite, or a fence/coordinate is invalid.
 */
export function classifyContainment(point: LatLng, accuracyMetres: number, fences: Geofence[]): Containment {
  validateLatLng(point, 'point')
  validateAccuracy(accuracyMetres)
  let allFullyOutside = true
  for (const fence of fences) {
    const { fullyInside, fullyOutside } = fenceContainment(point, accuracyMetres, fence)
    if (fullyInside) return 'inside'
    if (!fullyOutside) allFullyOutside = false
  }
  return allFullyOutside ? 'outside' : 'uncertain'
}
