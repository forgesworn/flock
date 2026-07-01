// Vector PMTiles basemap — the local / offline map path (behind a flag).
//
// Why this exists (docs/ROADMAP.md Phase G): the raster map fetches a tile per
// viewport, so even when proxied it reveals *where you are looking* to the host on
// every pan. A vector basemap is a **single small file** (~3 MB for a town, z0–15)
// that can be fetched once and cached on-device — after which opening the map makes
// **zero** network calls: nobody sees when or where you look, and it works fully
// offline. Every asset (tiles, fonts, sprite) is same-origin — no third party ever.
//
// Enable for local testing:  VITE_PMTILES=1 npm run dev
//   or in the browser console:  localStorage.setItem('flock.pmtiles', '1')
// Assets are produced out-of-band (not committed) — see scripts/fetch-basemap-assets.mjs
// for the fonts/sprite and the go-pmtiles command for the town extract.

import maplibregl from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import { DARK, layers, type Flavor } from '@protomaps/basemaps'
import { activeMapLabelLang } from './lang'

// A same-origin PMTiles basemap. For this proof it is a bundled town extract; the
// real feature downloads a per-circle area (bbox of the safe zones + buffer) to
// OPFS on demand — see the "save this area" flow in the roadmap.
export const LOCAL_BASEMAP_URL = `${location.origin}/basemap/harrogate.pmtiles`

// flock "dusk": start from Protomaps' DARK flavour and nudge the dominant colours
// toward the app palette (styles.css — --bg #0e1116, --surface #161b22,
// --muted #97a3b1, --faint #6b7888). The raster map earned its calm night feel from
// saturation/brightness paint, which vector tiles don't have; here the same feel is
// expressed directly as colours.
const DUSK: Flavor = {
  ...DARK,
  background: '#0b0e12',
  earth: '#12161d',
  water: '#0d1e29',
  park_a: '#132019', park_b: '#111c16',
  wood_a: '#132018', wood_b: '#101b15',
  scrub_a: '#141f18', scrub_b: '#121b16',
  buildings: '#1a212c',
  highway: '#39424f', major: '#2a333f', minor_a: '#232b35', minor_b: '#1f2731', link: '#2a333f',
  boundaries: '#3a4655',
  city_label: '#c7d0da', city_label_halo: '#0b0e12',
  subplace_label: '#97a3b1', subplace_label_halo: '#0b0e12',
  roads_label_major: '#97a3b1', roads_label_major_halo: '#0b0e12',
  roads_label_minor: '#6b7888', roads_label_minor_halo: '#0b0e12',
  address_label: '#5c6675', address_label_halo: '#0b0e12',
}

let protocol: Protocol | null = null
/** Register the pmtiles:// protocol with maplibre (idempotent); returns the shared
 *  Protocol instance so local (OPFS) archives can be `.add()`ed to it. */
export function registerPmtilesProtocol(): Protocol {
  if (!protocol) {
    protocol = new Protocol()
    maplibregl.addProtocol('pmtiles', protocol.tile)
  }
  return protocol
}

/** A maplibre style backed by a same-origin PMTiles vector source + local fonts/sprite.
 *  Labels follow the user's map-label setting over the device locale (see
 *  `activeMapLabelLang`): a language code translates where the tiles have it (München on
 *  a German phone, Munich on a British one), while `null` renders the tiles' native
 *  `name` — the local names that match the street signs. Pass `lang` to override
 *  (e.g. the market-proof harness). */
export function pmtilesStyle(pmtilesUrl: string, lang: string | null = activeMapLabelLang()): maplibregl.StyleSpecification {
  return {
    version: 8,
    glyphs: `${location.origin}/basemap/fonts/{fontstack}/{range}.pbf`,
    sprite: `${location.origin}/basemap/sprite/basemap`,
    sources: {
      protomaps: {
        type: 'vector',
        url: `pmtiles://${pmtilesUrl}`,
        attribution: '© OpenStreetMap',
      },
    },
    // A lang applies name:<lang> with native fallback; omit it (local mode) for the
    // tiles' native `name` only — see docs on `layers()` in @protomaps/basemaps.
    layers: (lang ? layers('protomaps', DUSK, { lang }) : layers('protomaps', DUSK)) as maplibregl.StyleSpecification['layers'],
  }
}
