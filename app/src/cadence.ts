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

// ── Adaptive sampling cadence ────────────────────────────────────────────────
// The sampling twin of the emission gate above: when a night-out share is
// stationary, don't keep waking the GPS at full rate — back off the *poll*
// interval, tightening again the moment the device moves. (Family breach stays on
// a continuous watch: a breach must be caught fast even for a fast exit, so family
// sampling must NOT back off — that's a safety line, not a battery one.)

/** Bounds for {@link nextPollDelaySeconds} (seconds). */
export interface PollBounds {
  /** Sample at least this often — the rate while moving. */
  minSeconds: number
  /** Never wait longer than this — keep it under the presence "stale" window so a
   *  still member never wrongly drops to "gone home". */
  maxSeconds: number
}

/**
 * Whether two consecutive fixes represent real movement rather than jitter. The
 * threshold is the coarser of the two accuracies (a low-power network fix can
 * wander tens–hundreds of metres while dead still) or a floor, whichever is larger.
 */
export function hasMoved(distanceMetres: number, accuracyA: number, accuracyB: number, floorMetres: number): boolean {
  return distanceMetres > Math.max(floorMetres, accuracyA, accuracyB)
}

/**
 * How long to wait before the next location poll, given how many consecutive
 * samples have been stationary. Exponential back-off from `minSeconds` (just
 * moved) toward `maxSeconds` (long settled), so battery use tapers while a moving
 * device is still tracked closely. Pure and deterministic.
 *
 * `conserve` (battery low and discharging, no active alert) doubles every delay —
 * the ceiling still holds, so a still member never ages past the presence stale
 * window into a false "gone home". The cap is a safety line; conserve is not.
 */
export function nextPollDelaySeconds(stationaryStreak: number, bounds: PollBounds, opts?: { conserve?: boolean }): number {
  const streak = Math.max(0, Math.floor(stationaryStreak)) + (opts?.conserve ? 1 : 0)
  return Math.min(bounds.minSeconds * 2 ** streak, bounds.maxSeconds)
}
