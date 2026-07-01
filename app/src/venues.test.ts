import { describe, it, expect, vi, afterEach } from 'vitest'
import { searchMeetingVenues } from './venues'

// An absolute endpoint (the kit validates the URL); tests inject it so the
// same-origin `location.origin` default never runs under node.
const ENDPOINT = 'https://test.local/overpass/api/interpreter'
const REGION = {
  type: 'Polygon' as const,
  coordinates: [[[-0.14, 51.50], [-0.11, 51.50], [-0.11, 51.52], [-0.14, 51.52], [-0.14, 51.50]]],
}

const overpassJson = {
  elements: [
    { type: 'node', id: 1, lat: 51.512, lon: -0.123, tags: { name: 'The Coach & Horses', amenity: 'pub' } },
    { type: 'way', id: 2, center: { lat: 51.513, lon: -0.125 }, tags: { name: 'Bar Italia', amenity: 'bar' } },
    { type: 'node', id: 3, lat: 51.5, lon: -0.12, tags: { amenity: 'cafe' } }, // no name → dropped by the kit
  ],
}

afterEach(() => vi.unstubAllGlobals())

describe('searchMeetingVenues (same-origin Overpass proxy)', () => {
  it('returns named venues and sends only a bounding box (never participants)', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(overpassJson), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const venues = await searchMeetingVenues(REGION, { endpoint: ENDPOINT })
    expect(venues.map((v) => v.name)).toEqual(['The Coach & Horses', 'Bar Italia'])

    // POSTed to the injected proxy endpoint…
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(ENDPOINT)
    expect(init?.method).toBe('POST')
    // …carrying an Overpass query keyed on a bbox + venue tags — no list of people.
    const query = decodeURIComponent(String(init?.body))
    expect(query).toContain('data=')
    expect(query).toContain('(51.5,-0.14,51.52,-0.11)') // the region's bbox (south,west,north,east)
    expect(query).toContain('["amenity"="pub"]') // default venue types applied
    expect(query).not.toMatch(/51\.5074/) // a participant's exact coordinate never appears
  })

  it('is best-effort: returns [] when the proxy errors (caller keeps the centroid)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 502 })))
    expect(await searchMeetingVenues(REGION, { endpoint: ENDPOINT })).toEqual([])
  })

  it('returns [] on a network throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await searchMeetingVenues(REGION, { endpoint: ENDPOINT })).toEqual([])
  })
})
