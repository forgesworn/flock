// Geocoding via OSM Nominatim — privacy-preserving (NOT Google). Served
// **same-origin** (`/nominatim/*`) by default, reverse-proxied by the host so the
// literal place-name query reaches Nominatim from the host, not the user's IP.
// Only hit when a user deliberately sets a rendezvous by name/address — never
// continuously. Override VITE_NOMINATIM_URL to point at a Nominatim directly.

const NOMINATIM = import.meta.env.VITE_NOMINATIM_URL || '/nominatim'

export interface GeocodeResult { lat: number; lon: number; address: string }

/** Resolve a name/address to coordinates + a full display address. Null on miss/error. */
export async function geocode(query: string): Promise<GeocodeResult | null> {
  const q = query.trim()
  if (!q) return null
  try {
    const res = await fetch(`${NOMINATIM}/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`, {
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return null
    const arr = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>
    if (!arr.length) return null
    return { lat: parseFloat(arr[0].lat), lon: parseFloat(arr[0].lon), address: arr[0].display_name }
  } catch {
    return null
  }
}

/**
 * Resolve coordinates to a display address (taxi-friendly) — used when a
 * rendezvous is picked on the map rather than typed. Best-effort and **bounded**
 * (5 s): a slow or missing geocoder must never block setting the meeting point,
 * so a null just means "no street address", never a failure. Same-origin like
 * `geocode` — the coordinates reach Nominatim from the host, not the user's IP.
 */
export async function reverseGeocode(lat: number, lon: number): Promise<GeocodeResult | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  try {
    const res = await fetch(`${NOMINATIM}/reverse?format=jsonv2&lat=${lat}&lon=${lon}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const o = (await res.json()) as { display_name?: string } | null
    if (!o?.display_name) return null
    return { lat, lon, address: o.display_name }
  } catch {
    return null
  }
}
