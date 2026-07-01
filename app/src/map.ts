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
}

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
  private markers: maplibregl.Marker[] = []
  private ready = false
  private pendingFences: Geofence[] | null = null
  private pendingNoReport: NoReportZone[] | null = null
  private pendingPreview: CircleGeofence | null = null

  // Lazily resolve the basemap style: the vector PMTiles path (local/offline) when
  // the flag is set, otherwise the proxied raster tiles. The pmtiles + protomaps
  // deps are dynamic-imported only when needed, so they stay out of the default
  // bundle. Falls back to raster if the local basemap assets aren't present.
  static async create(container: HTMLElement, centre?: { lat: number; lon: number }): Promise<MapView> {
    let style: maplibregl.StyleSpecification | undefined
    if (usePmtilesBasemap()) {
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
      this.ready = true
      if (this.pendingFences) this.setGeofences(this.pendingFences)
      if (this.pendingNoReport) this.setNoReportZones(this.pendingNoReport)
      this.setPreview(this.pendingPreview)
    })
  }

  onMove(cb: () => void): void { this.map.on('move', cb) }

  center(): { lat: number; lon: number } {
    const c = this.map.getCenter()
    return { lat: c.lat, lon: c.lng }
  }

  flyTo(c: { lat: number; lon: number }): void {
    this.map.flyTo({ center: [c.lon, c.lat], zoom: 15 })
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
  }

  destroy(): void {
    this.markers.forEach((m) => m.remove())
    this.map.remove()
  }
}
