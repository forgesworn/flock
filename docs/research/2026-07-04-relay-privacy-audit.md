# Relay privacy audit — what a hostile relay actually learns

**Date:** 2026-07-04 · Adversarial review of shipped code (`app/src/`, `src/`)
against a logging relay operator / passive network observer. Question asked:
*"are we leaking anything over Nostr relays?"*

## Headline

The architecture is genuinely strong. Gift-wrap-everything is real and
correctly wired — a logging relay gets **no identities, no content, no event
types, no roster**. The naïve leaks the docs describe (bare kind-20078 with
stable d-tags, kind-30078 p-tag rosters) never touch the wire: the app never
publishes those kinds at all. Residual exposure is **connection metadata**
(movement/online-state per source IP), one **opt-in roster leak to public
relays**, and the **spoken word-invite's 44-bit floor**.

## The wire surface (all of it)

| # | What | Relays | Author | Relay-visible tag | Timing |
|---|------|--------|--------|-------------------|--------|
| 1 | ALL signals as kind 1059 wraps | private | throwaway per wrap | `#p` = circle inbox pk (month-stable, reseed-rotated) | created_at backdated ≤2 days; +16d expiry |
| 2 | Invites/reseeds/DMs/exact-meeting as kind 1059 | private | throwaway | `#p` = personalInboxTag (static hash of npub) | as above |
| 3 | Spoken word-invite, kind 20079 (NOT wrapped) | private | throwaway | `#t` = hash of code-derived seed | real time; +15 min expiry |
| 4 | Public profile REQ, kind 0 (opt-in) | 6 PUBLIC relays | — | filter `authors:[every member across all circles]` | on demand |

Kinds 1059 blend with all NIP-17 traffic (no flock fingerprint); kind 20079
IS a flock fingerprint; path 4 hands the roster to public infrastructure.

## Findings (ranked)

- **F1 (Med-High) Movement leaks via publish timing/volume per source IP** —
  cadence swings ~6× between moving (45 s floor, new cell each publish) and
  still (300 s heartbeat). Backdated created_at doesn't help; relays log real
  arrival time. Fix: Tor endpoint (removes IP), then jitter + stationary cover
  traffic.
- **F1b (fold into F1) Keepalive ping (SimplePool enablePing, 29 s)** makes
  online/offline windows and IP handovers continuously visible — the price of
  the reachability fix (subs died permanently before). Same fix: Tor.
- **F2 (Med) Group inbox pk is a shared month-stable correlator** in every
  member's REQ filter — clusters circle membership + active hours by IP for up
  to a month. Fix: Tor; consider weekly rotation for high-risk circles.
- **F2b (minor) Roll-call (`ask:'location'`)** rides inside the encryption (no
  wire change) but induces a synchronised beacon burst — a timing amplifier of
  F2's clustering.
- **F3 (Med) Opt-in profile fetch batches the ENTIRE roster** into one
  `authors` REQ to six public relays — collapses circle unlinkability behind
  one under-explained toggle. Fix: warn honestly, unbatch, or drop the feature
  in favour of handles/petnames.
- **F4 (Med) Word-invite is 44-bit against a logging relay AND parks the real
  seed** — a captured kind-20079 ciphertext can be brute-forced offline at
  leisure; the 15-min expiry defends nothing against a logger. Fix: 6 words /
  higher scrypt, park a one-time reference not the seed, delete-on-fetch.
- **F5 (Low) Latent footguns** — dead `subscribeSignals`/`publishEvent` (bare
  20078, stable d-tag) invite silent reintroduction of the exact leak the
  design closed; the relay textarea accepts any relay with no no-log warning.
- **F6 (Low, part feature) BLE→relay bridge** re-publishes from the bridging
  phone's IP — improves the ORIGIN's anonymity, widens the bridge's surface
  (crowd-mesh links its IP to foreign inbox tags). Opt-in; trade documented.
- **F7 (Info) Signet/NIP-46 session** is visible to the private relay
  (kind-24133, p-tagged signer keys). Standard, opt-in.

## FLOCK.md §6 invariants — verified in code

1. Withhold ≡ share observationally: **HOLDS** (all opaque 1059; a stopped
   share is indistinguishable from app-closed at the relay).
2. Duress ≡ normal: **HOLDS** (help = identical wrap; NIP-44 padding; duress
   key inside the encryption).
3. Beacon/duress key separation: **HOLDS** (`deriveBeaconKey` vs
   `deriveDuressKey`; inbox key is transport-only).
4. Coordinates never leave unencrypted: **HOLDS** (geohash → encryptBeacon →
   wrap; zones never transmitted).

**Spec drift:** FLOCK.md §3 / PRIVACY.md still describe the 20078/30078 model
the app has outgrown — align the docs so nobody reintroduces a bare publish
believing it's the design (ties to F5).

## Mitigations, priority order

1. `.onion` relay endpoint (kills F1/F1b/F2/F2b at a stroke — highest leverage).
2. Timing hygiene: cadence jitter + low-rate stationary cover traffic.
3. Profile fetch: honest warning, per-pubkey REQs, or retire the feature.
4. Word-invite: 6 words / costlier scrypt / park a reference, delete-on-fetch.
5. Delete dead bare-20078 paths; warn on unknown relays in settings.
6. Weekly inbox rotation option for high-risk circles.
