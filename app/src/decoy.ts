// The decoy view — "hide flock" under a compelled unlock.
//
// Hiding encrypts the ENTIRE persisted state under the owner's unlock phrase
// into one opaque blob, then removes the real state — the app reboots as a
// genuinely fresh install (the decoy is a real, working app, not a mock).
// Coming back is the existing "Restore from backup" screen: anything as the
// code, the unlock phrase as the passphrase. See
// docs/plans/2026-07-02-decoy-view.md for the decisions and honest limits.
//
// Same machinery as backup.ts (PBKDF2-SHA256 → canary-kit AES-256-GCM
// envelope, no new crypto) with one deliberate difference: NO magic string,
// no version marker — the blob must not announce what it is. The key is
// derived once at enable time and kept in state, so the hide itself is
// instant; only the unhide (typed phrase) pays the KDF.

import { encryptEnvelope, decryptEnvelope } from 'canary-kit/sync'

const KDF_ITERATIONS = 600_000

const b64encode = (s: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(s)))
const b64decode = (s: string): string => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)))
const bytesToB64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b))
const b64ToBytes = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const keyToB64 = bytesToB64

async function deriveBits(phrase: string, salt: Uint8Array): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(phrase), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: KDF_ITERATIONS }, material, 256)
  return new Uint8Array(bits)
}

/** Fresh random salt for an enable. */
export function newSalt(): string {
  return bytesToB64(crypto.getRandomValues(new Uint8Array(16)))
}

/** Phrase + salt → the sealing key (base64). Paid once, at enable time. */
export async function deriveDecoyKey(phrase: string, saltB64: string): Promise<string> {
  return keyToB64(await deriveBits(phrase, b64ToBytes(saltB64)))
}

/** Encrypt the state under the pre-derived key. The salt rides inside the blob
 *  so the unhide can re-derive from the typed phrase alone. */
export async function sealState(json: string, saltB64: string, keyB64: string): Promise<string> {
  const d = await encryptEnvelope(b64ToBytes(keyB64), json)
  return b64encode(JSON.stringify({ s: saltB64, d }))
}

/** Decrypt a sealed blob with the typed phrase. Throws on a wrong phrase, a
 *  tampered blob, or a decrypt that is not a plausible persisted state — never
 *  trust bytes into becoming app state on the strength of a phrase alone. */
export async function openState(blob: string, phrase: string): Promise<string> {
  let inner: { s?: string; d?: string }
  try {
    inner = JSON.parse(b64decode(blob.trim())) as typeof inner
  } catch {
    throw new Error('not sealed')
  }
  if (typeof inner.s !== 'string' || typeof inner.d !== 'string') throw new Error('not sealed')
  const key = await deriveBits(phrase, b64ToBytes(inner.s))
  const json = await decryptEnvelope(key, inner.d)
  const o = JSON.parse(json) as { circles?: unknown }
  if (typeof o !== 'object' || o === null || !Array.isArray(o.circles)) throw new Error('not a state')
  return json
}

/** The same KDF cost as a real unhide attempt, against a throwaway salt — the
 *  constant-work filler so a fresh install and a decoy fail indistinguishably. */
export async function dummyWork(phrase: string): Promise<void> {
  await deriveBits(phrase, new Uint8Array(16))
}
