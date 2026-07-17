import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { exports: Record<string, { types: string; import: string }> }

const FLOCK_MODULES = [
  'geofence',
  'noreport',
  'policy',
  'signals',
  'nightout',
  'checkin',
  'trail',
  'buzz',
  'allclear',
  'fences',
  'rendezvous',
  'meeting',
  'disband',
  'offgrid',
  'spokenverify',
  'joined',
  'lost',
  'findping',
  'radar',
] as const

describe('package subpath exports', () => {
  it('exposes every public Flock module with matching JS and type paths', () => {
    expect(Object.keys(packageJson.exports).sort()).toEqual([
      '.',
      ...FLOCK_MODULES.map((name) => `./${name}`),
    ].sort())

    for (const name of FLOCK_MODULES) {
      expect(packageJson.exports[`./${name}`]).toEqual({
        types: `./dist/${name}.d.ts`,
        import: `./dist/${name}.js`,
      })
    }
  })
})
