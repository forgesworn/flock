# flock — privacy & the relay threat model

**Assume the relay is hostile.** Compromised, compelled, or just logging. For a
coercion-aware safety tool, the relay must learn as close to *nothing* as possible.

## What a relay can see in flock TODAY (and why that's not good enough)

| Event | The relay currently sees | Leak |
|---|---|---|
| kind 20078 signal (beacon/breach/pickup/help/checkin) | your **real pubkey**, a **stable** d-tag (`sha256(groupId)`), the **`t` type in plaintext**, timestamp | identifies you; clusters a group's members; sees *when* help/breach/check-ins happen without decrypting; builds activity profiles |
| kind 30078 group/geofence state | **p-tags = the full member roster** | learns exactly who is in which group |
| kind 1059 gift wrap (invites) | ephemeral sender ✅, but **p-tag = recipient** | sees who's being invited |

So today a logging relay can reconstruct: **identities, group membership, event
types, and timing/correlation.** That is not acceptable for this product. The fix
is architectural, not a setting.

## Privacy-by-architecture (the target design)

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
5. **No public rosters.** Membership lives only in encrypted payloads — never in p-tags.
6. **Multi-relay + rotation.** Spread metadata across relays; rotate. No single relay sees the whole picture.
7. **Off-relay transport (`mesh-kit`).** For local/proximity, use no relay at all.
8. **Timing hygiene.** Jittered beacon schedules; optional cover traffic so silence vs activity isn't itself a signal.

This is the "uber privacy" stance: the relay is treated as a dumb, untrusted pipe.

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

Design captured. This re-sequences the roadmap: **privacy-by-architecture
(gift-wrap-everything + nsec-tree personas/epochs + rotating group inbox +
multi-group)** becomes foundational, *ahead of* the remaining feature work, because
everything else rides on the transport being metadata-private.
