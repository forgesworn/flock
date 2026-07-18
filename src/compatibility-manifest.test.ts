import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(
  readFileSync(new URL('compatibility/v1/manifest.json', root), 'utf8'),
) as {
  package: string
  modules: { name: string; test: string; contract: string }[]
  vectors: string[]
}
const packageJson = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
  name: string
  exports: Record<string, unknown>
}

describe('public compatibility manifest', () => {
  it('covers every public pure module with a source file and focused test', () => {
    const exported = Object.keys(packageJson.exports)
      .filter((name) => name !== '.')
      .map((name) => name.slice(2))
      .sort()
    const documented = manifest.modules.map((entry) => entry.name).sort()

    expect(manifest.package).toBe(packageJson.name)
    expect(documented).toEqual(exported)
    for (const entry of manifest.modules) {
      expect(entry.contract.length, `${entry.name} contract`).toBeGreaterThan(0)
      expect(existsSync(new URL(`src/${entry.name}.ts`, root)), `${entry.name} source`).toBe(true)
      expect(existsSync(new URL(entry.test, root)), `${entry.name} focused test`).toBe(true)
    }
  })

  it('keeps every declared vector file public and committed', () => {
    for (const path of manifest.vectors) {
      expect(existsSync(new URL(path, root)), path).toBe(true)
    }
  })
})
