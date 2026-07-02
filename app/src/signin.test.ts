import { describe, it, expect } from 'vitest'
import { buildSignInOptions, SIGN_IN_METHODS, SIGN_IN_ADVANCED, SIGN_IN_PERMS } from './signin'

const RELAYS = ['wss://relay.trotters.cc', 'wss://relay2.example']

describe('sign-in picker config', () => {
  // SAFETY: pasting a raw private key into flock is the exact risk the
  // remote-signer path exists to remove — it must never be an offered method.
  it('never offers the nsec (raw private key) method', () => {
    expect(SIGN_IN_METHODS).not.toContain('nsec')
    expect(buildSignInOptions('flock', RELAYS).methods).not.toContain('nsec')
  })

  it('offers every "key stays in the signer" path', () => {
    for (const m of ['local-signet', 'remote-signet', 'nip07', 'amber', 'bunker', 'nostrconnect']) {
      expect(SIGN_IN_METHODS).toContain(m)
    }
  })

  it('tucks the paste flows under Advanced but keeps them reachable', () => {
    expect(SIGN_IN_ADVANCED).toEqual(['bunker', 'nostrconnect'])
    for (const m of SIGN_IN_ADVANCED) expect(SIGN_IN_METHODS).toContain(m)
  })

  it('requests NIP-44 perms up front (gift-wrap needs them)', () => {
    expect(SIGN_IN_PERMS).toContain('nip44_encrypt')
    expect(SIGN_IN_PERMS).toContain('nip44_decrypt')
    expect(buildSignInOptions('flock', RELAYS).nostrConnectPerms).toContain('nip44_encrypt')
  })

  it('rides flock\'s private relay set for both Signet and NIP-46 transport', () => {
    const opts = buildSignInOptions('flock', RELAYS)
    expect(opts.relayUrl).toBe(RELAYS[0])
    expect(opts.relayUrls).toEqual(RELAYS)
    expect(opts.appName).toBe('flock')
  })
})
