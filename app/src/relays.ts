// Relay sets — adopted from pallasite/src/credits.ts, applied with a privacy split.
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

const WS_URL = /^wss?:\/\//i

/** Trim, keep only ws(s):// URLs, and dedupe (first occurrence wins). */
function cleanRelays(list: readonly unknown[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of list) {
    const url = String(raw ?? '').trim()
    if (!WS_URL.test(url) || seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

/** Parse a user-entered relay list (settings textarea) into a clean set — split on
 *  newlines, commas or whitespace so a pasted list works however it is formatted. */
export function parseRelayList(text: string): string[] {
  return cleanRelays(String(text ?? '').split(/[\s,]+/))
}

/** The effective relay set from persisted state: prefer a saved `relayUrls` list,
 *  migrate a legacy single `relayUrl`, and always return a non-empty, cleaned set
 *  (falling back to PRIVATE_RELAYS when nothing usable is saved). */
export function resolveRelays(saved?: { relayUrls?: unknown; relayUrl?: unknown }): string[] {
  const urls = saved?.relayUrls
  const legacy = saved?.relayUrl
  const candidates: readonly unknown[] =
    Array.isArray(urls) && urls.length ? urls
      : typeof legacy === 'string' ? [legacy]
        : PRIVATE_RELAYS
  const cleaned = cleanRelays(candidates)
  return cleaned.length ? cleaned : [...PRIVATE_RELAYS]
}
