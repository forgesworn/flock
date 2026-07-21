export const LEGAL_ACCEPTANCE_VERSION = '2026-07-10-v1'

const LEGAL_ACCEPTANCE_KEY = 'flock:legal:v1'

export interface LegalStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

interface LegalAcceptance {
  version: string
  adult: true
  consentingAdultsOnly: true
  acceptedAt: number
}

function browserStorage(): LegalStorage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** A local acknowledgement is a contractual product gate, not age assurance. */
export function hasLegalAcceptance(storage: LegalStorage | null = browserStorage()): boolean {
  if (!storage) return false
  try {
    const raw = storage.getItem(LEGAL_ACCEPTANCE_KEY)
    if (!raw) return false
    const value = JSON.parse(raw) as Partial<LegalAcceptance>
    return value.version === LEGAL_ACCEPTANCE_VERSION
      && value.adult === true
      && value.consentingAdultsOnly === true
      && typeof value.acceptedAt === 'number'
      && Number.isFinite(value.acceptedAt)
      && value.acceptedAt > 0
  } catch {
    return false
  }
}

function browserRemovable(): { removeItem(key: string): void } | null {
  try { return globalThis.localStorage ?? null } catch { return null }
}

/** Remove the local legal acknowledgement entirely. Used by the decoy hide so a
 *  sealed app reboots looking like a genuine fresh install — which has no such key
 *  at all (a blanked-but-present key would itself be a tell). */
export function clearLegalAcceptance(storage: { removeItem(key: string): void } | null = browserRemovable()): void {
  try { storage?.removeItem(LEGAL_ACCEPTANCE_KEY) } catch { /* storage unavailable */ }
}

export function recordLegalAcceptance(
  storage: LegalStorage | null = browserStorage(),
  acceptedAt = Date.now(),
): void {
  if (!storage) throw new Error('Browser storage is unavailable')
  const acceptance: LegalAcceptance = {
    version: LEGAL_ACCEPTANCE_VERSION,
    adult: true,
    consentingAdultsOnly: true,
    acceptedAt,
  }
  storage.setItem(LEGAL_ACCEPTANCE_KEY, JSON.stringify(acceptance))
}
