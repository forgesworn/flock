import { describe, it, expect, afterEach, vi } from 'vitest'
import { isNativeShell, shareOrigin, isApkUpdateAvailable } from './native'

afterEach(() => vi.unstubAllGlobals())

describe('isNativeShell', () => {
  it('is false on the web (no injected Capacitor global)', () => {
    expect(isNativeShell()).toBe(false)
  })

  it('is true inside the Capacitor shell', () => {
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true })
    expect(isNativeShell()).toBe(true)
  })
})

describe('shareOrigin', () => {
  it('uses the current origin on the web — hosted, self-hosted and dev all stay correct', () => {
    vi.stubGlobal('location', { origin: 'https://flock.example.org' })
    expect(shareOrigin()).toBe('https://flock.example.org')
  })

  it("uses the hosted PWA inside the native shell — the WebView's own origin is https://localhost, a dead link on any other phone", () => {
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true })
    vi.stubGlobal('location', { origin: 'https://localhost' })
    expect(shareOrigin()).toBe('https://flock.forgesworn.dev')
  })
})

describe('isApkUpdateAvailable', () => {
  it('flags an update when a different APK build is published', () => {
    expect(isApkUpdateAvailable('cd123e9', '065186b')).toBe(true)
  })

  it('does NOT flag an update when the published APK build matches the installed one', () => {
    // The regression this fixes: a website-only redeploy leaves apk.json untouched,
    // so the shell no longer nags after every content deploy.
    expect(isApkUpdateAvailable('065186b', '065186b')).toBe(false)
  })

  it('ignores the +dev dirty-tree suffix — a dev’s own build of a commit is not "out of date" against the clean release of that same commit', () => {
    expect(isApkUpdateAvailable('cd123e9+dev', 'cd123e9')).toBe(false)
    expect(isApkUpdateAvailable('cd123e9', 'cd123e9+dev')).toBe(false)
    expect(isApkUpdateAvailable('cd123e9+dev', 'cd123e9+dev')).toBe(false)
  })

  it('still flags a genuinely newer commit even from a dirty build', () => {
    expect(isApkUpdateAvailable('cd123e9+dev', '065186b')).toBe(true)
  })

  it('is never an update when nothing is published (offline, or no APK shipped yet)', () => {
    expect(isApkUpdateAvailable('065186b', undefined)).toBe(false)
    expect(isApkUpdateAvailable('065186b', null)).toBe(false)
    expect(isApkUpdateAvailable('065186b', '')).toBe(false)
  })
})
