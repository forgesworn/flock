/**
 * Off-grid mode — deliberately going dark, without tripping alarms.
 *
 * A member announces a planned silence ("dark until T") to the circle so the
 * dead-man's-switch doesn't false-alarm while they're off the air. During
 * darkness the device emits nothing automatically (an explicit help/SOS still
 * goes out — see {@link decideEmission}). Coming back early is just a fresh
 * announcement with `until` set to now; auto-resume needs no signal at all,
 * since {@link isOffGrid} simply reads `until` against the clock.
 *
 * Carried like every other signal: gift-wrapped to the circle inbox, so the
 * relay sees only an opaque `kind:1059`.
 */

import { buildSignalEvent, type UnsignedEvent } from 'canary-kit/nostr'
import { deriveGroupKey, encryptEnvelope, decryptEnvelope } from 'canary-kit/sync'

/** The `t`-tag value for off-grid signals. */
export const OFFGRID_SIGNAL_TYPE = 'offgrid'

const HEX_64_RE = /^[0-9a-f]{64}$/
const MAX_REASON = 280

/** A decrypted off-grid announcement. */
export interface OffGrid {
  /** Member going dark (64-char hex). */
  from: string
  /** Unix seconds when darkness is planned to end. `until <= now` means "back". */
  until: number
  /** Optional human reason ("flight", "camping"). */
  reason?: string
  /** Unix seconds the announcement was made. */
  timestamp: number
}

/** True while `o`'s darkness window is still open at `nowSec`. */
export function isOffGrid(o: OffGrid, nowSec: number): boolean {
  return o.until > nowSec
}

/** Build an unsigned kind-20078 off-grid signal, encrypted with the group envelope key. */
export async function buildOffGridSignal(params: {
  groupId: string
  seedHex: string
  from: string
  until: number
  reason?: string
  timestamp?: number
}): Promise<UnsignedEvent> {
  if (!HEX_64_RE.test(params.from)) throw new Error('from must be a 64-character lowercase hex pubkey')
  if (typeof params.until !== 'number' || !Number.isFinite(params.until)) throw new Error('until must be a finite unix-seconds number')
  if (params.reason !== undefined && params.reason.length > MAX_REASON) {
    throw new Error(`reason must be at most ${MAX_REASON} characters`)
  }
  const payload: OffGrid = {
    from: params.from,
    until: params.until,
    timestamp: params.timestamp ?? Math.floor(Date.now() / 1000),
    ...(params.reason ? { reason: params.reason } : {}),
  }
  const encryptedContent = await encryptEnvelope(deriveGroupKey(params.seedHex), JSON.stringify(payload))
  return buildSignalEvent({ groupId: params.groupId, signalType: OFFGRID_SIGNAL_TYPE, encryptedContent })
}

/** Decrypt an off-grid signal's content with the group envelope key. */
export async function decryptOffGrid(seedHex: string, content: string): Promise<OffGrid> {
  const plaintext = await decryptEnvelope(deriveGroupKey(seedHex), content)
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    throw new Error('Invalid off-grid payload: not valid JSON')
  }
  const o = parsed as Record<string, unknown>
  if (typeof o.from !== 'string' || !HEX_64_RE.test(o.from)) throw new Error('Invalid off-grid: from')
  if (typeof o.until !== 'number' || !Number.isFinite(o.until)) throw new Error('Invalid off-grid: until')
  if (typeof o.timestamp !== 'number' || !Number.isFinite(o.timestamp)) throw new Error('Invalid off-grid: timestamp')
  if (o.reason !== undefined && (typeof o.reason !== 'string' || o.reason.length > MAX_REASON)) {
    throw new Error('Invalid off-grid: reason')
  }
  return {
    from: o.from,
    until: o.until,
    timestamp: o.timestamp,
    ...(typeof o.reason === 'string' ? { reason: o.reason } : {}),
  }
}
