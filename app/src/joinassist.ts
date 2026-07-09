// Helpers behind the "join a circle" assists — classifying what a scanned QR
// actually carries, and deciding when a browser-tab join should offer the way
// across to the installed app. Pure decisions only: DOM, camera and clipboard
// live in the controllers (app.ts, qrscan.ts).

import { decodeInvite, inviteCodeFrom, npubToHex } from './store'

/** What a scanned QR carries: a circle invite (join code), a member's invite
 *  key (npub), or nothing flock recognises. */
export type ScannedCode =
  | { kind: 'join'; code: string }
  | { kind: 'invite-key'; npub: string }
  | null

/** Classify a decoded QR payload. Strict on purpose: a random QR in the wild
 *  (a poster, a wifi card) must classify as null — never a join, never a key. */
export function classifyScan(text: string): ScannedCode {
  const t = text.trim()
  if (!t) return null
  const code = inviteCodeFrom(t)
  try {
    decodeInvite(code)
    return { kind: 'join', code }
  } catch { /* not a circle invite — try the key shape */ }
  const npub = t.match(/npub1[a-z0-9]+/)?.[0]
  if (npub) {
    try { npubToHex(npub); return { kind: 'invite-key', npub } } catch { return null }
  }
  return null
}

/** Should a browser-tab join offer "copy this into the installed app"? The
 *  iPhone camera opens join links in Safari — an installed web app cannot
 *  claim a link on iOS — and browser and home-screen app keep SEPARATE
 *  storage, so a join completed here lands in a different identity from the
 *  app the guest actually uses. Standalone display IS the installed app, the
 *  native shell likewise, and desktop has no home-screen app to hand off to. */
export function shouldOfferAppHandoff(opts: { userAgent: string; standalone: boolean; nativeShell: boolean }): boolean {
  if (opts.nativeShell || opts.standalone) return false
  return /iphone|ipad|ipod|android/i.test(opts.userAgent)
}
