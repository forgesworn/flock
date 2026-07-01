import { describe, it, expect } from 'vitest'
import { generateSecretKey } from 'nostr-tools/pure'
import { makeLocalSigner } from './signer'
import { buildInviteWrap, buildReseedWraps, readInvite, type InvitePayload } from './invite'
import { personalInboxTag } from './keys'

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const signer = () => makeLocalSigner(hex(generateSecretKey()))

const SEED = `${'00'.repeat(31)}01`
const payload: InvitePayload = { t: 'invite', id: 'circle-1', s: SEED, n: 'The Smiths', m: 'family' }

describe('signer-based NIP-59 gift-wrapped invites', () => {
  it('round-trips: the recipient unwraps the seed', async () => {
    const alice = signer()
    const bob = signer()
    const wrap = await buildInviteWrap(alice, bob.pubkey, payload)
    expect(wrap.kind).toBe(1059)
    // Filed under Bob's derived personal-inbox tag, NOT his npub — the real key
    // never lands on the wire, yet Bob (who can recompute the tag) still receives it.
    const pTag = wrap.tags.find((t) => t[0] === 'p')?.[1]
    expect(pTag).toBe(personalInboxTag(bob.pubkey))
    expect(pTag).not.toBe(bob.pubkey)
    expect(await readInvite(bob, wrap)).toEqual(payload)
  })

  it('a non-recipient CANNOT unwrap the seed', async () => {
    const alice = signer()
    const bob = signer()
    const eve = signer()
    const wrap = await buildInviteWrap(alice, bob.pubkey, payload)
    expect(await readInvite(eve, wrap)).toBeNull()
  })

  it('reseed payloads round-trip, one wrap per recipient', async () => {
    const alice = signer()
    const bob = signer()
    const carol = signer()
    const reseed: InvitePayload = { t: 'reseed', id: 'circle-1', s: 'ff'.repeat(32), n: 'X', m: 'nightout' }
    const wraps = await buildReseedWraps(alice, [bob.pubkey, carol.pubkey], reseed)
    expect(wraps).toHaveLength(2)
    expect(await readInvite(bob, wraps[0])).toEqual(reseed)
    expect(await readInvite(carol, wraps[1])).toEqual(reseed)
    expect(await readInvite(carol, wraps[0])).toBeNull()
  })
})
