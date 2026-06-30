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
 */

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

/** IUGG mean Earth radius, in metres. */
const EARTH_RADIUS_METRES = 6_371_008.8

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

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
 * @throws {Error} If either coordinate is out of range.
 */
export function haversineMetres(a: LatLng, b: LatLng): number {
  validateLatLng(a, 'point a')
  validateLatLng(b, 'point b')
  const dLat = toRadians(b.lat - a.lat)
  const dLon = toRadians(b.lon - a.lon)
  const lat1 = toRadians(a.lat)
  const lat2 = toRadians(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(h)))
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
 * Uses planar lon/lat coordinates — accurate for the neighbourhood-scale fences
 * this is built for. Not intended for polygons that span the antimeridian or a pole.
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

  let inside = false
  for (let i = 0, j = v.length - 1; i < v.length; j = i++) {
    const xi = v[i].lon, yi = v[i].lat
    const xj = v[j].lon, yj = v[j].lat
    const intersects =
      (yi > point.lat) !== (yj > point.lat) &&
      point.lon < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi
    if (intersects) inside = !inside
  }
  return inside
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
