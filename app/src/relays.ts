// Relay sets — adopted from pallasite/src/credits.ts, applied with a privacy split.
//
// flock's threat model treats relays as untrusted (see docs/PRIVACY.md), so the
// two sets are used for DIFFERENT purposes:
//
//   PRIVATE_RELAYS  — our own, no-log relay(s). ALL sensitive flock traffic goes
//                     here (location beacons, alerts, check-ins, group state,
//                     gift-wrapped invites). Until "gift-wrap-everything" lands,
//                     sensitive traffic must NOT be sprayed across public relays,
//                     so this stays our relay only. (≈ pallasite EXPERIMENTAL_RELAYS.)
//
//   PROFILE_RELAYS  — the broad public set, used ONLY for reading public kind:0
//                     profiles (names/avatars), which are public anyway.
//                     (≈ pallasite DEFAULT_RELAYS.)

const ENV_RELAY = import.meta.env.VITE_DEFAULT_RELAY

/** Our own relay(s) — sensitive flock traffic only. Overridable at build time. */
export const PRIVATE_RELAYS: readonly string[] = ENV_RELAY ? [ENV_RELAY] : ['wss://relay.trotters.cc']

/** Broad public set — for reading public kind:0 profiles only. */
export const PROFILE_RELAYS: readonly string[] = [
  'wss://relay.trotters.cc',
  'wss://nos.lol',
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
  'wss://relay.ditto.pub',
]
