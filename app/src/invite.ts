// Secure invites & reseed via NIP-59 gift wrap — routed through the FlockSigner.
//
// The seal (kind 13) is NIP-44-encrypted and signed by the member's signer
// (LocalSigner today, SignetSigner next — so a key in a bunker works too). Only
// the throwaway outer-wrap key (kind 1059) is generated locally. This is what
// lets the circle seed be gift-wrapped to a recipient without flock ever holding
// the sender's secret key.

import { finalizeEvent, generateSecretKey, getEventHash } from 'nostr-tools/pure'
import { getConversationKey, encrypt as nip44encrypt } from 'nostr-tools/nip44'
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
const SEAL_KIND = 13
const WRAP_KIND = 1059
const SEED_RE = /^[0-9a-f]{64}$/

const nowSec = (): number => Math.floor(Date.now() / 1000)
// NIP-59: randomise created_at up to 2 days in the past to blur timing.
const wrapTime = (): number => nowSec() - Math.floor(Math.random() * 172_800)

/** Gift-wrap an invite/reseed payload to a single recipient pubkey via the signer. */
export async function buildInviteWrap(
  signer: FlockSigner,
  recipientPk: string,
  payload: InvitePayload,
): Promise<SignedEvent> {
  const rumor = {
    pubkey: signer.pubkey,
    created_at: nowSec(),
    kind: RUMOR_KIND,
    tags: [] as string[][],
    content: JSON.stringify(payload),
  }
  const rumorWithId = { ...rumor, id: getEventHash(rumor) }

  // seal: encrypted to recipient with the sender's key, signed by the sender's signer.
  const sealContent = await signer.nip44Encrypt(recipientPk, JSON.stringify(rumorWithId))
  const seal = await signer.signEvent({ kind: SEAL_KIND, content: sealContent, tags: [], created_at: wrapTime() })

  // wrap: encrypted to recipient with a throwaway key, signed by that key.
  const ephSk = generateSecretKey()
  const wrapContent = nip44encrypt(JSON.stringify(seal), getConversationKey(ephSk, recipientPk))
  return finalizeEvent(
    { kind: WRAP_KIND, content: wrapContent, tags: [['p', recipientPk]], created_at: wrapTime() },
    ephSk,
  ) as unknown as SignedEvent
}

/** Gift-wrap a reseed payload to many recipients. */
export function buildReseedWraps(
  signer: FlockSigner,
  recipientPks: string[],
  payload: InvitePayload,
): Promise<SignedEvent[]> {
  return Promise.all(recipientPks.map((pk) => buildInviteWrap(signer, pk, payload)))
}

/** Unwrap a gift wrap addressed to us (via the signer); returns the invite payload or null. */
export async function readInvite(
  signer: FlockSigner,
  wrap: { pubkey: string; content: string },
): Promise<InvitePayload | null> {
  try {
    const seal = JSON.parse(await signer.nip44Decrypt(wrap.pubkey, wrap.content)) as { pubkey: string; content: string }
    const rumor = JSON.parse(await signer.nip44Decrypt(seal.pubkey, seal.content)) as { content: string }
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
    return null
  } catch {
    return null
  }
}
