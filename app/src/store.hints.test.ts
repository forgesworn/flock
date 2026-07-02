import { describe, it, expect } from 'vitest'
import { hintShown, withHintDismissed, type Hints } from './store'

describe('helper hints — learn, then quieten (audit Slice 12)', () => {
  it('hints default ON for a fresh device (undefined state)', () => {
    expect(hintShown(undefined, 'home-watch')).toBe(true)
  })

  it('a dismissed hint stays dismissed; others still show', () => {
    const h = withHintDismissed(undefined, 'home-watch')
    expect(hintShown(h, 'home-watch')).toBe(false)
    expect(hintShown(h, 'home-sos')).toBe(true)
  })

  it('dismissing twice does not duplicate', () => {
    const h = withHintDismissed(withHintDismissed(undefined, 'a'), 'a')
    expect(h.dismissed).toEqual(['a'])
  })

  it('the master switch silences everything without losing dismissals', () => {
    const h: Hints = { on: false, dismissed: ['a'] }
    expect(hintShown(h, 'a')).toBe(false)
    expect(hintShown(h, 'b')).toBe(false)
    expect(hintShown({ ...h, on: true }, 'b')).toBe(true)
    expect(hintShown({ ...h, on: true }, 'a')).toBe(false) // dismissal survived the toggle
  })
})
