// Secure invites & reseed — NIP-59 gift wrap encrypted to a recipient's real key,
// but filed at the relay under a derived `personalInboxTag` (not the npub) so a
// real, public Nostr identity never lands on the wire. The seal is signed by the
// member's signer (LocalSigner or Signet), so a key in a bunker works too.

import { giftWrap, giftUnwrap } from './giftwrap'
import { personalInboxTag } from './keys'
import { parseMeetingShare, type MeetingShare } from '@forgesworn/flock'
import type { FlockSigner, SignedEvent } from './signer'
import type { Mode } from './store'

export interface InvitePayload {
  t: 'invite' | 'reseed'
  id: string
  s: string // seed hex
  n: string // circle name
  m: Mode
  x?: number // transient expiry (unix sec), if any
}

const RUMOR_KIND = 14
const SEED_RE = /^[0-9a-f]{64}$/

/** Gift-wrap an invite/reseed payload to a single recipient pubkey via the signer.
 *  Encrypted to their real key; filed at the relay under `personalInboxTag` so the
 *  npub itself is never exposed. */
export function buildInviteWrap(signer: FlockSigner, recipientPk: string, payload: InvitePayload): Promise<SignedEvent> {
  return giftWrap(signer, recipientPk, { kind: RUMOR_KIND, content: JSON.stringify(payload), tags: [] }, personalInboxTag(recipientPk))
}

/** Gift-wrap a reseed payload to many recipients. */
export function buildReseedWraps(signer: FlockSigner, recipientPks: string[], payload: InvitePayload): Promise<SignedEvent[]> {
  return Promise.all(recipientPks.map((pk) => buildInviteWrap(signer, pk, payload)))
}

// An EXACT meeting-point share, targeted at ONE recipient (the proposer) via the
// same personal-inbox channel as invites. The group inbox still gets only the
// coarse cell; this rides gift-wrap so the precise spot reaches that one person and
// no one else. Same rumour kind as invites; distinguished by the payload `t`.
interface MeetingExactPayload { t: 'mtg-loc'; share: MeetingShare }

/** Gift-wrap an EXACT meeting-point share to one recipient (the proposer). Encrypted
 *  to their real key; filed under `personalInboxTag` so the npub stays off the wire.
 *  Only they can decrypt the exact spot — everyone else sees only the coarse cell. */
export function buildMeetingExactWrap(signer: FlockSigner, recipientPk: string, share: MeetingShare): Promise<SignedEvent> {
  const payload: MeetingExactPayload = { t: 'mtg-loc', share }
  return giftWrap(signer, recipientPk, { kind: RUMOR_KIND, content: JSON.stringify(payload), tags: [] }, personalInboxTag(recipientPk))
}

/** Unwrap a personal-inbox wrap as an exact meeting share; null if it isn't one (or
 *  isn't addressed to us). Validated via the library's non-throwing parser. */
export async function readMeetingExactWrap(signer: FlockSigner, wrap: { pubkey: string; content: string }): Promise<MeetingShare | null> {
  const rumor = await giftUnwrap((pk, ct) => signer.nip44Decrypt(pk, ct), wrap)
  if (!rumor) return null
  try {
    const o = JSON.parse(rumor.content) as Record<string, unknown>
    if (o.t !== 'mtg-loc') return null
    return parseMeetingShare(o.share)
  } catch {
    return null
  }
}

// A private DIRECT MESSAGE to ONE member — free text, encrypted to their real key
// and filed under their personal-inbox tag, exactly like an invite. It deliberately
// does NOT ride the shared circle inbox (a "buzz" does): only the named recipient
// can read it, so "message just this person" is honest on the wire. Same rumour
// kind as invites; distinguished by the payload `t`. The sender is recovered from
// the seal (the rumor's real pubkey), never carried in plaintext.
interface DmPayload { t: 'dm'; c: string; text: string }

/** A decrypted direct message: who sent it, which circle it belongs to, the text. */
export interface DirectMessage { from: string; circleId: string; text: string }

// A single wrap can't carry a novel, and an oversized message is a memory/notify
// hazard — bound it. Trimmed on the way out so a fat paste can't smuggle length.
const MAX_DM_LEN = 500

/** Gift-wrap a private direct message to one recipient. Encrypted to their real key;
 *  filed under `personalInboxTag` so the npub stays off the wire. Only they can read it. */
export function buildDmWrap(signer: FlockSigner, recipientPk: string, msg: { circleId: string; text: string }): Promise<SignedEvent> {
  const payload: DmPayload = { t: 'dm', c: msg.circleId, text: msg.text.trim().slice(0, MAX_DM_LEN) }
  return giftWrap(signer, recipientPk, { kind: RUMOR_KIND, content: JSON.stringify(payload), tags: [] }, personalInboxTag(recipientPk))
}

/** Unwrap a personal-inbox wrap as a direct message; null if it isn't one (or isn't
 *  addressed to us, or is empty). The sender is the seal's real pubkey. */
export async function readDmWrap(signer: FlockSigner, wrap: { pubkey: string; content: string }): Promise<DirectMessage | null> {
  const rumor = await giftUnwrap((pk, ct) => signer.nip44Decrypt(pk, ct), wrap)
  if (!rumor) return null
  try {
    const o = JSON.parse(rumor.content) as Record<string, unknown>
    if (o.t !== 'dm' || typeof o.c !== 'string' || typeof o.text !== 'string') return null
    const text = o.text.trim().slice(0, MAX_DM_LEN)
    if (!text) return null
    return { from: rumor.pubkey, circleId: o.c, text }
  } catch {
    return null
  }
}

/** Unwrap a gift wrap addressed to us (via the signer); returns the invite payload or null. */
export async function readInvite(signer: FlockSigner, wrap: { pubkey: string; content: string }): Promise<InvitePayload | null> {
  const rumor = await giftUnwrap((pk, ct) => signer.nip44Decrypt(pk, ct), wrap)
  if (!rumor) return null
  try {
    const o = JSON.parse(rumor.content) as Record<string, unknown>
    if ((o.t === 'invite' || o.t === 'reseed') && typeof o.id === 'string' && typeof o.s === 'string' && SEED_RE.test(o.s)) {
      return {
        t: o.t,
        id: o.id,
        s: o.s,
        n: typeof o.n === 'string' ? o.n : 'Circle',
        m: o.m === 'nightout' ? 'nightout' : 'family',
        ...(typeof o.x === 'number' ? { x: o.x } : {}),
      }
    }
  } catch { /* malformed */ }
  return null
}
