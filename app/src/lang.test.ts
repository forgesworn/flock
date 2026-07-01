import { describe, it, expect } from 'vitest'
import { preferredMapLang } from './lang'

describe('preferredMapLang', () => {
  it('gives each launch market its own language', () => {
    expect(preferredMapLang({ language: 'en-GB' })).toBe('en') // UK
    expect(preferredMapLang({ language: 'de-DE' })).toBe('de') // Germany
    expect(preferredMapLang({ language: 'cs' })).toBe('cs') // Czech
    expect(preferredMapLang({ language: 'es-ES' })).toBe('es') // Mallorca (Spanish)
    expect(preferredMapLang({ language: 'ca-ES' })).toBe('ca') // Mallorca (Catalan)
    expect(preferredMapLang({ language: 'pt-PT' })).toBe('pt') // Madeira
  })

  it('is region-agnostic and case-insensitive', () => {
    expect(preferredMapLang({ language: 'DE-de' })).toBe('de')
    expect(preferredMapLang({ language: 'pt-BR' })).toBe('pt')
    expect(preferredMapLang({ language: 'fr-CH' })).toBe('fr')
  })

  it('falls back to English for scripts we do not ship glyphs for (would tofu)', () => {
    expect(preferredMapLang({ language: 'ja-JP' })).toBe('en')
    expect(preferredMapLang({ language: 'zh-CN' })).toBe('en')
    expect(preferredMapLang({ language: 'ko-KR' })).toBe('en')
    expect(preferredMapLang({ language: 'th-TH' })).toBe('en')
    expect(preferredMapLang({ language: 'ar-SA' })).toBe('en') // Noto Sans base has no Arabic glyphs
    expect(preferredMapLang({ language: 'he-IL' })).toBe('en')
  })

  it('defaults to English when the locale is absent or empty', () => {
    expect(preferredMapLang({})).toBe('en')
    expect(preferredMapLang({ language: '' })).toBe('en')
  })
})
