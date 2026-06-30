// Local state: identity, circle, persistence. localStorage is fine for an MVP
// demo but is NOT secure key storage — flagged in the UI and DESIGN.

import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'

export type Mode = 'family' | 'nightout'
export interface Identity { skHex: string; pk: string }
export interface Circle { id: string; seedHex: string; name: string; mode: Mode }
export interface Persisted { identity: Identity | null; circle: Circle | null; relayUrl: string }

const KEY = 'flock:v1'
const DEFAULT_RELAY = 'wss://relay.damus.io'

const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
export const fromHex = (h: string): Uint8Array =>
  Uint8Array.from(h.match(/.{1,2}/g) ?? [], (x) => parseInt(x, 16))
const randHex = (n: number): string => toHex(crypto.getRandomValues(new Uint8Array(n)))

export function load(): Persisted {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return { identity: null, circle: null, relayUrl: DEFAULT_RELAY, ...JSON.parse(raw) }
  } catch { /* ignore corrupt state */ }
  return { identity: null, circle: null, relayUrl: DEFAULT_RELAY }
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

export function createCircle(name: string, mode: Mode): Circle {
  return { id: randHex(8), seedHex: randHex(32), name: name.trim() || 'My circle', mode }
}

const b64encode = (s: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(s)))
const b64decode = (s: string): string => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)))

export function encodeInvite(c: Circle): string {
  return b64encode(JSON.stringify({ v: 1, id: c.id, s: c.seedHex, n: c.name, m: c.mode }))
}

export function decodeInvite(code: string): Circle {
  const o = JSON.parse(b64decode(code.trim()))
  if (o.v !== 1 || typeof o.s !== 'string' || o.s.length !== 64 || typeof o.id !== 'string') {
    throw new Error('That invite code is not valid.')
  }
  return { id: o.id, seedHex: o.s, name: o.n || 'Circle', mode: o.m === 'nightout' ? 'nightout' : 'family' }
}
