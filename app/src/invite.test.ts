import { describe, it, expect } from 'vitest'
import { generateSecretKey } from 'nostr-tools/pure'
import { makeLocalSigner } from './signer'
import { buildInviteWrap, buildReseedWraps, readInvite, buildMeetingExactWrap, readMeetingExactWrap, buildDmWrap, readDmWrap, type InvitePayload } from './invite'
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

describe('targeted EXACT meeting-point share (personal-inbox gift-wrap)', () => {
  const exactShare = { requestId: 'mtg-1', member: 'a'.repeat(64), geohash: 'gcpvj0zab', precision: 9, mode: 'walk' as const, timestamp: 1_700_000_000 }

  it('round-trips to the one recipient, filed under their personal-inbox tag', async () => {
    const contributor = signer()
    const proposer = signer()
    const wrap = await buildMeetingExactWrap(contributor, proposer.pubkey, exactShare)
    expect(wrap.kind).toBe(1059)
    // Routed to the proposer's derived tag, never their npub — nothing on the wire ties it to them.
    const pTag = wrap.tags.find((t) => t[0] === 'p')?.[1]
    expect(pTag).toBe(personalInboxTag(proposer.pubkey))
    expect(pTag).not.toBe(proposer.pubkey)
    expect(await readMeetingExactWrap(proposer, wrap)).toEqual(exactShare)
  })

  it('the exact spot is readable ONLY by the named recipient (the privacy invariant)', async () => {
    const contributor = signer()
    const proposer = signer()
    const eve = signer()
    const wrap = await buildMeetingExactWrap(contributor, proposer.pubkey, exactShare)
    expect(await readMeetingExactWrap(eve, wrap)).toBeNull()
  })

  it('an invite is never mistaken for an exact share, and vice versa (fall-through dispatch)', async () => {
    const alice = signer()
    const bob = signer()
    const inviteWrap = await buildInviteWrap(alice, bob.pubkey, payload)
    expect(await readMeetingExactWrap(bob, inviteWrap)).toBeNull() // an invite is not an exact share
    const exactWrap = await buildMeetingExactWrap(alice, bob.pubkey, exactShare)
    expect(await readInvite(bob, exactWrap)).toBeNull() // an exact share is not an invite
  })
})

describe('private direct message (personal-inbox gift-wrap)', () => {
  it('round-trips to the one recipient, filed under their personal-inbox tag, sender attributed', async () => {
    const alice = signer()
    const bob = signer()
    const wrap = await buildDmWrap(alice, bob.pubkey, { circleId: 'circle-1', text: 'on my way to you' })
    expect(wrap.kind).toBe(1059)
    // Routed to Bob's derived tag, never his npub — nothing on the wire ties it to him.
    const pTag = wrap.tags.find((t) => t[0] === 'p')?.[1]
    expect(pTag).toBe(personalInboxTag(bob.pubkey))
    expect(pTag).not.toBe(bob.pubkey)
    // The sender is recovered from the seal (the rumor's pubkey), not carried in plaintext.
    expect(await readDmWrap(bob, wrap)).toEqual({ from: alice.pubkey, circleId: 'circle-1', text: 'on my way to you' })
  })

  it('is readable ONLY by the named recipient — the whole circle cannot read it (privacy invariant)', async () => {
    const alice = signer()
    const bob = signer()
    const eve = signer()
    const wrap = await buildDmWrap(alice, bob.pubkey, { circleId: 'circle-1', text: 'secret' })
    expect(await readDmWrap(eve, wrap)).toBeNull()
  })

  it('a whitespace-only message is rejected, and text is trimmed', async () => {
    const alice = signer()
    const bob = signer()
    const blank = await buildDmWrap(alice, bob.pubkey, { circleId: 'c', text: '   ' })
    expect(await readDmWrap(bob, blank)).toBeNull()
    const padded = await buildDmWrap(alice, bob.pubkey, { circleId: 'c', text: '  hi  ' })
    expect((await readDmWrap(bob, padded))?.text).toBe('hi')
  })

  it('a DM is never mistaken for an invite or exact share (fall-through dispatch)', async () => {
    const alice = signer()
    const bob = signer()
    const dm = await buildDmWrap(alice, bob.pubkey, { circleId: 'c', text: 'hi' })
    expect(await readInvite(bob, dm)).toBeNull()
    expect(await readMeetingExactWrap(bob, dm)).toBeNull()
    const inviteWrap = await buildInviteWrap(alice, bob.pubkey, payload)
    expect(await readDmWrap(bob, inviteWrap)).toBeNull()
  })
})
