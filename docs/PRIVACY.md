# flock — privacy & the relay threat model

**Assume the relay is hostile.** Compromised, compelled, or just logging. For a
coercion-aware safety tool, the relay must learn as close to *nothing* as possible.

## Where we started — the leak this architecture closes

| Event | A naïve Nostr design would expose | Leak |
|---|---|---|
| kind 20078 signal (beacon/breach/pickup/help/checkin) | your **real pubkey**, a **stable** d-tag (`sha256(groupId)`), the **`t` type in plaintext**, timestamp | identifies you; clusters a group's members; sees *when* help/breach/check-ins happen without decrypting; builds activity profiles |
| kind 30078 group/geofence state | **p-tags = the full member roster** | learns exactly who is in which group |
| kind 1059 gift wrap (invites) | ephemeral sender ✅, but **p-tag = recipient** | sees who's being invited |

A naïve design leaks **identities, group membership, event types, and
timing/correlation** — unacceptable for this product. The fix is architectural, and
it is now **shipped** (below) — not a setting.

## Privacy-by-architecture

The relay is treated as a dumb, untrusted pipe. Items 1–5 are **implemented and
live**; 6 (multi-relay) ships as delivery redundancy; 8 (timing hygiene)
partially shipped 2026-07-04 (cadence jitter + low-rate stationary cover
traffic — narrows the moving-vs-still swing; a broader silence-vs-activity
cover mode remains a further increment); 7 (off-relay transport) is a separate,
now-active effort (BLE-nearby, `docs/plans/2026-07-04-ble-nearby-transport.md`),
not this list's original `mesh-kit` framing.

1. **Gift-wrap *everything* (NIP-59).** Every beacon/alert/check-in is wrapped, not
   just invites. The relay sees only `kind:1059` from **random ephemeral keys** —
   real sender and event *type* are hidden inside the encryption.
2. **Shared, rotating group inbox key (nsec-tree).** Members publish wraps
   addressed to a **group-inbox pubkey** derived from the circle secret and
   subscribe to `#p=inbox`. The relay sees random senders → one opaque inbox key:
   **no real pubkeys, no roster, no types.** The real sender lives in the encrypted
   seal (members see it; the relay never does).
3. **Rotating identifiers (epochs).** The inbox key and any d-tags rotate per
   time-epoch (nsec-tree `index`) so a relay can't track a group long-term or
   correlate across epochs.
4. **Unlinkable personas (nsec-tree).** A **distinct derived persona per group**, so
   a colluding relay can't link your groups to each other or to your master key.
5. **No real keys in p-tags.** Membership lives only in encrypted payloads — never in
   p-tags; even **invites and reseeds** are filed under a derived **personal-inbox tag**
   (`personalInboxTag`), never a recipient's real npub, so no public identity appears in
   any p-tag (the last place one used to).
6. **Multi-relay fan-out.** Publish to several **no-log** relays and read across them for
   **delivery redundancy** — fail-loud if none accept — never the public profile set.
   (Resilience, not metadata-spreading: each relay sees what it is sent.)
7. **Off-relay transport.** For local/proximity, use no relay at all — now
   BLE-nearby (`docs/plans/2026-07-04-ble-nearby-transport.md`), superseding
   this item's original `mesh-kit` framing.
8. **Timing hygiene.** Jittered beacon schedules (±20%, both the movement floor
   and the still heartbeat); a low-rate cover-traffic publish fills the quiet
   stretch while stationary — wire-identical to a real beacon, carrying only
   random filler, silently discarded by every receiver (`app/src/cadence.ts`,
   `src/signals.ts`'s `cover` type). Shipped 2026-07-04 for the moving-vs-still
   swing (audit F1); cover traffic through a fully withheld/off period ("silence
   vs activity") is not yet built.

That is the "uber privacy" stance in practice. What it leaves on the table:

## What a logging relay can and can't see now

With gift-wrap-everything, the rotating group inbox, and the personal-inbox tag all
shipped, a fully-logging, hostile relay gets **no real identity and no content**:

| It CANNOT see | Because |
|---|---|
| Your real pubkey / npub | Wraps are authored by throwaway keys; signals go to a rotating derived inbox; invites/reseeds are filed under `personalInboxTag`, never your npub |
| Message content | Double-encrypted (rumor → seal → wrap, NIP-44) |
| The signal *type* | SOS, breach, pickup, check-in, buzz, "gone home" are all identical `kind:1059` — withholding is indistinguishable from sharing |
| Group membership / roster | Never in p-tags; lives only in encrypted payloads, evaluated on-device |
| Locations, geofences, no-report zones, petnames | All inside the encryption, or never transmitted |
| Even the real send time | The wrap's `created_at` is randomised up to 2 days into the past |

What it **can** still see is connection metadata, which no relay can avoid handling:

| It CAN see | Mitigation |
|---|---|
| Your **IP** → geolocation, pattern-of-life | A `.onion` endpoint removes it (Tor). This — not a "provable no-log" relay — is the high-leverage fix |
| **IP ↔ a pseudonymous inbox** (you subscribe to your own) → group size/shape, active hours | Rotates on reseed; further blunted over Tor |
| Real **arrival timing + volume** (bursts) | Cadence jitter + low-rate stationary cover traffic (shipped 2026-07-04, narrows the moving-vs-still swing); a `.onion` endpoint remains the fix for IP-level correlation |
| **Stored ciphertext history** — every retained wrap is decryptable by a *future* key compromise | Every wrap carries a NIP-40 `expiration`: one **uniform 16-day** window for all types (a per-type window would be a type-tell), derived from the backdated `created_at` (so the tag adds zero information). Epoch rotation bounds exposure forwards; this bounds it **backwards** to ~2 weeks |

**The honest framing:** this is **defence in depth on top of "the relay is untrusted"**,
never a reason to trust it. The damaging residual is the **IP** — Tor's job, not the
operator's promise — so a `.onion` endpoint on a plain no-log relay beats a
"provable-no-log" (TEE) relay for the metadata that actually matters here. See
`docs/plans/2026-07-01-second-no-log-relay.md`.

## Hosted relay rooms

Ephemeral relay rooms reduce what a relay can retain: RAM-only room state,
short TTLs, burn-after-use teardown, no accounts, and no persistent relay
database. They do not make a hosting provider blind. A provider such as Fly,
Hetzner, or any other infrastructure operator can still observe connection
metadata: IPs unless the user uses Tor/VPN, timing, bandwidth, region, and the
destination app or room endpoint. If the provider terminates TLS, it can also
observe the WebSocket stream before it reaches the room, although Flock payloads
remain NIP-59 encrypted.

The product claim is therefore: **Flock minimises what the relay can learn and
remember. It does not hide that you connected.** See
[`docs/relay-room-privacy.md`](relay-room-privacy.md) for the reusable wording,
Fly beta stance, and operator requirements.

## The map & the host — the other hop (audit Slice 10)

The relay never sees plaintext, but the **map does not use the relay**. The PWA is
served from our host, and the map's same-origin proxies (`/tiles/*`, `/nominatim/*`,
`/overpass/*`, `/api/extract`) exist so OpenStreetMap services never see users. That
moves the exposure to our edge. **Resolved 2026-07-02: the DNS record is grey-clouded
(DNS-only)** — TLS terminates at our Caddy alone, and Cloudflare is out of the traffic
path entirely (verified: direct Let's Encrypt chain, no `cf-ray` on any response). The
table below records what the *host* can see — one hop, ours, with access logs off:

| It CAN see | What it means | Mitigation |
|---|---|---|
| Your **IP** + tile viewports | the neighbourhoods you look at ≈ where you live/go | offline/vector basemap: a saved area pans with **zero** tile traffic (default from Slice 10) |
| Place-name searches (`/nominatim`) | addresses you type | same-origin proxy already hides you from OSM; searches are user-initiated and rare |
| Venue-search boxes (`/overpass`) | the area of a meeting-point search (never a member's coordinates — bbox only, by design) | bbox is already the *coarsest* artefact of the search |
| Offline-extract boxes (`/api/extract`) | the area you saved for offline ≈ home | treat as sensitive: no app-level logging, Caddy access logs off, per-IP rate-limit (6/10 min, salted-hash keys) — all done |

**The decision (taken 2026-07-02): grey-clouded.** Cloudflare no longer sees any
traffic — the accepted trade is losing its DDoS shielding and edge tile cache (worth
little once areas are saved offline) and the origin IP being public in DNS. A side
benefit: CF's Browser-Cache-TTL no longer overrides the origin's `no-cache` on
`index.html`/`sw.js`, so deploys reach returning users without cache fights.

Signals (SOS, beacons, check-ins…) are unaffected: they travel gift-wrapped over the
relay hop, not through the host.

## The device in a coercer's hand — the decoy view

The relay threat model assumes the phone is yours. The coercion threat model does
not: "unlock it and show me" makes flock itself the evidence — circles, members,
safe places, alert history. The answer is the **decoy view** (Phase J; design in
`docs/plans/2026-07-02-decoy-view.md`):

- **Hide** (a covert 1.2 s hold on the wordmark, or the You-tab card): the entire
  persisted state is sealed under a phrase-derived key — PBKDF2-SHA256 600k into
  the same AES-256-GCM envelope the backup uses, with **no magic bytes** — and the
  app reboots as a genuinely fresh install. Not a fake screen: a real, working app
  with no identity, no subscriptions (arriving signals render nothing), fully
  usable by the coercer.
- **Come back**: the ordinary "Restore from backup" screen — anything as the code,
  the unlock phrase as the passphrase. Wrong attempts produce the *genuine*
  fresh-install errors at the *genuine* cost (a dummy KDF fills the timing when
  nothing is hidden), so probing cannot distinguish a decoy from a first run.
- **Decoy over wipe**, deliberately: a destructive wipe under a legal hold risks
  obstruction liability; a sealed blob destroys nothing and stays recoverable by
  its owner.

**Honest limits.** This defends the *application layer* — an unlocked phone in a
coercer's hand. A forensic image of the browser profile still finds an opaque blob
(and the saved offline map area, which is not moved); an examiner can demand the
phrase. Hiding never emits anything — under real duress, the silent long-press on
"Stop sharing" alarms the circle first, then hide.

## The device at rest — the App lock

The complement to the decoy (keystore-kit, Phase E): an opt-in **PIN** puts the
whole persisted state — identity key, circle root, every seed, petnames, private
places — behind AES-256-GCM at rest. A random storage secret is PIN-wrapped
(PBKDF2-600k); a grace key means no re-prompt within 15 minutes; a cold boot past
that is a PIN screen holding **no state in memory at all**. With the lock on, a
lifted phone, a synced browser profile, or a copied disk yields ciphertext.
Composes with the decoy by design: the decoy shows **no PIN screen** (a lock gate
on a "brand new" app would be a tell), and coming back from hiding re-locks with
one PIN entry. Limits: a short PIN resists a snoop, not an offline PBKDF2 run —
the card nudges toward 6+ characters; Signet sign-in remains stronger still (the
key never enters flock).

## Captured requirements

### Private "no-report" zones (redaction zones)
Inverse geofences where the user is **never directly located** — home, a relative's
address. Even on breach / pickup / help, if the user is inside a redaction zone the
location is **withheld or coarsened** to a neighbourhood placeholder (never the exact
address). Evaluated in the `policy` layer *before* any emit. The zones themselves are
stored encrypted and evaluated on-device only.

### Off-grid / privacy mode (timed)
"I'm dark for 60 / 120 minutes." flock emits **nothing** for the window. It first
sends an encrypted **planned-absence** notice (`dark until T`) so the
**dead-man's-switch does not false-alarm** (per-user choice: silent, or still-alarm
for high-risk users). Auto-resumes when the window ends.

### Multiple groups, different lifetimes
A user belongs to **many circles at once**:
- **Transient** — "just tonight" (NIP-40 expiry, auto-dissolve).
- **Long-lived** — family.
Each circle is a **distinct nsec-tree persona** (unlinkable). flock state becomes a
list of circles with a switcher/overview, not a single circle.

## Status

**Built and live.** The privacy-by-architecture foundation — gift-wrap-everything,
nsec-tree personas/epochs, the rotating group inbox, multi-group, the personal-inbox
tag for invites/reseeds, and multi-relay fan-out — is implemented and deployed.
Cadence jitter + low-rate stationary cover traffic shipped 2026-07-04 (the audit's
F1), alongside a word-invite hardening pass (6 words, costlier scrypt,
reference-not-seed, delete-on-fetch — F4) and the dead bare-20078
`subscribeSignals`/`publishEvent` paths' removal (F5). What remains is the
**residual connection metadata** (IP, pseudonymous graph), addressed by a
`.onion` relay endpoint (see `docs/plans/2026-07-04-mesh-bridge-goal.md` Task B)
and off-relay transport (BLE-nearby, active — see
`docs/plans/2026-07-04-ble-nearby-transport.md`), plus a broader
silence-vs-activity cover-traffic mode.
