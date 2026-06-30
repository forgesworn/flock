// Local state: identity, circle, persistence. localStorage is fine for an MVP
// demo but is NOT secure key storage — flagged in the UI and DESIGN.

import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { decode as nip19decode } from 'nostr-tools/nip19'
import type { Geofence } from '@forgesworn/flock'
import { PRIVATE_RELAYS } from './relays'
import { deriveCircleSeed } from './keys'

export type Mode = 'family' | 'nightout'
/** A local identity has `skHex`; a Signet identity is `pk`-only (key in the signer). */
export interface Identity { skHex?: string; pk: string }
export type AuthMethod = 'local' | 'signet'
export interface Circle {
  id: string
  seedHex: string
  name: string
  mode: Mode
  /** Known member pubkeys (hex), including self. */
  members?: string[]
  /** Dead-man's-switch cadence in seconds; 0/undefined = disarmed. */
  checkinInterval?: number
  /** nsec-tree derivation epoch; reseed = epoch + 1 (creator-side). */
  epoch?: number
  /** Transient lifetime (unix sec, NIP-40 style). Undefined = long-lived (e.g. family). */
  expiresAt?: number
}
export interface Persisted {
  identity: Identity | null
  /** All circles this person belongs to (family, a trip, a night out…) — many at once. */
  circles: Circle[]
  /** Which circle is in focus. */
  activeCircleId: string | null
  relayUrl: string
  geofences: Geofence[]
  /** How the identity authenticates: a local key, or a Signet/bunker signer. */
  authMethod?: AuthMethod
  /** Local secret from which circle seeds are deterministically derived (nsec-tree). */
  circleRootHex?: string
}

const KEY = 'flock:v1'
// Sensitive traffic defaults to our own no-log relay (see relays.ts / docs/PRIVACY.md).
const DEFAULT_RELAY = PRIVATE_RELAYS[0]

const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
export const fromHex = (h: string): Uint8Array =>
  Uint8Array.from(h.match(/.{1,2}/g) ?? [], (x) => parseInt(x, 16))
const randHex = (n: number): string => toHex(crypto.getRandomValues(new Uint8Array(n)))

export function load(): Persisted {
  const fresh: Persisted = { identity: null, circles: [], activeCircleId: null, relayUrl: DEFAULT_RELAY, geofences: [] }
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return fresh
    const o = JSON.parse(raw) as Partial<Persisted> & { circle?: Circle | null }
    const state: Persisted = { ...fresh, ...o, circles: o.circles ?? [] }
    // Migrate the legacy single-circle shape.
    if (o.circle && !state.circles.length) {
      state.circles = [o.circle]
      state.activeCircleId = o.circle.id
    }
    delete (state as unknown as Record<string, unknown>).circle
    // Drop expired transient circles, then keep the active id valid.
    const now = Math.floor(Date.now() / 1000)
    state.circles = state.circles.filter((c) => !c.expiresAt || c.expiresAt > now)
    if (!state.circles.some((c) => c.id === state.activeCircleId)) {
      state.activeCircleId = state.circles[0]?.id ?? null
    }
    return state
  } catch { /* ignore corrupt state */ }
  return fresh
}

export function save(state: Persisted): void {
  localStorage.setItem(KEY, JSON.stringify(state))
}

export function reset(): void {
  localStorage.removeItem(KEY)
}

export function createIdentity(): Identity {
  const sk = generateSecretKey()
  return { skHex: toHex(sk), pk: getPublicKey(sk) }
}

export function createCircle(name: string, mode: Mode, ownerPk: string, circleRootHex: string, expiresAt?: number): Circle {
  const id = randHex(8)
  return {
    id,
    seedHex: deriveCircleSeed(circleRootHex, id, 0),
    name: name.trim() || 'My circle',
    mode,
    members: [ownerPk],
    checkinInterval: 0,
    epoch: 0,
    ...(expiresAt ? { expiresAt } : {}),
  }
}

/** A fresh 32-byte group seed (hex) — used when reseeding. */
export function newSeed(): string {
  return randHex(32)
}

/** Decode an npub to a 64-char hex pubkey. Throws if not a valid npub. */
export function npubToHex(npub: string): string {
  const d = nip19decode(npub.trim())
  if (d.type !== 'npub' || typeof d.data !== 'string') throw new Error('That is not a valid npub')
  return d.data
}

const b64encode = (s: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(s)))
const b64decode = (s: string): string => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)))

export function encodeInvite(c: Circle): string {
  return b64encode(JSON.stringify({ v: 1, id: c.id, s: c.seedHex, n: c.name, m: c.mode, ...(c.expiresAt ? { x: c.expiresAt } : {}) }))
}

export function decodeInvite(code: string): Circle {
  const o = JSON.parse(b64decode(code.trim()))
  if (o.v !== 1 || typeof o.s !== 'string' || o.s.length !== 64 || typeof o.id !== 'string') {
    throw new Error('That invite code is not valid.')
  }
  return {
    id: o.id,
    seedHex: o.s,
    name: o.n || 'Circle',
    mode: o.m === 'nightout' ? 'nightout' : 'family',
    ...(typeof o.x === 'number' ? { expiresAt: o.x } : {}),
  }
}
