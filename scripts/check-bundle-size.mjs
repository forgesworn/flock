import { gzipSync } from 'node:zlib'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const assetsDir = resolve('dist-app/assets')

const budgets = [
  {
    label: 'main',
    match: /^index-[\w-]+\.js$/,
    raw: 360_000,
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
