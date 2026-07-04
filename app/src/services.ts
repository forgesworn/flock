// Transport + sensors: Nostr relay publish/subscribe and foreground geolocation.

import { SimplePool } from 'nostr-tools/pool'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import type { FlockSigner, EventTemplate } from './signer'

export type { EventTemplate }
export interface Fix { lat: number; lon: number; accuracy: number; at: number }

let pool: SimplePool | null = null
function getPool(): SimplePool {
  // enableReconnect: without it a single socket close (doze, network handover,
  // relay restart) permanently kills every open subscription — publishes recover
  // on the next ensureRelay, but nothing INCOMING ever arrives again until the
  // app is fully restarted. With it, nostr-tools re-fires open subs on reconnect
  // (with a since-catch-up so missed events replay). enablePing detects the
  // half-dead socket a suspended radio leaves behind, which never fires onclose.
  pool ??= new SimplePool({ enableReconnect: true, enablePing: true })
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

/** Publish a code-addressed "spoken invite" signed by a THROWAWAY key: the event
 *  is found by its `t` tag, its author is irrelevant, and a fresh key each time
 *  leaks no link back to the inviter. Private (no-log) relays only — the caller
 *  passes them. Content is already encrypted to the code-derived key. */
export async function publishWordInvite(
  relays: readonly string[],
  template: { kind: number; created_at: number; content: string; tags: string[][] },
) {
  const signed = finalizeEvent(template, generateSecretKey())
  await fanOut(relays, signed)
  return signed
}

/** One-shot fetch of a parked spoken invite by its tag. Resolves the NEWEST match,
 *  or null if none arrives before the deadline. Resolves early on EOSE once a match
 *  is in hand, but waits the full timeout for slow relays if nothing has arrived. */
export function fetchWordInvite(
  relays: readonly string[],
  kind: number,
  tag: string,
  timeoutMs = 6000,
): Promise<{ content: string; created_at: number } | null> {
  return new Promise((resolve) => {
    let best: { content: string; created_at: number } | null = null
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      try { sub.close() } catch { /* already closed */ }
      clearTimeout(timer)
      resolve(best)
    }
    const timer = setTimeout(done, timeoutMs)
    const sub = getPool().subscribeMany([...relays], { kinds: [kind], '#t': [tag] }, {
      onevent: (e: { content: string; created_at: number }) => {
        if (!best || e.created_at > best.created_at) best = { content: e.content, created_at: e.created_at }
      },
      oneose: () => { if (best) done() },
    })
  })
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

const toFix = (pos: GeolocationPosition): Fix => ({
  lat: pos.coords.latitude,
  lon: pos.coords.longitude,
  accuracy: pos.coords.accuracy,
  at: Math.floor(pos.timestamp / 1000),
})

/** Why a location request failed — drives actionable guidance, not a raw toast.
 *  'denied' is the one that needs the user's hands (a settings change); the
 *  others are transient and the watch keeps trying. */
export type GeoErrorKind = 'denied' | 'unavailable' | 'timeout' | 'unsupported'

function geoErrorKind(err: GeolocationPositionError): GeoErrorKind {
  return err.code === 1 ? 'denied' : err.code === 2 ? 'unavailable' : 'timeout'
}

/**
 * Watch foreground location. Returns a stop fn.
 *
 * `highAccuracy` picks the hardware tier: `true` (GPS) for family breach detection
 * and full disclosures, `false` (network/cell — far less battery, and coarser by
 * construction) for a night-out coarse share, where ±hundreds of metres is ample.
 * A low-power fix reports a larger `accuracy`, which the breach logic reads to stay
 * fail-safe. (Minimal-footprint north star — Phase H.)
 */
export function watchLocation(
  onFix: (f: Fix) => void,
  onError: (message: string, kind: GeoErrorKind) => void,
  opts: { highAccuracy?: boolean } = {},
): () => void {
  if (!('geolocation' in navigator)) {
    onError('Location is not available on this device.', 'unsupported')
    return () => { /* noop */ }
  }
  const highAccuracy = opts.highAccuracy ?? true
  const id = navigator.geolocation.watchPosition(
    (pos) => onFix(toFix(pos)),
    (err) => onError(err.message || 'Could not get your location.', geoErrorKind(err)),
    // A low-power watch may also lean on slightly staler cached fixes.
    { enableHighAccuracy: highAccuracy, maximumAge: highAccuracy ? 5000 : 15_000, timeout: 20_000 },
  )
  return () => navigator.geolocation.clearWatch(id)
}

/**
 * Self-scheduled location poll (an alternative to the continuous watch) whose
 * interval the caller sets per fix via `nextDelayMs` — so a stationary night-out
 * share can back off and let the radio sleep between samples, tightening again the
 * moment it moves. One-shot GPS calls power down between polls, unlike a watch.
 * Returns a stop fn. (Family breach stays on the continuous `watchLocation`.)
 */
export function pollLocation(
  onFix: (f: Fix) => void,
  onError: (message: string, kind: GeoErrorKind) => void,
  opts: { highAccuracy?: boolean; nextDelayMs: (f: Fix) => number },
): () => void {
  if (!('geolocation' in navigator)) {
    onError('Location is not available on this device.', 'unsupported')
    return () => { /* noop */ }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const schedule = (ms: number): void => { if (!stopped) timer = setTimeout(tick, ms) }
  function tick(): void {
    navigator.geolocation.getCurrentPosition(
      (pos) => { if (stopped) return; const f = toFix(pos); onFix(f); schedule(opts.nextDelayMs(f)) },
      (err) => { if (stopped) return; onError(err.message || 'Could not get your location.', geoErrorKind(err)) },
      { enableHighAccuracy: opts.highAccuracy ?? false, maximumAge: 10_000, timeout: 20_000 },
    )
  }
  tick() // sample immediately, then self-schedule
  return () => { stopped = true; if (timer !== undefined) clearTimeout(timer) }
}

/**
 * One-shot foreground location — resolves to a Fix, or `null` if geolocation is
 * unavailable, denied, or times out. Never rejects, so callers can simply skip on
 * a null. Used for three things: centring the map (default, lenient), a **fresh fix
 * on an explicit SOS/pick-up** (short `timeoutMs`, so an alert is never delayed more
 * than a beat but carries the freshest location possible), and **escalating an
 * uncertain family fix** to a sharper GPS one (`maximumAge: 0`). Purely local —
 * nothing is broadcast.
 */
export function currentPosition(
  opts: { enableHighAccuracy?: boolean; maximumAge?: number; timeoutMs?: number } = {},
): Promise<Fix | null> {
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return Promise.resolve(null)
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(toFix(pos)),
      () => resolve(null),
      {
        enableHighAccuracy: opts.enableHighAccuracy ?? true,
        maximumAge: opts.maximumAge ?? 30_000,
        timeout: opts.timeoutMs ?? 20_000,
      },
    )
  })
}
