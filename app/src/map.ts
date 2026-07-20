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
import type { Geofence, NoReportZone } from '@forgesworn/flock'

/** A geohash cell's true footprint — the honest shape of a coarse disclosure. */
export interface CellBounds { minLat: number; maxLat: number; minLon: number; maxLon: number }

export interface MapPoint {
  member: string
  lat: number
  lon: number
  label: string
  status: 'active' | 'stale' | 'alert'
  /**
   * Disclosure uncertainty radius in metres (from the beacon's geohash
   * precision). Drives whether the "rough area" is worth drawing at all —
   * an exact share is a few metres and collapses to the pin. Omit/0 → no area.
   */
  radiusMetres?: number
  /**
   * The disclosed geohash CELL. When present, the rough area is drawn as this
   * true rectangle — the receiver is guaranteed the member is inside the
   * square, which a circular halo could only approximate (someone near a cell
   * corner sits outside the inscribed circle).
   */
  cell?: CellBounds
}

/** A dropped pin (Feature: droppable pins) — a fixed kind rendered as a labelled
 *  marker the circle can tap to navigate to. `mine` styles my own pins apart. */
export interface DroppedPinPoint {
  id: string
  lat: number
  lon: number
  /** Local label (glyph + provider-defined name) — never free text. */
  label: string
  mine: boolean
  /** Dropper's petname, shown on OTHERS' pins so everyone knows whose pin is
   *  whose (mine read as mine by their green tag). Untrusted — textContent only. */
  who?: string
}

// Below this the area is smaller than the pin itself, so it reads as a point —
// don't draw one (an exact share is full-precision "we know exactly").
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

/** The closed rectangle of a geohash cell (lon/lat rings, GeoJSON order). */
function cellRect(c: CellBounds): number[][] {
  return [
    [c.minLon, c.minLat], [c.maxLon, c.minLat],
    [c.maxLon, c.maxLat], [c.minLon, c.maxLat],
    [c.minLon, c.minLat],
  ]
}

const fc = (features: PolyFeature[]): FeatureCollection => ({ type: 'FeatureCollection', features })

export class MapView {
  readonly map: maplibregl.Map
  readonly geolocate: maplibregl.GeolocateControl
  private markers: maplibregl.Marker[] = []
  private rzvMarker: maplibregl.Marker | null = null
  private venueMarker: maplibregl.Marker | null = null
  private contribMarkers: maplibregl.Marker[] = []
  private pinMarkers: maplibregl.Marker[] = []
  private draftMarker: maplibregl.Marker | null = null
  private pendingPins: DroppedPinPoint[] | null = null
  private pinClickCb: ((id: string) => void) | null = null
  private pinLongPressCb: ((id: string) => void) | null = null
  private mapClickCb: ((lat: number, lon: number) => void) | null = null
  private ready = false
  private pendingFences: Geofence[] | null = null
  private pendingNoReport: NoReportZone[] | null = null
  private pendingPreview: Geofence | null = null
  private pendingMembers: MapPoint[] | null = null
  private pendingContrib: MapPoint[] | null = null
  private pendingTrail: { lat: number; lon: number }[] | null = null
  private trailPoints = 0 // count of breadcrumb dots currently drawn (inspection/e2e)
  private memberAreaFeatures = 0 // count of rough-area halos currently drawn (inspection/e2e)
  private contribAreaFeatures = 0 // count of contributor halos currently drawn (inspection/e2e)
  private userMoved = false // a real gesture happened — the camera is theirs now
  private memberClickCb: ((member: string) => void) | null = null
  private destroyed = false

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
    // Auto-fit hands the camera over the moment the person takes it: any manual
    // drag/zoom (originalEvent present = a real gesture, not our own camera
    // call) or tapping "locate me" ends automatic re-framing until re-mount.
    this.map.on('dragstart', (e) => { if ((e as { originalEvent?: unknown }).originalEvent) this.userMoved = true })
    this.map.on('zoomstart', (e) => { if ((e as { originalEvent?: unknown }).originalEvent) this.userMoved = true })
    this.geolocate.on('trackuserlocationstart', () => { this.userMoved = true })
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
      // Meeting-point contributor cells — the coarse spots people opted to share to
      // find a fair place. A distinct soft violet, dashed, so it never reads as live
      // presence (blue, solid); same precision-driven "rough area" as presence.
      this.map.addSource('contrib-area', { type: 'geojson', data: fc([]) })
      this.map.addLayer({ id: 'contrib-area-fill', type: 'fill', source: 'contrib-area', paint: { 'fill-color': '#a78bfa', 'fill-opacity': 0.16 } })
      this.map.addLayer({ id: 'contrib-area-line', type: 'line', source: 'contrib-area', paint: { 'line-color': '#a78bfa', 'line-width': 1.5, 'line-opacity': 0.5, 'line-dasharray': [2, 2] } })
      // Breadcrumb trail — where an alerted member had been. Alert-red like the
      // member pin it belongs to; dotted so it reads as history, not presence.
      this.map.addSource('trail', { type: 'geojson', data: fc([]) })
      this.map.addLayer({ id: 'trail-line', type: 'line', source: 'trail', filter: ['==', ['geometry-type'], 'LineString'] as unknown as maplibregl.FilterSpecification, paint: { 'line-color': '#ff6b5e', 'line-width': 2, 'line-opacity': 0.55, 'line-dasharray': [1, 2] } })
      this.map.addLayer({ id: 'trail-dots', type: 'circle', source: 'trail', filter: ['==', ['geometry-type'], 'Point'] as unknown as maplibregl.FilterSpecification, paint: { 'circle-color': '#ff6b5e', 'circle-radius': 4, 'circle-opacity': 0.85, 'circle-stroke-color': '#1a1d27', 'circle-stroke-width': 1 } })
      this.ready = true
      if (this.pendingFences) this.setGeofences(this.pendingFences)
      if (this.pendingNoReport) this.setNoReportZones(this.pendingNoReport)
      if (this.pendingMembers) this.setMembers(this.pendingMembers)
      if (this.pendingContrib) this.setContributorPins(this.pendingContrib)
      if (this.pendingPins) this.setPins(this.pendingPins)
      if (this.pendingTrail) this.setTrail(this.pendingTrail)
      this.setPreview(this.pendingPreview)
      // Bare-map tap → "place a pin here" (markers stopPropagation, so this only
      // fires off empty map). Registered once; the callback is nulled when not arming.
      this.map.on('click', (e) => this.mapClickCb?.(e.lngLat.lat, e.lngLat.lng))
    })
  }

  onMove(cb: () => void): void { this.map.on('move', cb) }

  /** Tap a member's pin → their pubkey. Used to open a private message to them.
   *  Set once; every marker (rebuilt on each setMembers) reads this at click time. */
  onMemberClick(cb: (member: string) => void): void { this.memberClickCb = cb }

  /** Tap a dropped pin → its id (open radar / navigate to it). */
  onPinClick(cb: (id: string) => void): void { this.pinClickCb = cb }

  /** Press-and-hold a dropped pin → its id (move it). */
  onPinLongPress(cb: (id: string) => void): void { this.pinLongPressCb = cb }

  zoomIn(): void { this.map.zoomIn() }
  zoomOut(): void { this.map.zoomOut() }
  zoomLevel(): number { return this.map.getZoom() }

  /** Slide the camera by a screen-pixel delta (placement overlay pan gesture). */
  panByPixels(dx: number, dy: number): void { this.map.panBy([dx, dy], { duration: 0 }) }

  /** Jump to a zoom level keeping the map point under (clientX, clientY) fixed —
   *  the anchor of the placement overlay's pinch gesture. */
  zoomAtClient(zoom: number, clientX: number, clientY: number): void {
    const r = this.map.getCanvasContainer().getBoundingClientRect()
    this.map.easeTo({ zoom, around: this.map.unproject([clientX - r.left, clientY - r.top]), duration: 0 })
  }

  /** Tap the empty map (not a marker) → the lat/lon tapped. Drives "place a pin
   *  here"; pass null to disarm. Markers stopPropagation, so this only fires on
   *  bare map. */
  onMapClick(cb: ((lat: number, lon: number) => void) | null): void { this.mapClickCb = cb }

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

  /** A restored camera (re-init) owns the view — no automatic re-framing. */
  suppressAutoFit(): void { this.userMoved = true }

  /** Frame the view to include every given point (everyone in the circle, plus
   *  me) — re-fitting as pins move, but only until the person takes the camera
   *  with a real gesture. Single point = a sensible street-level view. */
  autoFit(points: { lat: number; lon: number }[]): void {
    if (this.userMoved || points.length === 0) return
    if (points.length === 1) { this.flyTo(points[0], { instant: false }); return }
    const first: [number, number] = [points[0].lon, points[0].lat]
    const b = points.reduce((acc, p) => acc.extend([p.lon, p.lat]), new maplibregl.LngLatBounds(first, first))
    // Top padding clears the pin labels (anchored above the dot); maxZoom keeps
    // two people in the same street from producing a rooftop-level view.
    this.map.fitBounds(b, { padding: { top: 90, bottom: 60, left: 60, right: 60 }, maxZoom: 15, duration: 600 })
  }

  setGeofences(fences: Geofence[]): void {
    if (!this.ready) { this.pendingFences = fences; return }
    ;(this.map.getSource('fences') as maplibregl.GeoJSONSource).setData(fc(fences.map(fenceFeature)))
  }

  setNoReportZones(zones: NoReportZone[]): void {
    if (!this.ready) { this.pendingNoReport = zones; return }
    ;(this.map.getSource('noreport') as maplibregl.GeoJSONSource).setData(fc(zones.map((z) => fenceFeature(z.area))))
  }

  setPreview(f: Geofence | null): void {
    if (!this.ready) { this.pendingPreview = f; return }
    ;(this.map.getSource('preview') as maplibregl.GeoJSONSource).setData(fc(f ? [fenceFeature(f)] : []))
  }

  setMembers(points: MapPoint[]): void {
    this.markers.forEach((m) => m.remove())
    this.markers = []
    for (const p of points) {
      const el = document.createElement('div')
      el.className = `map-pin ${p.status}`
      // textContent, not innerHTML: the label is now a member-chosen petname / public
      // profile name (untrusted), so it must never be interpolated into markup.
      el.innerHTML = '<span class="tag"></span><span class="dot"></span>'
      ;(el.querySelector('.tag') as HTMLElement).textContent = p.label
      // A pin is tappable — send this member a private message. stopPropagation so
      // the tap doesn't also register as a map gesture (which would end auto-fit).
      const member = p.member
      el.style.cursor = 'pointer'
      el.addEventListener('click', (ev) => { ev.stopPropagation(); this.memberClickCb?.(member) })
      this.markers.push(new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([p.lon, p.lat]).addTo(this.map))
    }
    // "Rough area" squares — one per pin whose disclosed precision is coarse
    // enough to be worth showing as an area rather than a point. The TRUE
    // geohash cell rectangle when we have it (the member is guaranteed inside
    // it); the circular approximation only as a fallback.
    if (!this.ready) { this.pendingMembers = points; return }
    const areas = points
      .filter((p) => (p.radiusMetres ?? 0) >= HALO_MIN_METRES)
      .map((p): PolyFeature => ({
        type: 'Feature',
        properties: { status: p.status },
        geometry: { type: 'Polygon', coordinates: [p.cell ? cellRect(p.cell) : ring(p.lat, p.lon, p.radiusMetres as number)] },
      }))
    this.memberAreaFeatures = areas.length
    ;(this.map.getSource('members-area') as maplibregl.GeoJSONSource).setData(fc(areas))
  }

  /** How many "rough area" squares are currently drawn. An inspection aid (used by the e2e). */
  memberAreaCount(): number { return this.memberAreaFeatures }

  /**
   * Draw (or clear) a disclosed breadcrumb trail: a dot per crumb plus a dotted
   * connecting line, oldest → newest. Only ever fed from a help/breach trail
   * disclosure — routine presence never reaches this layer.
   */
  setTrail(points: { lat: number; lon: number }[]): void {
    if (!this.ready) { this.pendingTrail = points; return }
    this.trailPoints = points.length
    const features: unknown[] = points.map((p) => ({
      type: 'Feature', properties: {},
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    }))
    if (points.length >= 2) {
      features.push({
        type: 'Feature', properties: {},
        geometry: { type: 'LineString', coordinates: points.map((p) => [p.lon, p.lat]) },
      })
    }
    ;(this.map.getSource('trail') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features } as unknown as FeatureCollection)
  }

  /** How many breadcrumb dots are currently drawn. An inspection aid (used by the e2e). */
  trailPointCount(): number { return this.trailPoints }

  /**
   * Show (or clear) the rendezvous place as a distinct flag pin. Kept apart from
   * the member markers — those are cleared and rebuilt on every `setMembers`,
   * whereas the meeting point is a fixed spot that must persist across presence
   * updates and show even when no one has shared a beacon yet.
   */
  setRendezvous(point: { lat: number; lon: number; label?: string } | null): void {
    this.rzvMarker?.remove()
    this.rzvMarker = null
    if (!point) return
    const el = document.createElement('div')
    el.className = 'rzv-pin'
    // textContent for the label (member/place-chosen, so untrusted); the flag glyph is static.
    el.innerHTML = '<span class="tag"></span><span class="flag">⚑</span>'
    ;(el.querySelector('.tag') as HTMLElement).textContent = point.label || 'Meet'
    this.rzvMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([point.lon, point.lat]).addTo(this.map)
  }

  /** Show (or clear) the circle's dropped pins — a distinct, persistent, tappable
   *  layer that survives setMembers rebuilds. Each is a labelled flag; tapping it
   *  routes into radar navigation. See app/src/pin.ts. */
  setPins(points: DroppedPinPoint[]): void {
    if (!this.ready) { this.pendingPins = points; return }
    this.pinMarkers.forEach((m) => m.remove())
    this.pinMarkers = []
    for (const p of points) {
      const el = document.createElement('div')
      el.className = `drop-pin${p.mine ? ' mine' : ''}`
      // The label is a fixed glyph+name, but textContent keeps the marker path
      // uniformly injection-proof like the member/rendezvous pins.
      el.innerHTML = '<span class="tag"></span><span class="flag">📌</span>'
      ;(el.querySelector('.tag') as HTMLElement).textContent = p.who ? `${p.label} · ${p.who}` : p.label
      const pinId = p.id
      const canMove = p.mine
      el.style.cursor = 'pointer'
      // Tap → navigate (radar); press-and-HOLD → move it (my own pins only), the
      // same gesture as placing. Pointer-based so a hold is told apart from a tap.
      el.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation() // touching a pin must not start a map pan
        const sx = ev.clientX, sy = ev.clientY
        let moved = false, longFired = false
        const timer = canMove ? window.setTimeout(() => { longFired = true; this.pinLongPressCb?.(pinId) }, 450) : 0
        const mv = (e2: PointerEvent): void => { if (Math.hypot(e2.clientX - sx, e2.clientY - sy) > 10) { moved = true; window.clearTimeout(timer) } }
        const up = (): void => {
          window.clearTimeout(timer)
          el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up)
          if (!moved && !longFired) this.pinClickCb?.(pinId)
        }
        el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up)
      })
      this.pinMarkers.push(new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([p.lon, p.lat]).addTo(this.map))
    }
  }

  /** Show the "place this pin" marker at (lat,lon). It's just a visual marker
   *  (pointer-events:none); the placement flow lays its OWN full-screen touch
   *  surface OVER the map and drives the position via moveDraftPinToClient, so
   *  maplibre's touch handling is never in the loop. Replaces any existing draft. */
  showDraftPin(lat: number, lon: number): void {
    this.draftMarker?.remove()
    const el = document.createElement('div')
    el.className = 'draft-pin'
    el.innerHTML = '<span class="flag">📌</span>'
    this.draftMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([lon, lat]).addTo(this.map)
  }

  /** Move the draft pin to a SCREEN point (client px) and return its new spot. The
   *  placement overlay owns the pointer events and just tells us where the finger
   *  is; we unproject that to a coordinate. Full precision. */
  moveDraftPinToClient(clientX: number, clientY: number): { lat: number; lon: number } | null {
    if (!this.draftMarker) return null
    const r = this.map.getCanvasContainer().getBoundingClientRect()
    const ll = this.map.unproject([clientX - r.left, clientY - r.top])
    this.draftMarker.setLngLat(ll)
    return { lat: ll.lat, lon: ll.lng }
  }

  /** The draft pin's current spot (full precision), or null if none is up. */
  draftPinPos(): { lat: number; lon: number } | null {
    if (!this.draftMarker) return null
    const p = this.draftMarker.getLngLat()
    return { lat: p.lat, lon: p.lng }
  }

  hideDraftPin(): void { this.draftMarker?.remove(); this.draftMarker = null }

  /**
   * Show (or clear) the meeting-point contributors — each person's cell at its
   * disclosed precision (exact = a dot, coarse = a "rough area" blob), in a distinct
   * violet layer so it reads as "who's helping pick a place", apart from live
   * presence. Proposer-only, while a search is live; cleared when it ends.
   */
  setContributorPins(points: MapPoint[]): void {
    this.contribMarkers.forEach((m) => m.remove())
    this.contribMarkers = []
    for (const p of points) {
      const el = document.createElement('div')
      // A sub-halo-threshold radius means an EXACT share (a precise dot); a coarse
      // cell gets the "rough area" blob. The class lets the exact dot read sharper.
      const exact = (p.radiusMetres ?? 0) < HALO_MIN_METRES
      el.className = `map-pin contrib${exact ? ' exact' : ''}`
      // textContent for the (untrusted) petname/profile label; never innerHTML.
      el.innerHTML = '<span class="tag"></span><span class="dot"></span>'
      ;(el.querySelector('.tag') as HTMLElement).textContent = p.label
      this.contribMarkers.push(new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([p.lon, p.lat]).addTo(this.map))
    }
    if (!this.ready) { this.pendingContrib = points; return }
    const halos = points
      .filter((p) => (p.radiusMetres ?? 0) >= HALO_MIN_METRES)
      .map((p): PolyFeature => ({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [ring(p.lat, p.lon, p.radiusMetres as number)] },
      }))
    this.contribAreaFeatures = halos.length
    ;(this.map.getSource('contrib-area') as maplibregl.GeoJSONSource).setData(fc(halos))
  }

  /** How many contributor "rough area" halos are drawn (inspection aid / e2e). */
  contributorAreaCount(): number { return this.contribAreaFeatures }

  /**
   * Show (or clear) the suggested meeting venue as a distinct pin — separate from
   * both the member markers and the rendezvous flag — so the proposer sees the
   * candidate place on the map before committing it as the rendezvous.
   */
  setMeetingVenue(point: { lat: number; lon: number; label?: string } | null): void {
    this.venueMarker?.remove()
    this.venueMarker = null
    if (!point) return
    const el = document.createElement('div')
    el.className = 'venue-pin'
    el.innerHTML = '<span class="tag"></span><span class="flag">📍</span>'
    ;(el.querySelector('.tag') as HTMLElement).textContent = point.label || 'Fair spot'
    this.venueMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([point.lon, point.lat]).addTo(this.map)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.markers.forEach((m) => m.remove())
    this.contribMarkers.forEach((m) => m.remove())
    this.rzvMarker?.remove()
    this.venueMarker?.remove()
    this.hideDraftPin() // unwire finger-follow handlers + re-enable pan before teardown
    this.map.remove()
  }
}
