/**
 * Alert/signal builders for flock — the bridge from a policy decision to a
 * publishable Nostr event.
 *
 * Three alert types ride on `canary-kit`'s ephemeral kind-20078 signal event,
 * distinguished by the `t` tag:
 *   - `beacon` — a coarse/normal location beacon (night-out sharing)
 *   - `breach` — a geofence-breach disclosure (full precision)
 *   - `pickup` — a "pick me up" request (full precision)
 *   - `help`   — SOS / duress, carried as a `canary-kit` DuressAlert
 *
 * `beacon`/`breach`/`pickup` reuse `encryptBeacon` (beacon key); `help` reuses
 * `buildDuressAlert` + `encryptDuressAlert` (distinct duress key, for domain
 * separation). Builders return **unsigned** events — the caller signs (NIP-01),
 * and may additionally NIP-59 gift-wrap, before publishing.
 *
 * Geohash encoding stays the caller's responsibility (per `canary-kit`'s beacon
 * design): pass an already-encoded `geohash` + `precision`.
 */

import {
  deriveBeaconKey,
  deriveDuressKey,
  encryptBeacon,
  buildDuressAlert,
  encryptDuressAlert,
  type DuressLocation,
} from 'canary-kit'
import { buildSignalEvent, type UnsignedEvent } from 'canary-kit/nostr'
import type { EmissionReason } from './policy.js'

/** The `t`-tag values flock uses on kind-20078 signals. */
export const SIGNAL_TYPES = {
  beacon: 'beacon',
  breach: 'breach',
  pickup: 'pickup',
  help: 'help',
  /** Cover traffic (audit F1 / PRIVACY.md timing hygiene): a decoy publish, wire-
   *  identical to a real beacon, carrying only caller-supplied filler. Receivers
   *  match no known handler for `t=cover` and silently drop it (see app.ts's
   *  `onIncoming`) — it exists purely to narrow the moving-vs-stationary cadence
   *  gap a logging relay could otherwise read off arrival timing/volume. */
  cover: 'cover',
} as const

/** Signal types whose payload is an encrypted location beacon (or, for `cover`,
 *  shaped identically but meaningless). */
export type LocationSignalType = 'beacon' | 'breach' | 'pickup' | 'cover'

/** All flock signal types. */
export type SignalType = LocationSignalType | 'help'

/** Duress propagation scope (mirrors canary-kit; re-declared as it is not on the main export). */
export type DuressScope = 'group' | 'persona' | 'master'

/**
 * Map a policy {@link EmissionReason} to the signal type to publish.
 * Returns `null` for `none` (nothing to send).
 */
export function signalTypeForReason(reason: EmissionReason): SignalType | null {
  switch (reason) {
    case 'nightout': return SIGNAL_TYPES.beacon
    case 'breach': return SIGNAL_TYPES.breach
    case 'pickup': return SIGNAL_TYPES.pickup
    case 'help': return SIGNAL_TYPES.help
    case 'none': return null
    default: {
      // Compile-time exhaustiveness guard; null at runtime for unexpected input.
      const _exhaustive: never = reason
      void _exhaustive
      return null
    }
  }
}

/** Parameters for an encrypted location-beacon signal (`beacon`/`breach`/`pickup`). */
export interface LocationSignalParams {
  groupId: string
  /** Group seed as a 64-char lowercase hex string. */
  seedHex: string
  signalType: LocationSignalType
  /** Caller-encoded geohash (e.g. via geohash-kit `encode`). */
  geohash: string
  /** Geohash precision, 1–11. */
  precision: number
}

/**
 * Build an unsigned kind-20078 location-beacon signal (`beacon`/`breach`/`pickup`),
 * encrypting the location with the group's beacon key.
 */
export async function buildLocationSignal(params: LocationSignalParams): Promise<UnsignedEvent> {
  const key = deriveBeaconKey(params.seedHex)
  const encryptedContent = await encryptBeacon(key, params.geohash, params.precision)
  return buildSignalEvent({
    groupId: params.groupId,
    signalType: params.signalType,
    encryptedContent,
  })
}

/** Parameters for a help/SOS signal carried as a duress alert. */
export interface HelpSignalParams {
  groupId: string
  /** Group seed as a 64-char lowercase hex string. */
  seedHex: string
  /** 64-char lowercase hex pubkey of the member under duress. */
  member: string
  /** Location to disclose, or null when none is available (sends a location-less alert). */
  location: DuressLocation | null
  /** Propagation scope; defaults to 'group'. */
  scope?: DuressScope
  /** Originating group id, when propagating beyond the triggering group. */
  originGroupId?: string
}

/**
 * Build an unsigned kind-20078 help/SOS signal, carried as a `canary-kit`
 * DuressAlert encrypted with the group's duress key.
 */
export async function buildHelpSignal(params: HelpSignalParams): Promise<UnsignedEvent> {
  const key = deriveDuressKey(params.seedHex)
  const alert = buildDuressAlert(params.member, params.location, {
    scope: params.scope,
    ...(params.originGroupId !== undefined && { originGroupId: params.originGroupId }),
  })
  const encryptedContent = await encryptDuressAlert(key, alert)
  return buildSignalEvent({
    groupId: params.groupId,
    signalType: SIGNAL_TYPES.help,
    encryptedContent,
  })
}
