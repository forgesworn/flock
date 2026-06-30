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

/** Sign an unsigned flock builder event via the signer and publish it to the relay. */
export async function publishEvent(relayUrl: string, template: EventTemplate, signer: FlockSigner) {
  const signed = await signer.signEvent(template)
  await Promise.any(getPool().publish([relayUrl], signed as never))
  return signed
}

/** Publish an already-signed event (e.g. a NIP-59 gift wrap). */
export async function publishSigned(relayUrl: string, signed: { id: string; sig: string; [k: string]: unknown }) {
  await Promise.any(getPool().publish([relayUrl], signed as never))
  return signed
}

/** Subscribe to NIP-59 gift wraps (kind 1059) addressed to me. Returns an unsubscribe fn. */
export function subscribeGiftWraps(
  relayUrl: string,
  myPubkey: string,
  onEvent: (e: { id: string; pubkey: string; content: string; tags: string[][]; created_at: number }) => void,
): () => void {
  const sub = getPool().subscribeMany(
    [relayUrl],
    { kinds: [1059], '#p': [myPubkey] },
    { onevent: onEvent },
  )
  return () => sub.close()
}

/** Subscribe to a circle's kind-20078 signals by hashed d-tag. Returns an unsubscribe fn. */
export function subscribeSignals(
  relayUrl: string,
  dTag: string,
  onEvent: (e: { pubkey: string; content: string; tags: string[][]; created_at: number }) => void,
): () => void {
  const sub = getPool().subscribeMany(
    [relayUrl],
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
