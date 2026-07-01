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

import { distanceFromCoords, pointInPolygon } from 'geohash-kit'

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
