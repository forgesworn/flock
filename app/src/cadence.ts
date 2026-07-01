// Movement-aware re-emission gate — keeps automatic beacons off the relays when
// they'd carry nothing new.
//
// A location beacon discloses a geohash *cell*, not a raw fix. So while a member
// stays inside the same cell, every re-encode yields an identical payload and
// re-broadcasting it tells the circle nothing — it's pure relay chatter. This
// gate suppresses those identical re-sends. It lets a beacon through only when:
//   1. nothing has been sent yet (get an initial fix out promptly), or
//   2. the member has moved to a *different* cell (genuinely new information), or
//   3. a slow heartbeat interval has elapsed (so a stationary member still reads
//      as "active" rather than ageing into "stale/home").
// A minimum-interval floor caps the rate even while moving, so crossing a run of
// small cells quickly can't turn into a burst.
//
// This is a transport concern (when to send an already-decided beacon), so it
// lives at the edge alongside the geohash encoding — not in the pure policy
// library, which only decides *what* to disclose.

/** The last automatic beacon we broadcast for a circle. */
export interface BeaconCadence {
  /** Geohash of the last sent beacon, or null if none has been sent. */
  lastGeohash: string | null
  /** Unix seconds of the last send, or 0 if none. */
  lastSentAt: number
}

/** Tuning for {@link shouldEmitBeacon}. */
export interface CadenceOptions {
  /** Never send faster than this, even when moving (seconds). */
  minIntervalSeconds: number
  /** Re-affirm presence at least this often while stationary (seconds). Keep it
   *  below the presence "stale" threshold so a still member never wrongly drops
   *  to "gone home". */
  heartbeatSeconds: number
}

/**
 * Decide whether to broadcast an automatic beacon now.
 *
 * Pure and deterministic — `now` is passed in. Applies to automatic emissions
 * only (night-out coarse, family breach); explicit SOS/pick-up must bypass this
 * and always send.
 */
export function shouldEmitBeacon(
  candidateGeohash: string,
  prev: BeaconCadence,
  now: number,
  opts: CadenceOptions,
): boolean {
  // Nothing sent yet — get the first beacon out without waiting on the floor.
  if (!prev.lastGeohash || !prev.lastSentAt) return true
  // Rate floor: never faster than minIntervalSeconds, even mid-move. Also guards
  // against clock skew (now < lastSentAt reads as "too soon" → suppress).
  if (now - prev.lastSentAt < opts.minIntervalSeconds) return false
  // Moved to a new cell → genuinely new information, send it.
  if (candidateGeohash !== prev.lastGeohash) return true
  // Same cell → only a periodic heartbeat, to keep presence fresh.
  return now - prev.lastSentAt >= opts.heartbeatSeconds
}
