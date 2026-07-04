import { describe, it, expect } from 'vitest'
import { parseRelayList, resolveRelays, isKnownNoLogRelay, unknownRelays, torRouteReady, effectiveRelays, PRIVATE_RELAYS } from './relays'

describe('parseRelayList', () => {
  it('splits one-per-line and trims each', () => {
    expect(parseRelayList('wss://a.example\n  wss://b.example  ')).toEqual(['wss://a.example', 'wss://b.example'])
  })

  it('drops blank lines and anything that is not a ws(s) URL', () => {
    expect(parseRelayList('wss://a.example\n\nhttp://nope.example\nnot-a-url\nws://b.example'))
      .toEqual(['wss://a.example', 'ws://b.example'])
  })

  it('dedupes, keeping first-occurrence order', () => {
    expect(parseRelayList('wss://a.example\nwss://b.example\nwss://a.example'))
      .toEqual(['wss://a.example', 'wss://b.example'])
  })

  it('accepts commas and mixed whitespace as separators (paste-friendly)', () => {
    expect(parseRelayList('wss://a.example, wss://b.example')).toEqual(['wss://a.example', 'wss://b.example'])
  })

  it('returns [] for empty or all-invalid input', () => {
    expect(parseRelayList('')).toEqual([])
    expect(parseRelayList('   \n  ')).toEqual([])
    expect(parseRelayList('http://x\nnope')).toEqual([])
  })
})

describe('resolveRelays (persisted-state migration)', () => {
  it('defaults to PRIVATE_RELAYS when nothing is saved', () => {
    expect(resolveRelays()).toEqual([...PRIVATE_RELAYS])
    expect(resolveRelays({})).toEqual([...PRIVATE_RELAYS])
  })

  it('migrates a legacy single relayUrl into a one-element list', () => {
    expect(resolveRelays({ relayUrl: 'wss://mine.example' })).toEqual(['wss://mine.example'])
  })

  it('uses a saved relayUrls list, cleaned + deduped', () => {
    expect(resolveRelays({ relayUrls: ['wss://a.example', 'wss://a.example', 'bad', 'wss://b.example'] }))
      .toEqual(['wss://a.example', 'wss://b.example'])
  })

  it('prefers relayUrls over a legacy relayUrl', () => {
    expect(resolveRelays({ relayUrls: ['wss://new.example'], relayUrl: 'wss://old.example' }))
      .toEqual(['wss://new.example'])
  })

  it('falls back to defaults when saved values are empty or all invalid', () => {
    expect(resolveRelays({ relayUrls: [] })).toEqual([...PRIVATE_RELAYS])
    expect(resolveRelays({ relayUrls: ['nope', 'http://x'] })).toEqual([...PRIVATE_RELAYS])
    expect(resolveRelays({ relayUrl: 'not-a-relay' })).toEqual([...PRIVATE_RELAYS])
  })
})

// F5 hardening: the settings relay textarea used to accept any relay silently —
// warn when one falls outside the pre-vetted no-log set, so adding a random
// public relay is a deliberate, informed choice rather than a silent leak.
describe('isKnownNoLogRelay / unknownRelays (F5 — warn on an unvetted relay)', () => {
  it('every PRIVATE_RELAYS entry is known', () => {
    for (const r of PRIVATE_RELAYS) expect(isKnownNoLogRelay(r)).toBe(true)
  })

  it('a relay outside the vetted set is not known', () => {
    expect(isKnownNoLogRelay('wss://nos.lol')).toBe(false)
    expect(isKnownNoLogRelay('wss://some-random-relay.example')).toBe(false)
  })

  it('unknownRelays returns only the entries outside the vetted set, order preserved', () => {
    expect(unknownRelays([...PRIVATE_RELAYS, 'wss://nos.lol'])).toEqual(['wss://nos.lol'])
    expect(unknownRelays([...PRIVATE_RELAYS])).toEqual([])
  })
})

// Tor `.onion` relay endpoint (mesh-bridge-goal Task B) — opt-in, fail-loud.
// DarkFi reverted Tor-by-default (unreliable on mobile), so this is a toggle,
// never automatic, and it must NEVER silently fall back to clearnet: the user
// chose the property (no IP exposure), and a silent downgrade is exactly the
// leak the toggle exists to close.
describe('torRouteReady', () => {
  const READY = { torEnabled: true, onionRelays: ['ws://abc.onion'], orbotDetected: true }

  it('is ready only when all three conditions hold', () => {
    expect(torRouteReady(READY)).toBe(true)
  })

  it('is not ready when the toggle is off', () => {
    expect(torRouteReady({ ...READY, torEnabled: false })).toBe(false)
  })

  it('is not ready when no .onion relay is configured', () => {
    expect(torRouteReady({ ...READY, onionRelays: [] })).toBe(false)
  })

  it('is not ready when Orbot was not detected', () => {
    expect(torRouteReady({ ...READY, orbotDetected: false })).toBe(false)
  })
})

describe('effectiveRelays (fail-loud Tor routing)', () => {
  const clearnetRelays = ['wss://relay.trotters.cc']
  const onionRelays = ['ws://abc123.onion']

  it('returns the clearnet set unchanged when the toggle is off (default — byte-for-byte unaffected)', () => {
    expect(effectiveRelays({ clearnetRelays, onionRelays, torEnabled: false, orbotDetected: false })).toEqual(clearnetRelays)
    expect(effectiveRelays({ clearnetRelays, onionRelays, torEnabled: false, orbotDetected: true })).toEqual(clearnetRelays)
  })

  it('returns the .onion set when the toggle is on and the route is ready', () => {
    expect(effectiveRelays({ clearnetRelays, onionRelays, torEnabled: true, orbotDetected: true })).toEqual(onionRelays)
  })

  it('FAILS LOUD (throws) rather than falling back to clearnet when the toggle is on but no .onion relay is configured', () => {
    expect(() => effectiveRelays({ clearnetRelays, onionRelays: [], torEnabled: true, orbotDetected: true })).toThrow()
  })

  it('FAILS LOUD (throws) rather than falling back to clearnet when the toggle is on but Orbot is not detected', () => {
    expect(() => effectiveRelays({ clearnetRelays, onionRelays, torEnabled: true, orbotDetected: false })).toThrow()
  })
})
