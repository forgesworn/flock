import { gzipSync } from 'node:zlib'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const assetsDir = resolve('dist-app/assets')

const budgets = [
  {
    label: 'main',
    match: /^index-[\w-]+\.js$/,
    // Raised 360k → 364k for radar Phase 3 + universal direction callouts,
    // then → 369k for the radar-session consent flow (both 2026-07-21). Real
    // splitting was done first (the RSSI window machinery lives in the lazy
    // native/ble.ts chunk); what remains is eager code on the DM/radar paths
    // (the session decode fast-path and consent UI cannot load lazily). The
    // gzip budget, the delivery metric, is deliberately unchanged — when THAT
    // threatens, split app.ts properly instead of raising it.
    raw: 369_000,
    gzip: 125_000,
  },
  {
    label: 'MapLibre',
    match: /^maplibre-gl-[\w-]+\.js$/,
    raw: 1_100_000,
    gzip: 290_000,
  },
]

const files = readdirSync(assetsDir)
let failed = false

for (const budget of budgets) {
  const matches = files.filter((file) => budget.match.test(file))
  if (matches.length !== 1) {
    console.error(`bundle budget: expected one ${budget.label} chunk, found ${matches.length}`)
    failed = true
    continue
  }

  const file = matches[0]
  const bytes = readFileSync(resolve(assetsDir, file))
  const gzipBytes = gzipSync(bytes).byteLength
  const rawOk = bytes.byteLength <= budget.raw
  const gzipOk = gzipBytes <= budget.gzip

  console.log(
    `${budget.label}: ${bytes.byteLength} B raw / ${gzipBytes} B gzip ` +
    `(budgets ${budget.raw} / ${budget.gzip})`,
  )
  if (!rawOk || !gzipOk) failed = true
}

if (failed) {
  console.error('bundle budget exceeded; split or remove code before raising a limit')
  process.exitCode = 1
}
