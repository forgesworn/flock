import { describe, it, expect } from 'vitest'
import { parseRelayList, resolveRelays, PRIVATE_RELAYS } from './relays'

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
