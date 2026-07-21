// Dropped pins — a member marks a spot for the circle: their car, a picnic
// spot, a meeting point. A pin is a fixed, provider-defined KIND plus a location
// (geohash at a chosen precision) — never free text, so it keeps flock's
// no-free-form-content property (see coordination actions): the label is
// rendered locally from the kind, the wire carries only the enum.
//
// Same envelope + transport as a buzz: JSON payload sealed with the group
// envelope key, carried as a kind-20078 signal (t=pin), then gift-wrapped to
// the circle inbox by publishSignal — so the relay never sees the kind, the
// location or the sender.

import { buildSignalEvent, type UnsignedEvent } from 'canary-kit/nostr'
import { deriveGroupKey, encryptEnvelope, decryptEnvelope } from 'canary-kit/sync'

/** The `t`-tag value for pin signals. */
export const PIN_SIGNAL_TYPE = 'pin'

/** The complete, fixed pin vocabulary. Labels + glyphs are rendered locally; the
 *  wire carries only the key — so the relay never learns which icon (let alone what
 *  it means) was dropped, and there is no free-form text to leak. Add a kind here
 *  (never free text). Key order is the picker order, most-reached first. */
export const PIN_KINDS = {
  meet: { label: 'Meet here', glyph: '📍' },
  car: { label: 'Car', glyph: '🚗' },
  parking: { label: 'Parking', glyph: '🅿️' },
  home: { label: 'Home', glyph: '🏠' },
  food: { label: 'Food', glyph: '🍽️' },
  drink: { label: 'Drinks', glyph: '🍺' },
  coffee: { label: 'Coffee', glyph: '☕' },
  water: { label: 'Water', glyph: '🚰' },
  toilet: { label: 'Toilets', glyph: '🚻' },
  picnic: { label: 'Picnic', glyph: '🧺' },
  tent: { label: 'Camp', glyph: '⛺' },
  view: { label: 'Photo spot', glyph: '📸' },
  shop: { label: 'Shop', glyph: '🛍️' },
  atm: { label: 'Cash', glyph: '🏧' },
  firstaid: { label: 'First aid', glyph: '⛑️' },
  kids: { label: 'Kids', glyph: '🧒' },
  pet: { label: 'Pet', glyph: '🐾' },
  avoid: { label: 'Avoid', glyph: '⚠️' },
} as const

export type PinKind = keyof typeof PIN_KINDS
export const PIN_KIND_LIST = Object.keys(PIN_KINDS) as PinKind[]

export function isPinKind(v: unknown): v is PinKind {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(PIN_KINDS, v)
}

/** Local label for a pin — glyph + provider-defined name, never caller prose. */
export function pinLabel(kind: PinKind): string {
  return `${PIN_KINDS[kind].glyph} ${PIN_KINDS[kind].label}`
}

/** A decrypted dropped pin. `removed` is a tombstone — the same id re-sent with
 *  removed:true retracts it (latest-timestamp-wins on the receiver). */
export interface Pin {
  /** Stable id (the dropper mints it) so an edit / removal targets the same pin. */
  id: string
  /** Dropper pubkey (64-char hex). */
  from: string
  /** Fixed protocol kind. */
  kind: PinKind
  /** Geohash of the spot. */
  geohash: string
  /** Geohash precision the spot was placed at. */
  precision: number
  /** Unix seconds. */
  timestamp: number
  /** Tombstone: this drop retracts the pin with this id. */
  removed?: boolean
}

const HEX_64_RE = /^[0-9a-f]{64}$/
const ID_RE = /^[0-9a-f]{8,32}$/
const GEOHASH_RE = /^[0-9a-z]{1,12}$/

/** Build an encrypted, unsigned kind-20078 pin signal (drop or removal). */
export async function buildPinSignal(params: {
  groupId: string
  seedHex: string
  id: string
  from: string
  kind: PinKind
  geohash: string
  precision: number
  timestamp?: number
  removed?: boolean
}): Promise<UnsignedEvent> {
  if (!HEX_64_RE.test(params.from)) throw new Error('from must be a 64-character lowercase hex pubkey')
  if (!ID_RE.test(params.id)) throw new Error('pin id must be 8–32 lowercase hex chars')
  if (!isPinKind(params.kind)) throw new Error('unknown pin kind')
  if (!GEOHASH_RE.test(params.geohash)) throw new Error('invalid geohash')
  if (!Number.isInteger(params.precision) || params.precision < 1 || params.precision > 12) {
    throw new Error('precision must be an integer 1–12')
  }
  const payload: Pin = {
    id: params.id,
    from: params.from,
    kind: params.kind,
    geohash: params.geohash,
    precision: params.precision,
    timestamp: params.timestamp ?? Math.floor(Date.now() / 1000),
    ...(params.removed ? { removed: true } : {}),
  }
  const encryptedContent = await encryptEnvelope(deriveGroupKey(params.seedHex), JSON.stringify(payload))
  return buildSignalEvent({ groupId: params.groupId, signalType: PIN_SIGNAL_TYPE, encryptedContent })
}

/** Decrypt and validate a pin signal. Rejects anything that isn't a well-formed
 *  provider-defined pin (unknown kind, bad geohash, missing fields). */
export async function decryptPin(seedHex: string, content: string): Promise<Pin> {
  const plaintext = await decryptEnvelope(deriveGroupKey(seedHex), content)
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    throw new Error('Invalid pin payload: not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid pin payload')
  const o = parsed as Record<string, unknown>
  if (typeof o.id !== 'string' || !ID_RE.test(o.id)) throw new Error('Invalid pin: id')
  if (typeof o.from !== 'string' || !HEX_64_RE.test(o.from)) throw new Error('Invalid pin: from')
  if (!isPinKind(o.kind)) throw new Error('Invalid pin: unknown kind')
  if (typeof o.geohash !== 'string' || !GEOHASH_RE.test(o.geohash)) throw new Error('Invalid pin: geohash')
  if (typeof o.precision !== 'number' || !Number.isInteger(o.precision)) throw new Error('Invalid pin: precision')
  if (typeof o.timestamp !== 'number' || !Number.isFinite(o.timestamp)) throw new Error('Invalid pin: timestamp')
  return {
    id: o.id,
    from: o.from,
    kind: o.kind,
    geohash: o.geohash,
    precision: o.precision,
    timestamp: o.timestamp,
    ...(o.removed === true ? { removed: true } : {}),
  }
}

/** The pins in a list whose LATEST held state a given member authored — used to
 *  re-broadcast for anti-entropy when a newcomer (or a member back from offline)
 *  announces. `from` is bound to the seal signer on receipt, so a member can only
 *  legitimately re-send what they authored; that partitions the live set across
 *  members with NO duplication (each id's newest state has exactly one author).
 *  Tombstones ARE included — the remover re-sends them so a deletion propagates and
 *  a stale drop can't resurrect on the newcomer. Pure. */
export function authoredPins(list: readonly Pin[] | undefined, pk: string): Pin[] {
  return (list ?? []).filter((p) => p.from === pk)
}

/** Merge an incoming pin into a list — latest-timestamp-wins per id. Tombstones
 *  are RETAINED as entries, not dropped: relays replay historical wraps in
 *  arbitrary order (gift-wrap timestamps are deliberately smeared), so a removal
 *  must keep outranking the original drop on every future replay. Discarding the
 *  entry — as this once did — let a replayed drop resurrect a deleted pin, and a
 *  tombstone that arrived before its drop was forgotten entirely. Display layers
 *  filter `removed`. Pure; returns the same ref when nothing changed. */
export function withPin(list: readonly Pin[] | undefined, incoming: Pin): Pin[] {
  const cur = list ?? []
  const existing = cur.find((p) => p.id === incoming.id)
  if (existing && existing.timestamp >= incoming.timestamp) return cur as Pin[]
  return [...cur.filter((p) => p.id !== incoming.id), incoming]
}
