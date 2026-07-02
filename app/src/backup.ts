// Encrypted device backup — the stopgap recovery path until shamir-words lands.
//
// `circleRootHex` is "the single thing to back up" (keys.ts), but the root alone
// cannot re-derive a JOINED circle's seed (only created ones), so the backup
// carries the circles themselves — plus the identity (so the roster still knows
// you) and the small private extras whose loss hurts (petnames, private places).
// Device-specific state (relay list, presence cache) deliberately stays out.
//
// Format: base64(JSON header) around a canary-kit AES-256-GCM envelope keyed by
// PBKDF2-SHA256 over the passphrase — no new crypto primitives (WebCrypto KDF +
// the toolkit's existing envelope). The passphrase is the only way in.

import { encryptEnvelope, decryptEnvelope } from 'canary-kit/sync'
import type { NoReportZone } from '@forgesworn/flock'
import type { Persisted, Identity, Circle, AuthMethod } from './store'

/** Everything a new device needs to become this one. Versioned for forward-compat. */
export interface BackupData {
  v: 1
  identity: Identity | null
  authMethod?: AuthMethod
  circleRootHex?: string
  circles: Circle[]
  petnames: Record<string, string>
  noReportZones: NoReportZone[]
}

const MAGIC = 'flock-backup'
const KDF_ITERATIONS = 600_000
/** Ceiling on the header's iteration count so a crafted blob can't freeze the UI. */
const MAX_ITERATIONS = 5_000_000
const HEX_64_RE = /^[0-9a-f]{64}$/

const b64encode = (s: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(s)))
const b64decode = (s: string): string => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)))
const bytesToB64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b))
const b64ToBytes = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, material, 256)
  return new Uint8Array(bits)
}

/** Select what a backup carries. Pure; excludes device-specific state. */
export function collectBackup(p: Persisted): BackupData {
  return {
    v: 1,
    identity: p.identity,
    ...(p.authMethod ? { authMethod: p.authMethod } : {}),
    ...(p.circleRootHex ? { circleRootHex: p.circleRootHex } : {}),
    circles: p.circles,
    petnames: p.petnames,
    noReportZones: p.noReportZones,
  }
}

/** Encrypt this device's state into a single copy-paste-able token. */
export async function exportBackup(p: Persisted, passphrase: string): Promise<string> {
  if (!passphrase.trim()) throw new Error('A passphrase is required')
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await deriveKey(passphrase, salt, KDF_ITERATIONS)
  const d = await encryptEnvelope(key, JSON.stringify(collectBackup(p)))
  return b64encode(JSON.stringify({ m: MAGIC, v: 1, i: KDF_ITERATIONS, s: bytesToB64(salt), d }))
}

function validate(data: unknown): BackupData {
  const o = data as BackupData
  if (typeof o !== 'object' || o === null || o.v !== 1) throw new Error('Unsupported backup version')
  if (o.identity !== null && (typeof o.identity !== 'object' || !HEX_64_RE.test(o.identity?.pk ?? ''))) {
    throw new Error('Backup is malformed (identity)')
  }
  if (!Array.isArray(o.circles) || !o.circles.every((c) => typeof c?.id === 'string' && HEX_64_RE.test(c?.seedHex ?? ''))) {
    throw new Error('Backup is malformed (circles)')
  }
  return {
    v: 1,
    identity: o.identity,
    ...(o.authMethod === 'signet' || o.authMethod === 'local' ? { authMethod: o.authMethod } : {}),
    ...(typeof o.circleRootHex === 'string' && HEX_64_RE.test(o.circleRootHex) ? { circleRootHex: o.circleRootHex } : {}),
    circles: o.circles,
    petnames: typeof o.petnames === 'object' && o.petnames !== null ? o.petnames : {},
    noReportZones: Array.isArray(o.noReportZones) ? o.noReportZones : [],
  }
}

/** Decrypt and validate a backup token. Throws on a wrong passphrase or a malformed blob. */
export async function importBackup(blob: string, passphrase: string): Promise<BackupData> {
  let header: { m?: string; v?: number; i?: number; s?: string; d?: string }
  try {
    header = JSON.parse(b64decode(blob.trim())) as typeof header
  } catch {
    throw new Error('That is not a flock backup code')
  }
  if (header.m !== MAGIC || header.v !== 1 || typeof header.s !== 'string' || typeof header.d !== 'string') {
    throw new Error('That is not a flock backup code')
  }
  const iterations = typeof header.i === 'number' && header.i >= 1 && header.i <= MAX_ITERATIONS ? header.i : KDF_ITERATIONS
  const key = await deriveKey(passphrase, b64ToBytes(header.s), iterations)
  let plaintext: string
  try {
    plaintext = await decryptEnvelope(key, header.d)
  } catch {
    throw new Error('Wrong passphrase — or the backup code is damaged')
  }
  return validate(JSON.parse(plaintext))
}

/**
 * Merge a backup into the current device state. Pure. Restoring onto a fresh
 * device adopts everything; on a device with existing state, what is already
 * here wins (identity, same-id circles, petnames) and only the missing is added
 * — a restore must never silently downgrade a live device.
 */
export function applyBackup(current: Persisted, data: BackupData): Persisted {
  const have = new Set(current.circles.map((c) => c.id))
  const circles = [...current.circles, ...data.circles.filter((c) => !have.has(c.id))]
  return {
    ...current,
    identity: current.identity ?? data.identity,
    authMethod: current.authMethod ?? data.authMethod,
    circleRootHex: current.circleRootHex ?? data.circleRootHex,
    circles,
    activeCircleId: current.activeCircleId ?? circles[0]?.id ?? null,
    petnames: { ...data.petnames, ...current.petnames },
    noReportZones: current.noReportZones.length ? current.noReportZones : data.noReportZones,
  }
}
