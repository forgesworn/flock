// The app lock — keystore-kit wiring for key-at-rest.
//
// A random 256-bit storage secret encrypts the persisted state at rest
// (store.ts rest layer); this module owns how that secret is protected:
// PIN-wrapped by keystore-kit (PBKDF2-600k → AES-GCM, namespace `flockks`),
// with the kit's grace mechanism — a non-extractable CryptoKey in IndexedDB —
// so a reload inside the window unlocks silently. The kit has no grace TTL,
// so flock keeps the window itself (`flockks.graceUntil`, 15 min): past it,
// the grace key is cleared and the PIN screen shows.
// Browser-only (localStorage/IndexedDB); exercised by e2e/lock.spec.ts.
// Design + limits: docs/plans/2026-07-02-app-lock.md.

import { Keystore, browserStorage } from 'keystore-kit'
import type { KeystoreStorage } from 'keystore-kit'

export const GRACE_WINDOW_MS = 15 * 60 * 1000
const GRACE_UNTIL_KEY = 'flockks.graceUntil'

let storage: KeystoreStorage | null = null
let kit: Keystore | null = null

function ks(): Keystore {
  if (!kit) {
    storage = browserStorage()
    kit = new Keystore(storage, {
      rpId: location.hostname,
      rpName: 'flock',
      prfSalt: new TextEncoder().encode('flock-app-lock-prf-salt-v1------'), // 32-byte app constant
      namespace: 'flockks',
    })
  }
  return kit
}

/** Fresh random 256-bit storage secret (hex). */
export function generateStorageSecret(): string {
  return ks().generateSecret()
}

/** Wrap the secret under the PIN and open a grace window. */
export async function setupPin(pin: string, secret: string): Promise<void> {
  await ks().setupPIN(pin, secret)
  await startGrace(secret)
}

/** Recover the secret from the PIN (null = wrong PIN); success renews grace. */
export async function unlockWithPin(pin: string): Promise<string | null> {
  const secret = await ks().unlockPIN(pin)
  if (secret) await startGrace(secret)
  return secret
}

/** Silent unlock inside the grace window; past it, clears the key and returns null. */
export async function unlockWithGrace(): Promise<string | null> {
  const until = Number(localStorage.getItem(GRACE_UNTIL_KEY) ?? 0)
  if (!Number.isFinite(until) || Date.now() >= until) {
    await endGrace()
    return null
  }
  try { return await ks().unlockGrace() } catch { return null }
}

async function startGrace(secret: string): Promise<void> {
  // Grace is a convenience — if it can't be set up (IndexedDB unavailable),
  // the PIN still works; the cost is a prompt on every open.
  try {
    await ks().setupGrace(secret)
    localStorage.setItem(GRACE_UNTIL_KEY, String(Date.now() + GRACE_WINDOW_MS))
  } catch { /* ignore */ }
}

export async function endGrace(): Promise<void> {
  localStorage.removeItem(GRACE_UNTIL_KEY)
  try { await (storage ?? browserStorage()).clearGraceKey() } catch { /* ignore */ }
}

/** Wipe every keystore trace — reset paths and the forgot-PIN escape. */
export async function burnLock(): Promise<void> {
  localStorage.removeItem(GRACE_UNTIL_KEY)
  try { await ks().burn() } catch { /* ignore */ }
}
