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
live**; 6 (multi-relay) ships as delivery redundancy; 7–8 remain planned.

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
7. **Off-relay transport (`mesh-kit`).** For local/proximity, use no relay at all.
8. **Timing hygiene.** Jittered beacon schedules; optional cover traffic so silence vs activity isn't itself a signal.

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
| Real **arrival timing + volume** (bursts) | Timing hygiene / cover traffic (planned) |

**The honest framing:** this is **defence in depth on top of "the relay is untrusted"**,
never a reason to trust it. The damaging residual is the **IP** — Tor's job, not the
operator's promise — so a `.onion` endpoint on a plain no-log relay beats a
"provable-no-log" (TEE) relay for the metadata that actually matters here. See
`docs/plans/2026-07-01-second-no-log-relay.md`.

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
tag for invites/reseeds, and multi-relay fan-out — is implemented and deployed. What
remains is the **residual connection metadata** (IP, timing, pseudonymous graph),
addressed by a `.onion` relay endpoint and off-relay transport (planned, not yet
shipped), plus timing hygiene / cover traffic.
