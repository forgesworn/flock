// Flock relay policy over Roost's canonical validation and routing mechanics.
//
// flock's threat model treats relays as untrusted (see docs/PRIVACY.md), so the
// two sets are used for DIFFERENT purposes:
//
//   PRIVATE_RELAYS  — our own, no-log relay(s). ALL sensitive flock traffic goes
//                     here (location beacons, alerts, check-ins, group state,
//                     gift-wrapped invites). Now that "gift-wrap-everything" has
//                     landed, every signal is an opaque kind:1059 to a rotating
//                     inbox, so this set may hold MORE THAN ONE relay and traffic
//                     is fanned out across them for delivery redundancy (a single
//                     relay is a single point of failure for a safety alert).
//                     Keep these to relays we trust not to log — adding a public
//                     relay still exposes timing + IP to that operator, opaque or
//                     not. (≈ pallasite EXPERIMENTAL_RELAYS.)
//
//   PROFILE_RELAYS  — the broad public set, used ONLY for reading public kind:0
//                     profiles (names/avatars), which are public anyway.
//                     (≈ pallasite DEFAULT_RELAYS.)

import {
  createRelayConfig,
  effectiveRelays as effectiveRoostRelays,
  isKnownNoLogRelay as isKnownRoostRelay,
  parseRelayList as parseRoostRelayList,
  resolveRelays as resolveRoostRelays,
  torRouteReady,
  unknownRelays as unknownRoostRelays,
} from '@forgesworn/roost-kit'

const ENV_RELAY = import.meta.env.VITE_DEFAULT_RELAY
const ENV_ONION_RELAY = import.meta.env.VITE_ONION_RELAY

/** Our own relay(s) — sensitive flock traffic only. Overridable at build time. */
const defaults = createRelayConfig({
  privateRelays: ENV_RELAY ? [ENV_RELAY] : ['wss://relay.trotters.cc'],
  onionRelays: ENV_ONION_RELAY
    ? [ENV_ONION_RELAY]
    : ['ws://gdtkccgtod3om7bvycaygjjske6sj6vnsu3d7csutkofnoa3ylt6haid.onion'],
  profileRelays: [
    'wss://relay.trotters.cc',
    'wss://nos.lol',
    'wss://relay.damus.io',
    'wss://relay.nostr.band',
    'wss://relay.primal.net',
    'wss://relay.ditto.pub',
  ],
})

export const PRIVATE_RELAYS = defaults.PRIVATE_RELAYS

/** The `.onion` twin of PRIVATE_RELAYS — same relay(s), reachable over Tor
 *  without ever exposing an IP (docs/plans/2026-07-04-mesh-bridge-goal.md Task
 *  B; DarkFi survey: adopt Tor as a user TOGGLE, not the default — unreliable
 *  on mobile). This is the v3 onion twin of relay.trotters.cc (stood up
 *  2026-07-11, verified end-to-end: NIP-11 + a NIP-40-expiring publish/read
 *  round-trip over a real Tor circuit). Plain `ws://` is deliberate — Tor's
 *  rendezvous encryption is the transport security, and no CA issues certs
 *  for `.onion` names we could pin instead. Override at build time via
 *  VITE_ONION_RELAY. Also bypasses the CDN in front of the clearnet relay,
 *  so neither the CDN nor the relay host ever sees a member IP. */
export const ONION_RELAYS = defaults.ONION_RELAYS

/** Broad public set — for reading public kind:0 profiles only. */
export const PROFILE_RELAYS = defaults.PROFILE_RELAYS

/** Parse a user-entered relay list (settings textarea) into a clean set — split on
 *  newlines, commas or whitespace so a pasted list works however it is formatted. */
export function parseRelayList(text: string): string[] {
  return parseRoostRelayList(text)
}

/** Whether a relay URL is one of the pre-vetted, trusted-not-to-log set. Anything
 *  else is unknown — added at the user's own risk (audit F5: the settings
 *  textarea used to accept and save any relay with no warning at all). */
export function isKnownNoLogRelay(url: string): boolean {
  return isKnownRoostRelay(url, PRIVATE_RELAYS)
}

/** The entries in `list` that fall outside the vetted set, in order — empty when
 *  every relay is known. Drives the honest warning in Settings (F5). */
export function unknownRelays(list: readonly string[]): string[] {
  return unknownRoostRelays(list, PRIVATE_RELAYS)
}

/** Whether the Tor route is actually usable right now: the toggle is on, at
 *  least one `.onion` relay is configured, AND Orbot's SOCKS proxy was
 *  detected reachable (native shell only — see native/orbot.ts; a PWA can
 *  never satisfy this, by design — Web has no way to reach a local SOCKS
 *  proxy or resolve a `.onion` address). */
export { torRouteReady }

/** The relay set to actually use, given the Tor toggle.
 *
 *  FAIL LOUD by design: the toggle is off by default, and when it is off this
 *  returns `clearnetRelays` completely unchanged — every existing user and
 *  every e2e flow is byte-for-byte unaffected. But once a user opts in, a
 *  route that ISN'T ready (no `.onion` relay configured yet, or Orbot isn't
 *  detected) must never silently fall back to clearnet — that would leak
 *  exactly the IP the toggle exists to hide, and worse, do it invisibly. So
 *  this throws instead, surfacing an actionable error the caller can show. */
export function effectiveRelays(opts: {
  clearnetRelays: readonly string[]
  onionRelays: readonly string[]
  torEnabled: boolean
  orbotDetected: boolean
}): string[] {
  return effectiveRoostRelays(opts)
}

/** The effective relay set from persisted state: prefer a saved `relayUrls` list,
 *  migrate a legacy single `relayUrl`, and always return a non-empty, cleaned set
 *  (falling back to PRIVATE_RELAYS when nothing usable is saved). */
export function resolveRelays(saved?: { relayUrls?: unknown; relayUrl?: unknown }): string[] {
  return resolveRoostRelays(PRIVATE_RELAYS, saved)
}
