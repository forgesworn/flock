// Deterministic circle-key derivation via nsec-tree.
//
// A circle's shared seed is derived from this device's circle-root, the circle
// id, and an epoch — instead of a flat random seed. Benefits:
//   - recoverable: re-derive any seed from one root + (circleId, epoch),
//   - reseed = epoch + 1 (no stored randomness),
//   - per-circle, per-root derivation → unlinkable circles.
//
// The circle-root is a local secret, separate from the (possibly remote/Signet)
// signing identity, and is the single thing to back up (e.g. via shamir-words).

import { fromNsec, derive } from 'nsec-tree'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { fromHex } from './store'

const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const enc = new TextEncoder()

/** Derive a circle's 64-hex shared seed for a given epoch. Reseed = epoch + 1. */
export function deriveCircleSeed(circleRootHex: string, circleId: string, epoch: number): string {
  const root = fromNsec(fromHex(circleRootHex))
  const identity = derive(root, `flock:circle:${circleId}`, epoch)
  return toHex(identity.privateKey)
}

/**
 * Derive the circle's shared **group-inbox** keypair from its seed. Every member
 * derives the same one. Signals are gift-wrapped (NIP-59) p-tagged to this pubkey,
 * so the relay sees only `kind:1059` to an opaque inbox — no real pubkeys, types,
 * or roster. It rotates whenever the seed rotates (reseed = new epoch = new inbox).
 */
export function deriveInbox(seedHex: string): { sk: Uint8Array; pk: string } {
  const id = derive(fromNsec(fromHex(seedHex)), 'flock:inbox', 0)
  return { sk: id.privateKey, pk: toHex(id.publicKey) }
}

/**
 * A stable, non-reversible routing tag for a member's **personal inbox** — used as
 * the `#p` tag on invite/reseed gift wraps instead of the member's real pubkey.
 *
 * The wrap is still NIP-44 encrypted to the real key (so only they can decrypt);
 * this tag only tells the relay *where to file it*. Anyone who already knows the
 * member's npub can recompute the tag to address them, but the relay — which never
 * learns the npub — sees only an opaque hash it cannot reverse. This closes the one
 * place a real, public Nostr identity used to touch the wire (the invite/reseed
 * channel); steady-state signals already use a rotating derived inbox.
 *
 * Static (not time-rotated) on purpose: a removal-reseed must still be received if
 * it was sent while the member was offline for days, which a rotating tag would miss.
 */
export function personalInboxTag(pubHex: string): string {
  return bytesToHex(sha256(enc.encode(`flock:personal-inbox:v1:${pubHex.toLowerCase()}`)))
}
