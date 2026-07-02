// Sign-in picker configuration for signet-login's `login()`.
//
// signet-login ships the whole NIP-46 stack (Signet, NIP-07 extension, generic
// `bunker://`, app-initiated `nostrconnect://`, Amber). flock deliberately
// shapes the picker: every "key stays in the signer" method is on, and the one
// method that would put a raw key back INTO flock — `nsec` (paste your private
// key) — is left OFF. That path reintroduces exactly the localStorage-nsec risk
// the remote-signer story exists to avoid; a user who wants a local key already
// has the honest quick-start option on the welcome screen.
//
// Gift-wrap needs NIP-44 (the seal is nip44-encrypted), so the NostrConnect
// perms request it up front and doSignetLogin rejects any signer that lacks it.

import type { LoginOptions, LoginPickerMethod } from 'signet-login'

/** Methods offered, in order. `nsec` is intentionally absent (see above).
 *  Unavailable ones (NIP-07 with no extension, Amber off-Android) self-hide. */
export const SIGN_IN_METHODS: LoginPickerMethod[] = [
  'local-signet',
  'remote-signet',
  'nip07',
  'amber',
  'bunker',
  'nostrconnect',
]

/** The power-user paste flows, tucked behind "Advanced" but reachable. */
export const SIGN_IN_ADVANCED: LoginPickerMethod[] = ['bunker', 'nostrconnect']

/** NIP-46 permissions the app-initiated flow requests — nip44 is mandatory for
 *  gift-wrapping, so it must be granted at pairing, not discovered missing later. */
export const SIGN_IN_PERMS = ['sign_event', 'nip44_encrypt', 'nip44_decrypt']

/** Build the `login()` options. `relays` is flock's no-log private set: it
 *  carries both the Signet cross-device channel and the NIP-46 transport, so a
 *  bunker/NostrConnect handshake rides the same relay flock already trusts. */
export function buildSignInOptions(appName: string, relays: string[]): LoginOptions {
  return {
    appName,
    methods: SIGN_IN_METHODS,
    advancedMethods: SIGN_IN_ADVANCED,
    relayUrl: relays[0],
    relayUrls: relays,
    nostrConnectPerms: SIGN_IN_PERMS,
  }
}
