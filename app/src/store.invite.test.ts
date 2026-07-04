import { describe, it, expect } from 'vitest'
import { createCircle, encodeInvite, decodeInvite, inviteLink, inviteCodeFrom } from './store'

const circle = () => createCircle('The Smiths', 'family', 'aa'.repeat(32), 'bb'.repeat(32))

describe('invite links — the secret rides in the URL fragment, never sent to a server', () => {
  // A QR of bare text gets "Search Google for this?" from camera apps — which
  // would hand the SEED to a search engine. A QR of a link opens flock instead.
  it('builds origin/#join=<code> and round-trips through decodeInvite', () => {
    const c = circle()
    const link = inviteLink(c, 'https://flock.example')
    expect(link.startsWith('https://flock.example/#join=')).toBe(true)
    const decoded = decodeInvite(inviteCodeFrom(link))
    expect(decoded.id).toBe(c.id)
    expect(decoded.seedHex).toBe(c.seedHex)
    expect(decoded.name).toBe('The Smiths')
  })

  it('inviteCodeFrom accepts a bare code, a full link, and stray whitespace', () => {
    const code = encodeInvite(circle())
    expect(inviteCodeFrom(code)).toBe(code)
    expect(inviteCodeFrom(`  ${code}\n`)).toBe(code)
    expect(inviteCodeFrom(`https://flock.example/#join=${code}`)).toBe(code)
  })

  // A blank field or a mangled paste must never leak a raw JSON parser error
  // ("Unexpected end of JSON input") to the user — always the friendly message.
  it('decodeInvite throws a friendly error for empty / whitespace / garbage input', () => {
    for (const bad of ['', '   ', '\n', 'not base64 !!!', btoa('hello'), btoa('{"v":1'), '#join=']) {
      expect(() => decodeInvite(inviteCodeFrom(bad))).toThrow(/invite code/i)
      expect(() => decodeInvite(inviteCodeFrom(bad))).not.toThrow(/JSON/i)
    }
  })
})
