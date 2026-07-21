// Radar session — the app-side wire and state glue for the consented,
// time-boxed cadence lift (docs/plans/2026-07-21-radar-session-design.md).
//
// The pure consent/clock rules live in the kit (@forgesworn/flock/radarSession);
// this module owns only what the app layer must add:
//   - the WIRE SHAPE: session signals ride Covey's pair-encrypted personal
//     inbox exactly like coordination DMs, encoded as a JSON `text` payload
//     with an `rs` discriminator. Old clients drop unknown text silently —
//     which IS the ignore-only consent semantic: an unanswered ask on an old
//     phone is indistinguishable from an unseen one.
//   - the SESSION CADENCE OPTIONS the beacon publisher swaps in while a
//     session is live (5 s moving floor / 30 s stationary keepalive).
//
// Coercion invariants enforced by construction (see the design doc):
//   - there is no decline payload kind — "no" cannot exist on the wire;
//   - there is no stop REASON — a stop and an expiry read identically;
//   - session signals never enter the DM thread history — transient state
//     only, so a searched phone shows nothing;
//   - a session lifts CADENCE only. Precision stays the member's chosen
//     posture, and no-report zones cap exactly as without a session.

import {
  RADAR_SESSION,
  clampTtlSec,
  type SessionRequest,
  type RadarSession,
} from '@forgesworn/flock/radarSession'
import type { CadenceOptions } from './cadence'

/** A live session as the app tracks it (transient, never persisted). */
export interface LiveRadarSession extends RadarSession {
  /** The other member. */
  peer: string
  /** The circle whose beacons the lift applies to. */
  circleId: string
}

/** An open ask FROM a peer (transient, never persisted). */
export interface IncomingSessionAsk extends SessionRequest {
  peer: string
  circleId: string
}

// ── Wire shape ───────────────────────────────────────────────────────────────
// {"rs":1,"k":"req","id":…,"ttl":900}         ask
// {"rs":1,"k":"acc","id":…,"ttl":900,"start":…}  accept (start = acceptor clock)
// {"rs":1,"k":"stop","id":…}                  courtesy stop (absence must work)

export type SessionSignal =
  | { kind: 'req'; requestId: string; ttlSec: number }
  | { kind: 'acc'; requestId: string; ttlSec: number; startAtSec: number }
  | { kind: 'stop'; sessionId: string }

export function encodeSessionText(sig: SessionSignal): string {
  switch (sig.kind) {
    case 'req': return JSON.stringify({ rs: 1, k: 'req', id: sig.requestId, ttl: sig.ttlSec })
    case 'acc': return JSON.stringify({ rs: 1, k: 'acc', id: sig.requestId, ttl: sig.ttlSec, start: sig.startAtSec })
    case 'stop': return JSON.stringify({ rs: 1, k: 'stop', id: sig.sessionId })
  }
}

/** Parse a DM `text` as a session signal, or null (any other DM — including
 *  every existing coordination label — falls through to the normal path).
 *  Hostile input never throws; TTLs are clamped at every read. */
export function decodeSessionText(text: string): SessionSignal | null {
  if (!text.startsWith('{')) return null
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return null }
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (o.rs !== 1 || typeof o.id !== 'string' || o.id.length === 0 || o.id.length > 64) return null
  switch (o.k) {
    case 'req':
      return { kind: 'req', requestId: o.id, ttlSec: clampTtlSec(Number(o.ttl)) }
    case 'acc': {
      const start = Number(o.start)
      if (!Number.isFinite(start) || start <= 0) return null
      return { kind: 'acc', requestId: o.id, ttlSec: clampTtlSec(Number(o.ttl)), startAtSec: start }
    }
    case 'stop':
      return { kind: 'stop', sessionId: o.id }
    default:
      return null
  }
}

// ── Cadence lift ─────────────────────────────────────────────────────────────

/** The cadence the beacon publisher applies while a session is live for this
 *  circle — the whole of a session's power. Null = no live session = the
 *  normal 45 s/300 s gate. Jitter is the CALLER's job (same hygiene as the
 *  base cadence). */
export function sessionCadenceOptions(
  sessions: ReadonlyMap<string, LiveRadarSession>,
  circleId: string,
  nowSec: number,
): CadenceOptions | null {
  for (const s of sessions.values()) {
    if (s.circleId !== circleId) continue
    if (nowSec <= s.startAtSec + Math.min(s.ttlSec, RADAR_SESSION.maxTtlSec) + RADAR_SESSION.clockSkewSec) {
      return {
        minIntervalSeconds: RADAR_SESSION.cadenceMovingSec,
        heartbeatSeconds: RADAR_SESSION.cadenceStationarySec,
      }
    }
  }
  return null
}

/** The latest end (unix sec) across live sessions for a circle, for the native
 *  publisher mirror — 0 when none. The native side applies the session floors
 *  strictly while `now < untilSec`, so an expiry ends the lift even if the
 *  WebView never wakes to say so. */
export function sessionUntilSec(
  sessions: ReadonlyMap<string, LiveRadarSession>,
  circleId: string,
): number {
  let until = 0
  for (const s of sessions.values()) {
    if (s.circleId !== circleId) continue
    until = Math.max(until, s.startAtSec + Math.min(s.ttlSec, RADAR_SESSION.maxTtlSec))
  }
  return until
}

/** A fresh, unguessable request id (16 hex chars). */
export function newSessionRequestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('')
}
