// Map view — maplibre-gl with OSM raster tiles. Renders member positions and
// circular safe zones, with a live preview circle for the geofence editor.
//
// Privacy note: tiles are served **same-origin** (`/tiles/*`) by default,
// reverse-proxied to OpenStreetMap by the host (Caddy in production, the Vite
// dev-server proxy in dev). The third-party tile CDN therefore only ever sees
// the host, never the user's IP + map viewport — the viewport is what roughly
// reveals where the circle is. Override VITE_TILE_URL to point at any tile
// server directly (self-hosters), or a local PMTiles basemap (see basemap.ts).

import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Geofence, CircleGeofence, NoReportZone } from '@forgesworn/flock'

export interface MapPoint {
  member: string
  lat: number
  lon: number
  label: string
  status: 'active' | 'stale' | 'alert'
  /**
   * Disclosure uncertainty radius in metres (from the beacon's geohash
   * precision). A coarse night-out beacon is ~600 m ("somewhere around here");
   * a full-precision breach/pick-up is a few metres and collapses to the pin.
   * Drives the translucent "rough area" halo. Omit/0 → no halo.
   */
  radiusMetres?: number
}

// Below this the halo is smaller than the pin itself, so it reads as a point —
// don't draw one (breach / pick-up / help are full-precision "we know exactly").
const HALO_MIN_METRES = 30

// Same-origin by default (proxied → OSM); overridable at build time so
// self-hosters can point at their own tile server.
const TILE_URL = import.meta.env.VITE_TILE_URL || '/tiles/{z}/{x}/{y}.png'
const TILE_ATTRIBUTION = import.meta.env.VITE_TILE_ATTRIBUTION || '© OpenStreetMap contributors'

const STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: [TILE_URL],
      tileSize: 256,
      attribution: TILE_ATTRIBUTION,
    },
  },
  layers: [
    { id: 'osm', type: 'raster', source: 'osm', paint: { 'raster-saturation': -0.55, 'raster-brightness-max': 0.82, 'raster-contrast': -0.05 } },
  ],
}

// Opt into the local/offline vector basemap (see basemap.ts). Off by default —
// build-time (VITE_PMTILES=1) or a per-device localStorage flag for testing.
function usePmtilesBasemap(): boolean {
  if (import.meta.env.VITE_PMTILES === '1') return true
  try { return localStorage.getItem('flock.pmtiles') === '1' } catch { return false }
}

function ring(lat: number, lon: number, radiusMetres: number, steps = 72): number[][] {
  const out: number[][] = []
  const latR = (lat * Math.PI) / 180
  const dLat = radiusMetres / 111_320
  const dLon = radiusMetres / (111_320 * Math.cos(latR))
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * 2 * Math.PI
    out.push([lon + dLon * Math.cos(t), lat + dLat * Math.sin(t)])
  }
  return out
}

interface PolyFeature { type: 'Feature'; properties: Record<string, unknown>; geometry: { type: 'Polygon'; coordinates: number[][][] } }
interface FeatureCollection { type: 'FeatureCollection'; features: PolyFeature[] }

function fenceFeature(f: Geofence): PolyFeature {
  const coords = f.kind === 'circle'
    ? [ring(f.centre.lat, f.centre.lon, f.radiusMetres)]
    : [[...f.vertices.map((v) => [v.lon, v.lat]), [f.vertices[0].lon, f.vertices[0].lat]]]
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: coords } }
}

const fc = (features: PolyFeature[]): FeatureCollection => ({ type: 'FeatureCollection', features })

export class MapView {
  readonly map: maplibregl.Map
  readonly geolocate: maplibregl.GeolocateControl
  private markers: maplibregl.Marker[] = []
  private ready = false
  private pendingFences: Geofence[] | null = null
  private pendingNoReport: NoReportZone[] | null = null
  private pendingPreview: CircleGeofence | null = null
  private pendingMembers: MapPoint[] | null = null
  private memberAreaFeatures = 0 // count of rough-area halos currently drawn (inspection/e2e)

  // Lazily resolve the basemap style, best first: (1) the circle's saved offline
  // area (OPFS vector — zero network at view time); (2) the bundled demo vector
  // basemap when the dev flag is set; (3) the proxied raster tiles. The pmtiles +
  // protomaps deps are dynamic-imported only when needed, so they stay out of the
  // default bundle. Falls back to raster if a vector path can't be built.
  static async create(container: HTMLElement, centre?: { lat: number; lon: number }, opts: { circleId?: string } = {}): Promise<MapView> {
    let style: maplibregl.StyleSpecification | undefined
    if (opts.circleId) {
      try { style = (await (await import('./offlineArea')).savedAreaStyle(opts.circleId)) ?? undefined } catch { /* no saved area */ }
    }
    if (!style && usePmtilesBasemap()) {
      try {
        const bm = await import('./basemap')
        bm.registerPmtilesProtocol()
        style = bm.pmtilesStyle(bm.LOCAL_BASEMAP_URL)
      } catch { /* assets missing → fall back to raster */ }
    }
    return new MapView(container, centre, style)
  }

  constructor(container: HTMLElement, centre?: { lat: number; lon: number }, style: maplibregl.StyleSpecification = STYLE) {
    this.map = new maplibregl.Map({
      container,
      style,
      center: centre ? [centre.lon, centre.lat] : [-0.1278, 51.5074],
      zoom: 13.5,
      attributionControl: { compact: true },
    })
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    // "Locate me" — a live position dot + a button to recentre after panning away.
    // Reads the browser's geolocation directly and only affects the local view;
    // nothing here is broadcast (flock never shares a position without an explicit send).
    this.geolocate = new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true, maximumAge: 5000, timeout: 20_000 },
      trackUserLocation: true,
      showUserLocation: true,
      showAccuracyCircle: true,
    })
    this.map.addControl(this.geolocate, 'top-right')
    this.map.on('load', () => {
      this.map.addSource('fences', { type: 'geojson', data: fc([]) })
      this.map.addLayer({ id: 'fences-fill', type: 'fill', source: 'fences', paint: { 'fill-color': '#5fd0a8', 'fill-opacity': 0.14 } })
      this.map.addLayer({ id: 'fences-line', type: 'line', source: 'fences', paint: { 'line-color': '#5fd0a8', 'line-width': 2, 'line-opacity': 0.7 } })
      // No-report zones — amber, hatched feel via a stronger dashed outline.
      this.map.addSource('noreport', { type: 'geojson', data: fc([]) })
      this.map.addLayer({ id: 'noreport-fill', type: 'fill', source: 'noreport', paint: { 'fill-color': '#f0a93b', 'fill-opacity': 0.13 } })
      this.map.addLayer({ id: 'noreport-line', type: 'line', source: 'noreport', paint: { 'line-color': '#f0a93b', 'line-width': 2, 'line-opacity': 0.8, 'line-dasharray': [3, 2] } })
      this.map.addSource('preview', { type: 'geojson', data: fc([]) })
      this.map.addLayer({ id: 'preview-fill', type: 'fill', source: 'preview', paint: { 'fill-color': '#6ea8fe', 'fill-opacity': 0.16 } })
      this.map.addLayer({ id: 'preview-line', type: 'line', source: 'preview', paint: { 'line-color': '#6ea8fe', 'line-width': 2, 'line-dasharray': [2, 2] } })
      // Presence "rough area" — a soft disc under each pin at the disclosed
      // precision. Status-coloured: calm blue for a normal coarse share, red for
      // an alert/breach. A solid (undashed) edge distinguishes it from the safe
      // and no-report zones. Sits above the zones, beneath the DOM pin markers.
      const statusColour = ['match', ['get', 'status'], 'alert', '#ff6b5e', 'stale', '#6b7888', /* active */ '#6ea8fe'] as unknown as maplibregl.ExpressionSpecification
      this.map.addSource('members-area', { type: 'geojson', data: fc([]) })
      this.map.addLayer({ id: 'members-area-fill', type: 'fill', source: 'members-area', paint: { 'fill-color': statusColour, 'fill-opacity': 0.15 } })
      this.map.addLayer({ id: 'members-area-line', type: 'line', source: 'members-area', paint: { 'line-color': statusColour, 'line-width': 1.5, 'line-opacity': 0.4 } })
      this.ready = true
      if (this.pendingFences) this.setGeofences(this.pendingFences)
      if (this.pendingNoReport) this.setNoReportZones(this.pendingNoReport)
      if (this.pendingMembers) this.setMembers(this.pendingMembers)
      this.setPreview(this.pendingPreview)
    })
  }

  onMove(cb: () => void): void { this.map.on('move', cb) }

  center(): { lat: number; lon: number } {
    const c = this.map.getCenter()
    return { lat: c.lat, lon: c.lng }
  }

  flyTo(c: { lat: number; lon: number }, opts: { instant?: boolean } = {}): void {
    const camera = { center: [c.lon, c.lat] as [number, number], zoom: 15 }
    // Instant for the initial "centre on me" so we don't swoop across the world
    // from the default view; animated when recentring an already-placed map.
    if (opts.instant) this.map.jumpTo(camera)
    else this.map.flyTo(camera)
  }

  setGeofences(fences: Geofence[]): void {
    if (!this.ready) { this.pendingFences = fences; return }
    ;(this.map.getSource('fences') as maplibregl.GeoJSONSource).setData(fc(fences.map(fenceFeature)))
  }

  setNoReportZones(zones: NoReportZone[]): void {
    if (!this.ready) { this.pendingNoReport = zones; return }
    ;(this.map.getSource('noreport') as maplibregl.GeoJSONSource).setData(fc(zones.map((z) => fenceFeature(z.area))))
  }

  setPreview(f: CircleGeofence | null): void {
    if (!this.ready) { this.pendingPreview = f; return }
    ;(this.map.getSource('preview') as maplibregl.GeoJSONSource).setData(fc(f ? [fenceFeature(f)] : []))
  }

  setMembers(points: MapPoint[]): void {
    this.markers.forEach((m) => m.remove())
    this.markers = []
    for (const p of points) {
      const el = document.createElement('div')
      el.className = `map-pin ${p.status}`
      el.innerHTML = `<span class="tag">${p.label}</span><span class="dot"></span>`
      this.markers.push(new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([p.lon, p.lat]).addTo(this.map))
    }
    // "Rough area" halos — one per pin whose disclosed precision is coarse enough
    // to be worth showing as an area rather than a point.
    if (!this.ready) { this.pendingMembers = points; return }
    const halos = points
      .filter((p) => (p.radiusMetres ?? 0) >= HALO_MIN_METRES)
      .map((p): PolyFeature => ({
        type: 'Feature',
        properties: { status: p.status },
        geometry: { type: 'Polygon', coordinates: [ring(p.lat, p.lon, p.radiusMetres as number)] },
      }))
    this.memberAreaFeatures = halos.length
    ;(this.map.getSource('members-area') as maplibregl.GeoJSONSource).setData(fc(halos))
  }

  /** How many "rough area" halos are currently drawn. An inspection aid (used by the e2e). */
  memberAreaCount(): number { return this.memberAreaFeatures }

  destroy(): void {
    this.markers.forEach((m) => m.remove())
    this.map.remove()
  }
}
