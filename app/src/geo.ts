// Geocoding via OSM Nominatim — privacy-preserving (NOT Google), and the endpoint
// is build-time configurable so a self-hosted Nominatim can be used. Only hit when
// a user deliberately sets a rendezvous by name/address — never continuously.

const NOMINATIM = import.meta.env.VITE_NOMINATIM_URL || 'https://nominatim.openstreetmap.org'

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
