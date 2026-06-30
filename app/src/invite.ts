// Secure invites & reseed — NIP-59 gift wrap addressed to a recipient's real key
// (via the shared giftwrap module). The seal is signed by the member's signer
// (LocalSigner or Signet), so a key in a bunker works too.

import { giftWrap, giftUnwrap } from './giftwrap'
import type { FlockSigner, SignedEvent } from './signer'
import type { Mode } from './store'

export interface InvitePayload {
  t: 'invite' | 'reseed'
  id: string
  s: string // seed hex
  n: string // circle name
  m: Mode
}

const RUMOR_KIND = 14
const SEED_RE = /^[0-9a-f]{64}$/

/** Gift-wrap an invite/reseed payload to a single recipient pubkey via the signer. */
export function buildInviteWrap(signer: FlockSigner, recipientPk: string, payload: InvitePayload): Promise<SignedEvent> {
  return giftWrap(signer, recipientPk, { kind: RUMOR_KIND, content: JSON.stringify(payload), tags: [] })
}

/** Gift-wrap a reseed payload to many recipients. */
export function buildReseedWraps(signer: FlockSigner, recipientPks: string[], payload: InvitePayload): Promise<SignedEvent[]> {
  return Promise.all(recipientPks.map((pk) => buildInviteWrap(signer, pk, payload)))
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
      }
    }
  } catch { /* malformed */ }
  return null
}
