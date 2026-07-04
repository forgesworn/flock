// Mesh v2 store-and-forward — the pure buffer/reconcile logic behind BLE
// crowd-mesh multi-hop delivery (docs/plans/2026-07-04-ble-nearby-transport.md,
// Task A of docs/plans/2026-07-04-mesh-bridge-goal.md).
//
// Problem: today a mesh frame floods only to peers CONNECTED AT THAT INSTANT
// (app.ts's onBleFrame + broadcastBle) — a phone that walks into range a
// minute later gets nothing. This module gives each device a bounded,
// self-expiring memory of recently-seen wraps so it can re-offer them to
// newly-met peers, and a compact manifest-diff so two peers exchange only
// what the other is missing (not the whole buffer) — the DarkFi tips-DAG's
// job, scaled down: a sorted id-list diff is an acceptable v2 (see the design
// doc; do not build a full DAG until sync cost demands it).
//
// Pure, framework-free, fully unit-tested. The native GATT wiring that would
// call this on an actual peer-connect event (a real bidirectional manifest
// handshake) is hardware-gated and tracked separately — see
// docs/plans/2026-07-04-ble-mesh-v2-test-plan.md. Nothing here touches a
// plugin, a socket, or the DOM; app.ts wires the retention + a best-effort
// periodic re-flood of the buffer using only the EXISTING plugin surface
// (broadcastBle), which needs no native changes.

/** One retained wrap: its id (for dedup/manifest), the opaque payload exactly
 *  as broadcast over BLE, and when THIS device first stored it. */
export interface MeshEntry {
  id: string
  /** Opaque wrap payload as broadcast over BLE (already JSON-stringified upstream). */
  data: string
  /** When this device first stored it (unix seconds). */
  storedAt: number
}

/** The buffer's state. Treat as opaque + immutable — always go through
 *  `remember`/`prune`, never mutate `order`/`byId` directly. */
export interface MeshBufferState {
  /** Insertion order oldest→newest, capped at maxEntries (ring: oldest evicted first). */
  order: string[]
  byId: Map<string, MeshEntry>
}

/** Tuning for the buffer. */
export interface MeshBufferOptions {
  /** Hard cap on retained wraps — bounds memory regardless of TTL. */
  maxEntries: number
  /** How long a wrap is retained, seconds. */
  ttlSeconds: number
}

/** 200 wraps / 15 min TTL, per the design doc — generous enough for a busy
 *  crowd's worth of traffic without unbounded growth, and matches the
 *  ballpark of a NIP-40 wrap's own short-lived relevance window. */
export const MESH_BUFFER_DEFAULTS: MeshBufferOptions = { maxEntries: 200, ttlSeconds: 15 * 60 }

/** A fresh, empty buffer. */
export function createMeshBuffer(): MeshBufferState {
  return { order: [], byId: new Map() }
}

/**
 * Store a wrap. No-op (returns the SAME state reference) if already held and
 * unexpired — a duplicate arrival must not reorder or re-date it (that would
 * let a re-flooded frame keep resetting its own TTL forever). Implicitly
 * prunes TTL-expired entries first, then evicts the oldest surplus over
 * `maxEntries` (ring buffer). Pure — returns a NEW state, mirrors the rest of
 * the app's return-new-state style (cadence.ts, geofence.ts).
 */
export function remember(
  state: MeshBufferState,
  entry: { id: string; data: string },
  now: number,
  opts: MeshBufferOptions = MESH_BUFFER_DEFAULTS,
): MeshBufferState {
  const pruned = prune(state, now, opts)
  if (pruned.byId.has(entry.id)) return pruned
  const byId = new Map(pruned.byId)
  byId.set(entry.id, { id: entry.id, data: entry.data, storedAt: now })
  const order = [...pruned.order, entry.id]
  while (order.length > opts.maxEntries) {
    const dropped = order.shift() as string
    byId.delete(dropped)
  }
  return { order, byId }
}

/** Drop TTL-expired entries. Pure; returns the SAME state reference (no churn)
 *  when nothing has actually expired. */
export function prune(state: MeshBufferState, now: number, opts: MeshBufferOptions = MESH_BUFFER_DEFAULTS): MeshBufferState {
  const order = state.order.filter((id) => {
    const e = state.byId.get(id)
    return !!e && now - e.storedAt < opts.ttlSeconds
  })
  if (order.length === state.order.length) return state
  const byId = new Map<string, MeshEntry>()
  for (const id of order) byId.set(id, state.byId.get(id) as MeshEntry)
  return { order, byId }
}

/** Every currently-live wrap, oldest first — what this device would flood to
 *  a peer with no manifest support, or the seed set for a fresh reconcile. */
export function liveEntries(state: MeshBufferState, now: number, opts: MeshBufferOptions = MESH_BUFFER_DEFAULTS): MeshEntry[] {
  return prune(state, now, opts).order.map((id) => state.byId.get(id) as MeshEntry)
}

/** The compact manifest this device advertises on peer connect: every live id,
 *  sorted — order-independent, so two manifests of the same set compare equal
 *  regardless of arrival order. The DarkFi tips-DAG's job, scaled to a v2
 *  sorted-id-list diff (see `reconcile`). */
export function manifestOf(state: MeshBufferState, now: number, opts: MeshBufferOptions = MESH_BUFFER_DEFAULTS): string[] {
  return [...prune(state, now, opts).byId.keys()].sort()
}

/** Reconcile against a peer's manifest: what I should SEND them (I have, they
 *  didn't list) and what I should ASK them for (they have, I don't). Pure set
 *  diff — the "compact id manifest exchange" the design doc calls for on peer
 *  connect. Symmetric: call it once per direction (each side computes its own
 *  toSend/toRequest from the same two manifests). */
export function reconcile(mine: readonly string[], theirs: readonly string[]): { toSend: string[]; toRequest: string[] } {
  const mineSet = new Set(mine)
  const theirSet = new Set(theirs)
  return {
    toSend: mine.filter((id) => !theirSet.has(id)),
    toRequest: theirs.filter((id) => !mineSet.has(id)),
  }
}

/** The actual wraps to hand a peer, given the ids `reconcile` said to send —
 *  in the same order as `ids`. Silently skips an id no longer held (evicted
 *  between computing the manifest and acting on it — a race, not an error). */
export function entriesFor(state: MeshBufferState, ids: readonly string[]): MeshEntry[] {
  const out: MeshEntry[] = []
  for (const id of ids) {
    const e = state.byId.get(id)
    if (e) out.push(e)
  }
  return out
}
