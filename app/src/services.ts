// Transport + sensors: Nostr relay publish/subscribe and foreground geolocation.

import { SimplePool } from 'nostr-tools/pool'
import type { FlockSigner, EventTemplate } from './signer'

export type { EventTemplate }
export interface Fix { lat: number; lon: number; accuracy: number; at: number }

let pool: SimplePool | null = null
function getPool(): SimplePool {
  pool ??= new SimplePool()
  return pool
}

// Per-relay publish deadline — a safety alert must not hang on one slow or dead
// relay when another may already have accepted it.
const PUBLISH_TIMEOUT_MS = 8000
/** Sentinel a publish resolves to when it outruns PUBLISH_TIMEOUT_MS. */
export const RELAY_TIMEOUT = '__flock_relay_timeout__'
// nostr-tools' SimplePool RESOLVES a publish with a "connection failure…" string
// (rather than rejecting) when a relay is unreachable — so a naive Promise.any
// would read an all-relays-down fan-out as a success. It must be excluded explicitly.
const CONNECTION_FAILURE = 'connection failure'

/** How many of a fan-out's settled publishes genuinely reached a relay — i.e. a
 *  relay accepted the event. Excludes rejections (relay refused the event),
 *  unreachable relays (the pool's "connection failure" resolution) and timeouts. */
export function deliveredCount(results: PromiseSettledResult<unknown>[]): number {
  return results.filter((r) => {
    if (r.status !== 'fulfilled') return false
    const v = String(r.value ?? '')
    return v !== RELAY_TIMEOUT && !v.startsWith(CONNECTION_FAILURE)
  }).length
}

/** Race a publish against a resolve-only timeout so one dead relay can't stall the fan-out. */
function withTimeout(p: Promise<unknown>, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<string>((resolve) => { timer = setTimeout(() => resolve(RELAY_TIMEOUT), ms) })
  return Promise.race([Promise.resolve(p).finally(() => clearTimeout(timer)), timeout])
}

/** Fan a signed event out to every relay; succeed if ANY accepts, throw if none do
 *  — so callers surface a real "couldn't send" rather than a silent false success. */
async function fanOut(relays: readonly string[], signed: unknown): Promise<void> {
  const attempts = getPool().publish([...relays], signed as never).map((p) => withTimeout(p, PUBLISH_TIMEOUT_MS))
  const results = await Promise.allSettled(attempts)
  if (deliveredCount(results) === 0) throw new Error('No relay accepted the event')
}

/** Sign an unsigned flock builder event via the signer and fan it out to the relays. */
export async function publishEvent(relays: readonly string[], template: EventTemplate, signer: FlockSigner) {
  const signed = await signer.signEvent(template)
  await fanOut(relays, signed)
  return signed
}

/** Fan an already-signed event (e.g. a NIP-59 gift wrap) out to the relays. */
export async function publishSigned(relays: readonly string[], signed: { id: string; sig: string; [k: string]: unknown }) {
  await fanOut(relays, signed)
  return signed
}

/** Subscribe to NIP-59 gift wraps (kind 1059) filed under a `#p` tag I own, across
 *  all relays. The tag is a derived inbox (signals) or a `personalInboxTag`
 *  (invites/reseeds) — never a bare npub. One subscribeMany call → the pool dedupes
 *  the same wrap arriving from several relays (per-call known-id set). Returns an
 *  unsubscribe fn. */
export function subscribeGiftWraps(
  relays: readonly string[],
  pTag: string,
  onEvent: (e: { id: string; pubkey: string; content: string; tags: string[][]; created_at: number }) => void,
): () => void {
  const sub = getPool().subscribeMany(
    [...relays],
    { kinds: [1059], '#p': [pTag] },
    { onevent: onEvent },
  )
  return () => sub.close()
}

/** Subscribe to a circle's kind-20078 signals by hashed d-tag, across all relays. Returns an unsubscribe fn. */
export function subscribeSignals(
  relays: readonly string[],
  dTag: string,
  onEvent: (e: { pubkey: string; content: string; tags: string[][]; created_at: number }) => void,
): () => void {
  const sub = getPool().subscribeMany(
    [...relays],
    { kinds: [20_078], '#d': [dTag] },
    { onevent: onEvent },
  )
  return () => sub.close()
}

/**
 * Fetch public kind:0 profiles for a set of pubkeys from the public profile
 * relays. One-shot-ish: stays open briefly to collect replies, then the caller
 * closes it. Returns an unsubscribe fn. (Privacy: this is the ONE place flock
 * touches public relays — opt-in only; see relays.ts / store.showProfiles.)
 */
export function subscribeProfiles(
  relays: readonly string[],
  pubkeys: string[],
  onEvent: (e: { pubkey: string; content: string; created_at: number }) => void,
): () => void {
  if (!pubkeys.length) return () => { /* noop */ }
  const sub = getPool().subscribeMany(
    [...relays],
    { kinds: [0], authors: pubkeys },
    { onevent: onEvent },
  )
  return () => sub.close()
}

/** Watch foreground location. Returns a stop fn. */
export function watchLocation(
  onFix: (f: Fix) => void,
  onError: (message: string) => void,
): () => void {
  if (!('geolocation' in navigator)) {
    onError('Location is not available on this device.')
    return () => { /* noop */ }
  }
  const id = navigator.geolocation.watchPosition(
    (pos) => onFix({
      lat: pos.coords.latitude,
      lon: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
      at: Math.floor(pos.timestamp / 1000),
    }),
    (err) => onError(err.message || 'Could not get your location.'),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20_000 },
  )
  return () => navigator.geolocation.clearWatch(id)
}

/**
 * One-shot foreground location — resolves to a Fix, or `null` if geolocation is
 * unavailable, denied, or times out. Used to centre the map on the user without
 * starting a continuous share; purely local, nothing is broadcast. Never rejects,
 * so callers can simply skip centring on a null.
 */
export function currentPosition(): Promise<Fix | null> {
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return Promise.resolve(null)
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        at: Math.floor(pos.timestamp / 1000),
      }),
      () => resolve(null),
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 20_000 },
    )
  })
}
