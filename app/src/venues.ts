// Venue search for the fair meeting point — the ONE network call in the flow, and
// it sends only a bounding box, never participant locations. Reverse-proxied
// same-origin (`/overpass/*`) to OSM Overpass, mirroring the tiles + Nominatim
// proxies, so the query reaches Overpass from the host, not the user's IP. The
// kit sends the search polygon's bbox; the group's coordinates never leave the
// device. Best-effort: any failure (proxy down, rate-limited, no matches) returns
// [] and the caller keeps the on-device centroid — venues only ever enrich, never
// gate. See docs/plans/2026-07-01-fair-meeting-point.md.

import { searchVenues, type Venue, type VenueType, type GeoJSONPolygon } from 'rendezvous-kit'

// Night-out-context venue types (design doc): where a group actually meets.
export const MEETING_VENUE_TYPES: VenueType[] = ['pub', 'bar', 'cafe', 'restaurant', 'fast_food']

// Same-origin by default (proxied → Overpass); overridable at build time so
// self-hosters can point at their own endpoint. An ABSOLUTE http(s) URL is
// required — the kit validates it (a bare `/overpass/...` path would be rejected).
function overpassEndpoint(): string {
  const override = import.meta.env.VITE_OVERPASS_URL
  if (override) return override
  const origin = typeof location !== 'undefined' ? location.origin : 'http://localhost'
  return `${origin}/overpass/api/interpreter`
}

export interface VenueSearchOptions {
  venueTypes?: VenueType[]
  limit?: number
  /** Absolute Overpass interpreter URL. Defaults to the same-origin proxy. */
  endpoint?: string
}

/**
 * Search real venues within a region via the same-origin Overpass proxy.
 *
 * Only the region's bounding box leaves the device — never participant locations
 * (the kit derives the bbox from the polygon and queries by area). Returns [] on
 * any error (proxy down / rate-limited / no matches) so the caller falls back to
 * the on-device centroid; venues enrich the suggestion, they never block it.
 */
export async function searchMeetingVenues(region: GeoJSONPolygon, opts: VenueSearchOptions = {}): Promise<Venue[]> {
  try {
    return await searchVenues(region, opts.venueTypes ?? MEETING_VENUE_TYPES, opts.endpoint ?? overpassEndpoint(), opts.limit ?? 30)
  } catch {
    return []
  }
}
