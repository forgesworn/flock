// NIP-59 gift wrap — the metadata-hiding envelope used for BOTH private invites
// and (gift-wrap-everything) every live signal.
//
// A wrapped event is `kind:1059` from a throwaway key, p-tagged to a recipient.
// The relay sees only that. Inside: a seal (kind:13) signed by the sender's real
// signer, holding the rumor (real sender + kind + content). Decryption needs the
// recipient's key — a member's real key for invites, or the shared group-inbox
// key for signals.
//
// Because a wrap is self-contained, opaque, encrypted bytes, it can travel over
// ANY transport — a Nostr relay today, a LoRa mesh (Meshtastic/MeshCore) later.

import { finalizeEvent, generateSecretKey, getEventHash } from 'nostr-tools/pure'
import { getConversationKey, encrypt as nip44encrypt, decrypt as nip44decrypt } from 'nostr-tools/nip44'
import type { FlockSigner, SignedEvent } from './signer'

const nowSec = (): number => Math.floor(Date.now() / 1000)
// NIP-59: randomise created_at up to 2 days in the past to blur timing.
const wrapTime = (): number => nowSec() - Math.floor(Math.random() * 172_800)

// NIP-40: every wrap expires this long after its created_at, bounding how far
// back a future key compromise can decrypt relay-stored history. ONE window for
// all wrap types (a per-type window would be a type-tell), derived from the
// already-backdated created_at (real time would undo the timing blur) — so the
// tag carries zero information beyond created_at itself. 16 days clears the
// 2-day backdating while leaving ~2 weeks for offline members to catch up.
export const WRAP_EXPIRY_SECONDS = 16 * 86_400

export interface InnerEvent { kind: number; content: string; tags: string[][]; created_at?: number }
export interface Rumor { pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; id?: string }

/** Gift-wrap an inner event to a recipient pubkey. Seal signed by the signer
 *  (real key), wrap signed by a throwaway key. Hides sender, kind, and tags.
 *
 *  `routeTag` is the `#p` value the relay files the wrap under; it defaults to
 *  `recipientPk`. Encryption is ALWAYS to `recipientPk`, so decryption is
 *  unaffected — pass a derived tag (e.g. `personalInboxTag`) to keep a real npub
 *  off the wire while still delivering to that recipient. */
export async function giftWrap(signer: FlockSigner, recipientPk: string, inner: InnerEvent, routeTag: string = recipientPk): Promise<SignedEvent> {
  const rumor: Rumor = {
    pubkey: signer.pubkey,
    created_at: inner.created_at ?? nowSec(),
    kind: inner.kind,
    tags: inner.tags,
    content: inner.content,
  }
  const rumorWithId = { ...rumor, id: getEventHash(rumor) }
  const sealContent = await signer.nip44Encrypt(recipientPk, JSON.stringify(rumorWithId))
  const seal = await signer.signEvent({ kind: 13, content: sealContent, tags: [], created_at: wrapTime() })
  const ephSk = generateSecretKey()
  const wrapContent = nip44encrypt(JSON.stringify(seal), getConversationKey(ephSk, recipientPk))
  const created_at = wrapTime()
  return finalizeEvent(
    { kind: 1059, content: wrapContent, tags: [['p', routeTag], ['expiration', String(created_at + WRAP_EXPIRY_SECONDS)]], created_at },
    ephSk,
  ) as unknown as SignedEvent
}

/** Unwrap a gift wrap with a nip44-decrypt function. Returns the rumor or null. */
export async function giftUnwrap(
  decrypt: (peerPk: string, ciphertext: string) => Promise<string> | string,
  wrap: { pubkey: string; content: string },
): Promise<Rumor | null> {
  try {
    const seal = JSON.parse(await decrypt(wrap.pubkey, wrap.content)) as { pubkey: string; content: string }
    return JSON.parse(await decrypt(seal.pubkey, seal.content)) as Rumor
  } catch {
    return null
  }
}

/** A nip44 decrypt closure for a raw secret key (the shared group-inbox key). */
export function rawNip44Decrypt(skBytes: Uint8Array): (peerPk: string, ciphertext: string) => string {
  return (peerPk, ciphertext) => nip44decrypt(ciphertext, getConversationKey(skBytes, peerPk))
}
