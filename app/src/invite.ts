// Secure invites & reseed via NIP-59 gift wrap.
//
// The circle seed is the shared secret. The in-person path (QR of the seed code)
// keeps it off any network. For remote onboarding we gift-wrap the seed to a
// specific recipient pubkey — only they can open it, and the relay learns
// neither sender nor contents. The same mechanism distributes a fresh seed on
// reseed / member removal.

import { wrapEvent, wrapManyEvents, unwrapEvent } from 'nostr-tools/nip59'
import { fromHex } from './store'
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

function rumor(payload: InvitePayload) {
  return { kind: RUMOR_KIND, content: JSON.stringify(payload), tags: [] as string[][] }
}

/** Gift-wrap an invite/reseed payload to a single recipient pubkey. */
export function buildInviteWrap(senderSkHex: string, recipientPk: string, payload: InvitePayload) {
  return wrapEvent(rumor(payload), fromHex(senderSkHex), recipientPk)
}

/** Gift-wrap a reseed payload to many recipients (one randomised wrap each). */
export function buildReseedWraps(senderSkHex: string, recipientPks: string[], payload: InvitePayload) {
  return wrapManyEvents(rumor(payload), fromHex(senderSkHex), recipientPks)
}

/** Unwrap a gift wrap addressed to us; returns the invite payload or null. */
export function readInvite(wrap: unknown, mySkHex: string): InvitePayload | null {
  try {
    const r = unwrapEvent(wrap as never, fromHex(mySkHex))
    const o = JSON.parse(r.content) as Record<string, unknown>
    if ((o.t === 'invite' || o.t === 'reseed') && typeof o.id === 'string' && typeof o.s === 'string' && SEED_RE.test(o.s)) {
      return {
        t: o.t,
        id: o.id,
        s: o.s,
        n: typeof o.n === 'string' ? o.n : 'Circle',
        m: o.m === 'nightout' ? 'nightout' : 'family',
      }
    }
    return null
  } catch {
    return null
  }
}
