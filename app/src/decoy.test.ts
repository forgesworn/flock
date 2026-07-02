import { describe, it, expect } from 'vitest'
import { newSalt, deriveDecoyKey, sealState, openState, dummyWork } from './decoy'

// A plausible persisted-state snapshot — what sealState actually protects.
const STATE = JSON.stringify({
  identity: { pk: 'a'.repeat(64), skHex: 'b'.repeat(64) },
  circles: [{ id: 'c'.repeat(64), name: 'The Smiths', seedHex: 'd'.repeat(64), mode: 'family', members: ['a'.repeat(64)] }],
  activeCircleId: 'c'.repeat(64),
  relayUrls: ['wss://relay.trotters.cc'],
  noReportZones: [],
  petnames: {},
  presence: {},
  decoy: { salt: 'xyz', key: 'abc' },
})

describe('decoy — seal/open the hidden state', () => {
  it('round-trips the state under the phrase', async () => {
    const salt = newSalt()
    const key = await deriveDecoyKey('correct horse battery', salt)
    const sealed = await sealState(STATE, salt, key)
    expect(await openState(sealed, 'correct horse battery')).toBe(STATE)
  })

  it('rejects a wrong phrase', async () => {
    const salt = newSalt()
    const key = await deriveDecoyKey('correct horse battery', salt)
    const sealed = await sealState(STATE, salt, key)
    await expect(openState(sealed, 'wrong phrase')).rejects.toThrow()
  })

  it('rejects a tampered blob', async () => {
    const salt = newSalt()
    const key = await deriveDecoyKey('correct horse battery', salt)
    const sealed = await sealState(STATE, salt, key)
    const inner = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(sealed), (c) => c.charCodeAt(0)))) as { d: string }
    inner.d = inner.d.slice(0, -4) + (inner.d.endsWith('AAAA') ? 'BBBB' : 'AAAA')
    const tampered = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(inner))))
    await expect(openState(tampered, 'correct horse battery')).rejects.toThrow()
  })

  it('rejects garbage that is not a sealed blob at all', async () => {
    await expect(openState('not a blob', 'any phrase')).rejects.toThrow()
    await expect(openState(btoa('{"s":"x"}'), 'any phrase')).rejects.toThrow()
  })

  // SAFETY: the blob must not announce what it is — no magic string, no
  // plaintext leakage of names or key material a coercer could grep for.
  it('carries no plaintext tell', async () => {
    const salt = newSalt()
    const key = await deriveDecoyKey('correct horse battery', salt)
    const sealed = await sealState(STATE, salt, key)
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(sealed), (c) => c.charCodeAt(0)))
    for (const tell of ['flock', 'The Smiths', 'seedHex', 'circle', 'decoy', 'd'.repeat(64)]) {
      expect(sealed).not.toContain(tell)
      expect(decoded).not.toContain(tell)
    }
  })

  // SAFETY: never trust a decrypt into becoming app state unless it looks
  // like one — a stray blob under the right phrase must not brick the boot.
  it('refuses a decrypt that is not a plausible state', async () => {
    const salt = newSalt()
    const key = await deriveDecoyKey('correct horse battery', salt)
    const sealed = await sealState('{"just":"junk"}', salt, key)
    await expect(openState(sealed, 'correct horse battery')).rejects.toThrow()
  })

  it('derives deterministically per salt, differently across salts', async () => {
    const salt = newSalt()
    expect(await deriveDecoyKey('phrase', salt)).toBe(await deriveDecoyKey('phrase', salt))
    expect(await deriveDecoyKey('phrase', newSalt())).not.toBe(await deriveDecoyKey('phrase', salt))
  })

  it('dummyWork resolves (the constant-time filler for the no-cache path)', async () => {
    await expect(dummyWork('any phrase')).resolves.toBeUndefined()
  })
})
