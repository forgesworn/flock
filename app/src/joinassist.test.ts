import { describe, it, expect } from 'vitest'
import { classifyScan, shouldOfferAppHandoff } from './joinassist'
import { encodeInvite, inviteLink, type Circle } from './store'
import { nip19, generateSecretKey, getPublicKey } from 'nostr-tools'
import jsQR from 'jsqr'
import { qrSvg } from './qr'

const circle = {
  id: 'c1',
  seedHex: 'a'.repeat(64),
  name: 'Sat night',
  mode: 'nightout',
} as unknown as Circle

const npub = nip19.npubEncode(getPublicKey(generateSecretKey()))

describe('classifyScan', () => {
  it('recognises a join QR — full link or bare code', () => {
    const link = inviteLink(circle, 'https://flock.example')
    expect(classifyScan(link)).toEqual({ kind: 'join', code: encodeInvite(circle) })
    expect(classifyScan(encodeInvite(circle))).toEqual({ kind: 'join', code: encodeInvite(circle) })
  })

  it('recognises an invite-key QR — #invite= link or bare npub', () => {
    expect(classifyScan(`https://flock.example/#invite=${npub}`)).toEqual({ kind: 'invite-key', npub })
    expect(classifyScan(npub)).toEqual({ kind: 'invite-key', npub })
  })

  // SAFETY: a random QR in the wild (a poster, a menu) must never be treated
  // as an invite — no join, no key fill, just "not a flock code".
  it('rejects anything else', () => {
    expect(classifyScan('https://example.com/menu')).toBeNull()
    expect(classifyScan('WIFI:T:WPA;S:cafe;P:pass;;')).toBeNull()
    expect(classifyScan('npub1notarealkey')).toBeNull()
    expect(classifyScan('')).toBeNull()
  })
})

describe('inviter QR → scanner decode → classify (the full in-person pipeline)', () => {
  it('round-trips: the QR the app shows is the QR the app can scan', () => {
    // Rasterise exactly what the invite screen draws (qrSvg: level 'L', 4 module
    // quiet zone, black on white), straight from the SVG it returns…
    const link = inviteLink(circle, 'https://flock.example')
    const svg = qrSvg(link)
    expect(svg).toContain('fill="#fff"')
    const side = Number(/viewBox="0 0 (\d+) \d+"/.exec(svg)![1])
    const scale = 4
    const size = side * scale
    const rgba = new Uint8ClampedArray(size * size * 4).fill(255)
    const d = /<path fill="#000" d="([^"]*)"/.exec(svg)![1]
    for (const [, x, y, run] of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)) {
      for (let row = 0; row < scale; row++) {
        for (let col = 0; col < Number(run) * scale; col++) {
          const px = ((Number(y) * scale + row) * size + Number(x) * scale + col) * 4
          rgba[px] = rgba[px + 1] = rgba[px + 2] = 0
        }
      }
    }
    // …decode it with the scanner's real decoder, then classify.
    const hit = jsQR(rgba, size, size)
    expect(hit?.data).toBe(link)
    expect(classifyScan(hit!.data)).toEqual({ kind: 'join', code: encodeInvite(circle) })
  })
})

describe('shouldOfferAppHandoff', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1'
  const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/125 Mobile Safari/537.36'
  const desktop = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125 Safari/537.36'

  // The iPhone camera app opens join links in Safari, NOT the installed web
  // app (iOS gives home-screen apps no way to claim a link) — and the two keep
  // SEPARATE storage, so a Safari join lands in the wrong identity. The guest
  // must be offered the way across.
  it('offers the handoff in a phone browser tab', () => {
    expect(shouldOfferAppHandoff({ userAgent: iphone, standalone: false, nativeShell: false })).toBe(true)
    expect(shouldOfferAppHandoff({ userAgent: android, standalone: false, nativeShell: false })).toBe(true)
  })

  it('never offers it inside the installed app — standalone PWA or native shell', () => {
    expect(shouldOfferAppHandoff({ userAgent: iphone, standalone: true, nativeShell: false })).toBe(false)
    expect(shouldOfferAppHandoff({ userAgent: android, standalone: false, nativeShell: true })).toBe(false)
  })

  it('stays quiet on desktop — there is no home-screen app to hand off to', () => {
    expect(shouldOfferAppHandoff({ userAgent: desktop, standalone: false, nativeShell: false })).toBe(false)
  })
})
