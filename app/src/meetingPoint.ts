// Fair meeting point — the *where* of Phase F, run at the app edge over rendezvous-kit.
//
// "Some of us are in one bar, some in another — where do we all go?" We compute a
// fair point ENTIRELY on-device: each person's reachable area (a radius isochrone)
// is intersected, and the centre of the overlap is the fair midpoint. Member
// coordinates never leave the device for the maths, and there is NO network call.
//
// Why we compose the pipeline ourselves rather than calling rendezvous-kit's
// `findRendezvous`: that function always calls `searchVenues` against the default
// public Overpass endpoint (no injectable URL) — a third-party leak we won't take.
// We use the kit's geo primitives (circleToPolygon / intersectPolygons / centroid)
// and keep the network boundary in our own hands (venue search, via a same-origin
// proxy, arrives in a later slice). See docs/plans/2026-07-01-fair-meeting-point.md.

import { distanceFromCoords } from 'geohash-kit'
import {
  circleToPolygon, intersectPolygons, centroid,
  type LatLon, type TransportMode, type FairnessStrategy,
  type RoutingEngine, type Isochrone, type RouteMatrix, type RendezvousSuggestion, type Venue,
} from 'rendezvous-kit'

// Straight-line speeds mirror @forgesworn/flock/rendezvous's SPEED_KMH (flock's 'transit' is
// the kit's 'public_transit'), so a meeting-point ETA matches the set-rendezvous one.
const SPEED_KMH: Record<TransportMode, number> = { walk: 5, cycle: 15, drive: 30, public_transit: 20 }

const kmBetween = (a: LatLon, b: LatLon): number => distanceFromCoords(a.lat, a.lon, b.lat, b.lon) / 1000
const etaMinutes = (a: LatLon, b: LatLon, mode: TransportMode): number => (kmBetween(a, b) / SPEED_KMH[mode]) * 60

/**
 * flock's on-device routing engine: a radius isochrone + a haversine travel-time
 * matrix. Pure, offline, deterministic — coordinates never leave the device. A real
 * routing engine (Valhalla/ORS) can be swapped in behind this same interface later
 * for road-accurate times; it must stay opt-in, never a silent third-party fallback.
 */
export const onDeviceEngine: RoutingEngine = {
  name: 'flock-on-device',
  computeIsochrone(origin: LatLon, mode: TransportMode, timeMinutes: number): Promise<Isochrone> {
    const radiusMetres = ((SPEED_KMH[mode] * timeMinutes) / 60) * 1000
    return Promise.resolve({ origin, mode, timeMinutes, polygon: circleToPolygon([origin.lon, origin.lat], radiusMetres) })
  },
  computeRouteMatrix(origins: LatLon[], destinations: LatLon[], mode: TransportMode): Promise<RouteMatrix> {
    const entries = []
    for (let oi = 0; oi < origins.length; oi++) {
      for (let di = 0; di < destinations.length; di++) {
        const distanceKm = kmBetween(origins[oi], destinations[di])
        entries.push({ originIndex: oi, destinationIndex: di, durationMinutes: (distanceKm / SPEED_KMH[mode]) * 60, distanceKm })
      }
    }
    return Promise.resolve({ origins, destinations, entries })
  },
  computeRoute(): Promise<never> {
    return Promise.reject(new Error('on-device engine computes no route geometry'))
  },
}

export interface MeetingOptions {
  mode?: TransportMode
  /** Reachability budget for the isochrones (minutes). Default 30. */
  maxTimeMinutes?: number
  fairness?: FairnessStrategy
}

/** Lower is fairer. `min_max` = worst-case time; `min_total` = sum; `min_variance` = spread. */
function fairnessScore(times: number[], strategy: FairnessStrategy): number {
  if (strategy === 'min_total') return times.reduce((s, t) => s + t, 0)
  if (strategy === 'min_variance') {
    const mean = times.reduce((s, t) => s + t, 0) / times.length
    return times.reduce((s, t) => s + (t - mean) ** 2, 0) / times.length
  }
  return Math.max(...times)
}

const pointsCentroid = (points: LatLon[]): { lat: number; lon: number } => ({
  lat: points.reduce((s, p) => s + p.lat, 0) / points.length,
  lon: points.reduce((s, p) => s + p.lon, 0) / points.length,
})

/**
 * Suggest a fair meeting point for a group, computed entirely on-device.
 *
 * Centroid-first: the fair point is the centre of the region everyone can reach
 * within the time budget (the intersection of their isochrones) — or, when those
 * don't overlap, the centroid of the group. Returns a single suggestion for now;
 * a later slice adds real venues (via a same-origin Overpass proxy) around this area.
 *
 * @throws if fewer than two participants are supplied.
 */
export async function suggestMeetingPoint(
  participants: LatLon[],
  opts: MeetingOptions = {},
  engine: RoutingEngine = onDeviceEngine,
): Promise<RendezvousSuggestion[]> {
  if (participants.length < 2) throw new Error('Need at least two people to find a meeting point.')
  const mode = opts.mode ?? 'walk'
  const maxTimeMinutes = opts.maxTimeMinutes ?? 30
  const fairness = opts.fairness ?? 'min_max'

  const isochrones = await Promise.all(participants.map((p) => engine.computeIsochrone(p, mode, maxTimeMinutes)))
  const region = intersectPolygons(isochrones.map((i) => i.polygon))
  const point = region ? centroid(region) : pointsCentroid(participants)

  const times = participants.map((p) => etaMinutes(point, p, mode))
  const travelTimes: Record<string, number> = {}
  participants.forEach((p, i) => { travelTimes[p.label ?? `p${i}`] = times[i] })

  return [{
    venue: { name: 'Fair midpoint', lat: point.lat, lon: point.lon, venueType: 'centroid' },
    travelTimes,
    fairnessScore: fairnessScore(times, fairness),
  }]
}

/**
 * Rank real venues by fairness for a group — computed entirely on-device. For each
 * venue we compute every person's as-the-crow-flies ETA (the same maths as the
 * centroid) and a fairness score, then sort fairest-first, so `[0]` is the best
 * place everyone can reach. The venue *search* (the only network call) happens at
 * the caller; this stays pure/offline. Returns [] when there are no venues, so the
 * caller falls back to the centroid suggestion.
 */
export function rankVenues(participants: LatLon[], venues: Venue[], opts: MeetingOptions = {}): RendezvousSuggestion[] {
  const mode = opts.mode ?? 'walk'
  const fairness = opts.fairness ?? 'min_max'
  return venues
    .map((v) => {
      const times = participants.map((p) => etaMinutes({ lat: v.lat, lon: v.lon }, p, mode))
      const travelTimes: Record<string, number> = {}
      participants.forEach((p, i) => { travelTimes[p.label ?? `p${i}`] = times[i] })
      return { venue: v, travelTimes, fairnessScore: fairnessScore(times, fairness) }
    })
    .sort((a, b) => a.fairnessScore - b.fairnessScore)
}
