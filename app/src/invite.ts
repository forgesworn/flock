// Flock policy adapter over Covey's canonical personal-inbox protocol.

import {
  buildDmWrap,
  buildInviteWrap as buildCoveyInviteWrap,
  buildPrivateLocationWrap,
  buildReseedWraps as buildCoveyReseedWraps,
  readDmWrap,
  readFromPersonalInbox,
  readInvite as readCoveyInvite,
  readInviteViaRef as readCoveyInviteViaRef,
  readPrivateLocationWrap,
  sendToPersonalInbox,
} from '@forgesworn/covey-kit'
import type {
  DirectMessage,
  InvitePayload as CoveyInvitePayload,
  PrivateLocationShare,
} from '@forgesworn/covey-kit'
import type { SignedEvent } from '@forgesworn/roost-kit'
import { parseMeetingShare, type MeetingShare } from '@forgesworn/flock'
import type { FlockSigner } from './signer'
import type { Mode } from './store'

/** Covey leaves the mode open; Flock deliberately supports these two modes. */
export interface InvitePayload extends Omit<CoveyInvitePayload, 'm'> {
  m: Mode
}

type ReceivedInvite = InvitePayload & { from: string }

function applyFlockMode(
  value: (CoveyInvitePayload & { from: string }) | null,
): ReceivedInvite | null {
  if (!value) return null
  return { ...value, m: value.m === 'nightout' ? 'nightout' : 'family' }
}

export function buildInviteWrap(
  signer: FlockSigner,
  recipientPk: string,
  payload: InvitePayload,
): Promise<SignedEvent> {
  return buildCoveyInviteWrap(signer, recipientPk, payload)
}

export function buildReseedWraps(
  signer: FlockSigner,
  recipientPks: string[],
  payload: InvitePayload,
): Promise<SignedEvent[]> {
  return buildCoveyReseedWraps(signer, recipientPks, payload)
}

export async function readInvite(
  signer: FlockSigner,
  wrap: { pubkey: string; content: string },
): Promise<ReceivedInvite | null> {
  return applyFlockMode(await readCoveyInvite(signer, wrap))
}

export async function readInviteViaRef(
  refSk: Uint8Array,
  wrap: { pubkey: string; content: string },
): Promise<ReceivedInvite | null> {
  return applyFlockMode(await readCoveyInviteViaRef(refSk, wrap))
}

// Meeting-point shares are Flock product data, so only their common encrypted
// personal-inbox envelope belongs to Covey.
interface MeetingExactPayload {
  t: 'mtg-loc'
  share: MeetingShare
}

export function buildMeetingExactWrap(
  signer: FlockSigner,
  recipientPk: string,
  share: MeetingShare,
): Promise<SignedEvent> {
  const payload: MeetingExactPayload = { t: 'mtg-loc', share }
  return sendToPersonalInbox(signer, recipientPk, payload)
}

export async function readMeetingExactWrap(
  signer: FlockSigner,
  wrap: { pubkey: string; content: string },
): Promise<MeetingShare | null> {
  const received = await readFromPersonalInbox(signer, wrap, (value) => {
    if (typeof value !== 'object' || value === null) return null
    const payload = value as Record<string, unknown>
    return payload.t === 'mtg-loc' ? parseMeetingShare(payload.share) : null
  })
  if (!received) return null
  const { from: _sender, ...share } = received
  return share as MeetingShare
}

export {
  buildDmWrap,
  readDmWrap,
  buildPrivateLocationWrap,
  readPrivateLocationWrap,
}
export type { DirectMessage, PrivateLocationShare }
