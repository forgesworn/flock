import { describe, it, expect, afterEach, vi } from 'vitest'
import { isNativeShell, shareOrigin } from './native'

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
