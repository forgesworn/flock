// Fetch self-hostable Protomaps basemap assets (glyphs + sprite) into
// app/public/basemap/, so the vector basemap renders with **no third-party
// calls** — the whole point of the local/offline map path (see docs/ROADMAP.md
// Phase G, and app/src/basemap.ts).
//
// These are static, identical for every user, and carry no location data — but
// self-hosting them keeps flock's "no third party ever" promise honest and makes
// the map work fully offline. Run once:  node scripts/fetch-basemap-assets.mjs
//
// The town PMTiles itself is produced separately with go-pmtiles, e.g.:
//   go-pmtiles extract https://build.protomaps.com/<YYYYMMDD>.pmtiles \
//     app/public/basemap/harrogate.pmtiles --bbox=-1.62,53.94,-1.46,54.04 --maxzoom=15
// (a ~11 km town, z0–15, is ~3.3 MB.)

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ASSETS = 'https://protomaps.github.io/basemaps-assets'
// The dark flavour's layers() reference these three fontstacks.
const FONTSTACKS = ['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic']
// Glyph ranges maplibre requests for place/road labels: Latin + Greek/Cyrillic/
// Hebrew/Arabic (0–2047), plus General Punctuation & symbols (8192–8703 — en/em
// dashes, curly quotes, bullets, ellipsis, currency), which real labels use
// constantly. CJK and other scripts fall back to boxes — add their ranges here if
// flock ever targets those regions.
const RANGES = [
  ...Array.from({ length: 8 }, (_, i) => `${i * 256}-${i * 256 + 255}`), // 0–2047
  '8192-8447',
  '8448-8703',
]
const SPRITES = ['dark.json', 'dark.png', 'dark@2x.json', 'dark@2x.png']

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../app/public/basemap')

async function grab(url, dest) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, Buffer.from(await res.arrayBuffer()))
  return dest
}

const jobs = []
for (const stack of FONTSTACKS)
  for (const range of RANGES)
    jobs.push([`${ASSETS}/fonts/${encodeURIComponent(stack)}/${range}.pbf`, `${OUT}/fonts/${stack}/${range}.pbf`])
for (const s of SPRITES) jobs.push([`${ASSETS}/sprites/v4/${s}`, `${OUT}/sprite/${s.replace('dark', 'basemap')}`])

let ok = 0
await Promise.all(
  jobs.map(([url, dest]) =>
    grab(url, dest).then(
      () => { ok++ },
      (e) => { console.error('✗', e.message) },
    ),
  ),
)
console.log(`✓ fetched ${ok}/${jobs.length} basemap assets → app/public/basemap/{fonts,sprite}`)
