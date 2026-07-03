// Automatic seed rotation for ongoing circles.
//
// On the wire a circle is only a pseudonymous mailbox: gift wraps (throwaway
// authors, blurred timestamps, opaque ciphertext) addressed to the inbox
// derived from the circle seed (see PRIVACY.md). Night-out circles expire, so
// their mailbox dies with them — but an ongoing family circle would otherwise
// keep ONE mailbox for years, a stable target for long-horizon traffic
// clustering by a hostile relay or network observer. Rotating the seed monthly
// bounds that horizon. Reseeds travel to each member's PERSONAL inbox, which
// never rotates, so a member who was offline through a rotation still catches
// up — provided a live (non-expired) reseed wrap is waiting; `refreshDue`
// exists precisely to keep one there.
//
// Coordination without coordination: every member evaluates the same pure
// rule against the same synced facts. The lexicographically first member owns
// the rotation when it falls due; each later member's window opens a day
// further out, so a dormant delegate never blocks rotation and simultaneous
// attempts stay unlikely. A lost race costs one redundant rotation — the last
// reseed to arrive wins everywhere, exactly like two manual resets today.

/** Rotate an ongoing circle's seed this long after it was last set. */
export const ROTATION_PERIOD_SEC = 30 * 86_400

/** Each successive member's fallback window opens this much later. */
export const ROTATION_STAGGER_SEC = 86_400

/** Re-wrap the current seed for offline members this often (must stay well
 *  inside the 16-day NIP-40 wrap expiry — see giftwrap.ts WRAP_EXPIRY_SECONDS). */
export const ROTATION_REFRESH_SEC = 7 * 86_400

export interface RotationCircle {
  /** When the current seed was adopted (unix sec). Unset = unknown age: never rotate. */
  reseededAt?: number
  /** Transient circles expire — their mailbox dies with them; never rotate. */
  expiresAt?: number
  /** Known member pubkeys (hex), including self. */
  members?: readonly string[]
}

/** This member's place in the deterministic delegate order (0 = first).
 *  A member missing from its own roster copy sorts last — it may rotate
 *  eventually, but never ahead of anyone with a complete view. */
function rank(members: readonly string[] | undefined, me: string): number {
  const sorted = [...(members ?? [])].sort()
  const i = sorted.indexOf(me)
  return i === -1 ? sorted.length : i
}

/** Should THIS member rotate this circle's seed now? */
export function rotationDue(c: RotationCircle, me: string, now: number): boolean {
  if (c.expiresAt || !c.reseededAt) return false
  return now >= c.reseededAt + ROTATION_PERIOD_SEC + rank(c.members, me) * ROTATION_STAGGER_SEC
}

/**
 * Should THIS member re-wrap the current seed for offline members now?
 *
 * Reseed wraps expire (NIP-40, 16 days), so without a refresh a member offline
 * for longer than that across a rotation would silently fall out of the circle
 * — the one real hazard of rotating automatically. A weekly re-wrap by the
 * first-ranked member keeps a fresh copy waiting on every personal inbox.
 * Receivers treat a same-seed reseed as a no-op, so duplicates are harmless.
 */
export function refreshDue(c: RotationCircle, me: string, lastRefresh: number | undefined, now: number): boolean {
  if (c.expiresAt || !c.reseededAt) return false
  if (rank(c.members, me) !== 0) return false
  const last = Math.max(lastRefresh ?? 0, c.reseededAt)
  return now >= last + ROTATION_REFRESH_SEC
}
