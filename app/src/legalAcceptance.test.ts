import { describe, expect, it } from 'vitest'
import {
  LEGAL_ACCEPTANCE_VERSION,
  hasLegalAcceptance,
  recordLegalAcceptance,
  type LegalStorage,
} from './legalAcceptance'

function memoryStorage(initial?: string): LegalStorage & { value: string | null } {
  return {
    value: initial ?? null,
    getItem() { return this.value },
    setItem(_key, value) { this.value = value },
  }
}

describe('legal acceptance', () => {
  it('rejects missing, stale, malformed, or incomplete acknowledgements', () => {
    expect(hasLegalAcceptance(memoryStorage())).toBe(false)
    expect(hasLegalAcceptance(memoryStorage('{bad'))).toBe(false)
    expect(hasLegalAcceptance(memoryStorage(JSON.stringify({
      version: 'old', adult: true, consentingAdultsOnly: true, acceptedAt: 1,
    })))).toBe(false)
    expect(hasLegalAcceptance(memoryStorage(JSON.stringify({
      version: LEGAL_ACCEPTANCE_VERSION, adult: false, consentingAdultsOnly: true, acceptedAt: 1,
    })))).toBe(false)
  })

  it('records the current adult-only acknowledgement locally', () => {
    const storage = memoryStorage()
    recordLegalAcceptance(storage, 1_720_000_000_000)

    expect(hasLegalAcceptance(storage)).toBe(true)
    expect(JSON.parse(storage.value ?? '{}')).toEqual({
      version: LEGAL_ACCEPTANCE_VERSION,
      adult: true,
      consentingAdultsOnly: true,
      acceptedAt: 1_720_000_000_000,
    })
  })

  it('fails closed when storage is unavailable', () => {
    const storage: LegalStorage = {
      getItem() { throw new Error('blocked') },
      setItem() { throw new Error('blocked') },
    }
    expect(hasLegalAcceptance(storage)).toBe(false)
    expect(() => recordLegalAcceptance(storage)).toThrow('blocked')
  })
})
