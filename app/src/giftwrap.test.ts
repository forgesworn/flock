import { describe, it, expect } from 'vitest'
import { generateSecretKey } from 'nostr-tools/pure'
import { makeLocalSigner } from './signer'
import { giftWrap, giftUnwrap, rawNip44Decrypt } from './giftwrap'
import { deriveInbox } from './keys'

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const signer = () => makeLocalSigner(hex(generateSecretKey()))
const SEED = '11'.repeat(32)

describe('gift-wrap-everything: signals via the shared inbox', () => {
  it('hides sender + type from the relay; a member recovers both', async () => {
    const sender = signer()
    const inbox = deriveInbox(SEED) // both sides derive the same inbox from the seed
    const inner = { kind: 20_078, content: 'encrypted-beacon-blob', tags: [['t', 'beacon']] }
    const wrap = await giftWrap(sender, inbox.pk, inner)

    // What the relay sees:
    expect(wrap.kind).toBe(1059)
    expect(wrap.pubkey).not.toBe(sender.pubkey) // ephemeral sender, not the real one
    expect(wrap.tags.find((t) => t[0] === 'p')?.[1]).toBe(inbox.pk) // opaque inbox, not a member
    expect(JSON.stringify(wrap)).not.toContain('beacon') // the type is hidden

    // What a member (holding the inbox key) recovers:
    const rumor = await giftUnwrap(rawNip44Decrypt(inbox.sk), wrap)
    expect(rumor?.pubkey).toBe(sender.pubkey) // real sender, inside the encryption
    expect(rumor?.tags).toEqual([['t', 'beacon']])
    expect(rumor?.content).toBe('encrypted-beacon-blob')
  })

  it('a non-member (wrong seed → wrong inbox key) cannot unwrap', async () => {
    const sender = signer()
    const inbox = deriveInbox(SEED)
    const wrong = deriveInbox('22'.repeat(32))
    const wrap = await giftWrap(sender, inbox.pk, { kind: 20_078, content: 'x', tags: [] })
    expect(await giftUnwrap(rawNip44Decrypt(wrong.sk), wrap)).toBeNull()
  })

  it('the inbox rotates when the seed rotates (reseed)', () => {
    expect(deriveInbox(SEED).pk).not.toBe(deriveInbox('33'.repeat(32)).pk)
    expect(deriveInbox(SEED).pk).toBe(deriveInbox(SEED).pk) // deterministic
  })
})
