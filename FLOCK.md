# FLOCK Protocol

**Status:** Draft · **Version:** 0.2 · **Date:** 2026-07-02

Coercion-resistant family & friends safety and privacy-preserving location
sharing. FLOCK is a thin application layer over **canary-kit** (which extends
**spoken-token**), adding location to the existing group + duress machinery.

## 1. Layering

```
spoken-token / PROTOCOL.md   — HMAC-counter → words derivation
        │
canary-kit / GROUPS.md       — Simple Shared Secret Groups (lifecycle)
canary-kit / CANARY.md       — duress tokens, liveness, encrypted beacons
        │
flock / FLOCK.md  (this)     — disclosure-on-event location, geofencing,
                               night-out ephemeral sharing
```

FLOCK adds **no new cryptography**. It composes canary-kit's group seed, beacon
key (`deriveBeaconKey`), duress key (`deriveDuressKey`), AES-256-GCM envelopes,
and Nostr transport (kinds 30078/20078, NIP-44, NIP-59/NIP-17, NIP-40).

## 2. Roles & modes

| Mode | Topology | Default disclosure | Lifetime |
|---|---|---|---|
| **family** | asymmetric: guardian ↔ child | **withhold** until breach/pickup/help | ongoing |
| **nightout** | symmetric peers | **coarse** (cloaked) while shared | time-boxed (NIP-40) |

A member's role is carried in the group-state event (see §3.1). `guardian`
members receive disclosures; `child`/`peer` members emit them.

## 3. Event model

All events are canary-kit SSG events. Group ids are hashed (`SHA-256`) into the
`d` tag of signals for privacy, exactly as canary-kit does.

### 3.1 Group state — kind `30078` (replaceable)

Built with `buildGroupStateEvent` (canary-kit/nostr). `content` is the NIP-44
encrypted group config. Tags: `d = ssg/<groupId>`, one `p` per member, NIP-32
labels, and optionally `rotation`, `tolerance`, and **`expiration`** (NIP-40).

- **Family** groups omit `expiration` (ongoing).
- **Night-out** groups MUST set `expiration = startedAt + durationSeconds`
  (`buildNightOutGroupEvent` / `nightOutExpiry`) so relays drop the group and
  clients stop honouring it once the night ends.

Member roles (`guardian` | `child` | `peer`) are part of the encrypted config
payload (not a public tag).

### 3.2 Safe-place (geofence) sync — `t = "fences"` signal

A circle's safe places are shared as an ordinary encrypted signal — **not** a
replaceable kind-30078 stored event, whose stable `d`-tag would hand the relay a
long-lived correlator. Post gift-wrap-everything, the fence set rides the same
opaque `kind:1059` path as every other signal. `buildFencesSignal`
(`src/fences.ts`) encrypts the **complete** set with the group envelope key:

```jsonc
{ "fences": [ /* Geofence[] */ ], "updatedAt": 1781913600, "by": "<editor pubkey hex>" }
```

Semantics: idempotent full-replacement, **latest-wins**. A receiver applies a set
only when it is newer — higher `updatedAt`; equal clocks tie-break to the
lexicographically smaller `by`, so concurrent edits converge on every device; an
exact echo is a no-op. Every edit publishes the whole set, and an **empty set is
valid** (deleting the last fence must sync too). After a reseed, any member
holding the set replays it verbatim under the new key so later joiners find it.
Receivers **strictly re-validate** every fence on decrypt — a malformed set
throws rather than replacing a good one and silently disabling breach detection.

Each device still decrypts and evaluates membership **locally**; raw coordinates
never leave the device as plaintext. No-report zones are the deliberate opposite:
**never transmitted** at all (see `docs/PRIVACY.md`).

Fence shapes (`src/geofence.ts`):

```jsonc
// circle
{ "kind": "circle", "centre": { "lat": 51.5074, "lon": -0.1278 }, "radiusMetres": 250 }
// polygon (implicitly closed ring; ≥3 vertices)
{ "kind": "polygon", "vertices": [ { "lat": …, "lon": … }, … ] }
```

A **breach** is being outside *every* fence in the set (`isWithinAnyFence` =
false; the per-fence check is `isBreach`).

### 3.3 Signals — kind `20078` (ephemeral)

Built with `buildSignalEvent`; the `t` tag carries the type. Ephemeral events are
not stored by relays. Core types (`t` → payload / key / trigger):

| `t` | Payload | Key | Trigger |
|---|---|---|---|
| `beacon` | `BeaconPayload` | beacon key | night-out coarse share |
| `breach` | `BeaconPayload` | beacon key | left every geofence |
| `pickup` | `BeaconPayload` | beacon key | "pick me up" pressed |
| `help`  | `DuressAlert`  | duress key | SOS / duress |
| `allclear` | `AllClear {member, timestamp, coerced?}` | group envelope key | "I'm safe now" — stands down the member's `help` alert. A **coerced** all-clear (flag inside the encryption, long-press to send) is IGNORED by receivers: the sender's screen shows a normal stand-down while the circle stays alarmed (§6.1) |
| `checkin` | `CheckIn {member, timestamp, intervalSeconds}` | group envelope key (`deriveGroupKey`) | dead-man's-switch heartbeat |
| `ack` | `CheckInAck {member, target, timestamp}` | group envelope key | "I've got this" — a watcher claims a missed check-in; other watchers stand their repeat alerts down (§3.5) |
| `fences` | `FenceSet {fences, updatedAt, by}` | group envelope key | someone edits the circle's safe places (full-set, latest-wins — §3.2) |
| `rzv` | `Rendezvous {id, place, deadline, mode, setBy, createdAt}` | group envelope key | someone sets "be at a place by a time" |
| `rzv-status` | `RendezvousStatus {rendezvousId, member, status, etaSeconds, timestamp}` | group envelope key | a member's en-route / arrived / at-risk update |
| `mtg-req` | `MeetingRequest {id, setBy, mode, maxTimeMinutes, createdAt}` | group envelope key | propose finding a fair meeting point |
| `mtg-loc` | `MeetingShare {requestId, member, geohash, precision, mode, timestamp}` | group envelope key (coarse) **or** recipient's key via NIP-59 (exact) | **opt-in** spot toward a meeting point — coarse to the group, or exact to one named person |

`BeaconPayload` (`encryptBeacon`/`decryptBeacon`):

```jsonc
{ "geohash": "gcpuuz", "precision": 6, "timestamp": 1781913600 }
```

**Meeting point (`mtg-req` / `mtg-loc`).** Finding a fair place needs locations, so
it is a **new, voluntary, per-request disclosure** that must not become a standing
leak. A proposal (`mtg-req`) invites contributions; each `mtg-loc` is **only sent if
the member actively opts in** (declining sends nothing, which is observationally
identical to sharing). By default a contribution is a member's **coarse** cell only —
a neighbourhood geohash (precision 6, = `policy.coarse`) — sent to the group inbox.

A member may additionally choose **"exact, only to &lt;proposer&gt;"**: the coarse cell
still goes to the group, **plus** a precise (geohash-9) `mtg-loc` **gift-wrapped
(NIP-59) to the proposer's personal inbox** — encrypted to *their* key and filed
under `personalInboxTag`, so only the proposer decrypts it and no npub reaches the
relay. Exact never reaches the group; the finer disclosure is preferred whichever
order the two land in.

The proposer's device decodes the cells and computes the fair midpoint **entirely
on-device**. It may then search **real venues** via a **same-origin Overpass proxy**
(`/overpass/*`) — only the search-area **bounding box** leaves the device, never a
participant's coordinates — and the chosen point is published as an ordinary `rzv`.

`help` reuses canary-kit's `DuressAlert` verbatim (`buildHelpSignal` →
`buildDuressAlert` + `encryptDuressAlert`): `{ type, member, geohash, precision,
locationSource, timestamp, scope, originGroupId? }`, with `scope ∈ {group,
persona, master}` for propagation and `precision` upgraded toward 11.

> Builders return **unsigned** events. The caller signs (NIP-01) and gift-wraps:
> flock NIP-59 gift-wraps (kind 1059) **every** signal — unconditionally, in
> both modes — hiding sender + event kind from relays (see `docs/PRIVACY.md`).
> Wrapping is not a per-mode option: an unwrapped signal would itself be a tell.

### 3.4 Secure onboarding & reseed (NIP-59)

The circle **seed** is the shared secret. Two distribution paths:

- **In person** — the seed is encoded into a QR/text invite code and scanned/typed.
  The seed never touches a network (strongest).
- **Remote** — the seed is **gift-wrapped (NIP-59)** to a specific recipient
  pubkey: a kind-14 rumour `{t:'invite', id, s:seed, n, m}` → seal (kind 13) →
  gift wrap (kind 1059), published `#p`-tagged to the recipient. Only they can
  unwrap it; the relay learns neither sender nor contents. The recipient shares
  their npub (public, non-secret) out of band first.

**Reseed / member removal** reuses the same primitive: generate a fresh seed and
`wrapManyEvents` it as `{t:'reseed', …}` to the members you keep. A removed member
is simply excluded from the recipient set, so they never receive the new seed and
are locked out. Old beacons/alerts under the previous seed no longer decrypt.

### 3.5 Check-in / dead-man's-switch

A member arms a cadence and broadcasts an encrypted `checkin` (`t=checkin`,
envelope-keyed) on each manual "I'm OK". Every device runs `classifyCheckins`:
`ok` while within the interval, `overdue` within a grace window, **`missed`**
(the alarm) beyond it. Absence of action raises the alarm — the dead-man's-switch.
A stand-down is a final check-in with `intervalSeconds <= 0`. **Auto-sending is
deliberately not done** — the user must actively check in, so incapacitation
surfaces as a missed check-in.

**Self-reminder (local only).** Before the deadline the member's own device
nudges them (`selfCheckInStatus`: `due-soon` → `overdue` → `missed`). The
reminder emits **no traffic** — a nudge that published anything would be a tell
(§6 invariant 1).

**Escalation until acknowledged.** A miss must not be a single toast that
gets swiped away. Every watcher escalates locally (`classifyEscalation`, levels
0→2 by time since the miss) until a watcher claims it by sending an `ack`
(`CheckInAck {member, target, timestamp}`, envelope-keyed): the first responder
wins, every other device shows who has it and stands its repeat alerts down.
An ack is dead once `target` checks in again (`timestamp <=` their latest
check-in), so a stale ack can never silence a *new* miss. Only the responder's
own key can claim (sender pubkey must match `member` — mirrors `allclear`).
Escalation stays **peer-to-peer through the circle**: there is deliberately no
monitoring centre — a paid custodian would be a centralised, subpoenable party.

## 4. Disclosure-on-event policy

The privacy core (`src/policy.ts`, `decideEmission`). Location is plaintext only
on the holder's own device; it is encrypted-and-published only when an event
justifies it. Precedence (strongest intent first):

```
help  >  pickup  >  geofence breach  >  night-out coarse  >  withhold
```

| Decision | Action | Geohash precision (default) |
|---|---|---|
| help | full | 11 |
| pickup | full | 9 |
| breach (family) | full | 9 |
| night-out | coarse | 6 (~±0.6 km grid-cell cloaking) |
| otherwise | withhold | — (emit nothing) |

When no position is available the action is `withhold`, but the `reason` is
preserved so a location-less `help`/`pickup` alert (`locationSource: "none"`)
can still be sent.

## 5. Night-out specifics

- **Coarse cloaking.** Beacons are emitted at low geohash precision (grid-cell
  k-anonymity). Planar-Laplace noise for formal *geo-indistinguishability*
  (Andrés et al., CCS 2013) is a future enhancement applied at the edge before
  encoding.
- **Presence.** `classifyPresence` collapses to each member's latest beacon and
  marks them `active` or `stale` (default: no beacon for 600 s ⇒ "gone home").
  `stillOut` returns the members still active ("last at the bar").
- **Separation.** `geoOutliers` flags members beyond a distance threshold from
  the group's **median** centre (robust to the very outlier being detected) — a
  "someone's wandered off / got lost" signal.

## 6. Security considerations

Grounded in the feasibility research (`docs/research/2026-06-30-feasibility-research.md`):

1. **Withholding must not be a detectable "tell".** (Levy & Schneier, 2020.) The
   withheld-by-default state MUST be observationally identical to active sharing
   from any observer's view. A coerced "stop sharing" SHOULD emit a silent alarm,
   never a visible status change. *Implemented:* a silent long-press on **stop
   sharing**, **check-in disarm**, or **off-grid** performs the identical visible
   action and additionally raises the circle `help` alarm via the duress-key
   path; the raising device suppresses its own relay echo, so nothing on the
   coerced screen ever changes — only other members light up. On the wire the
   extra wrap is indistinguishable from any other signal (`kind:1059`).
   The same treatment covers standing DOWN an alert: "tell them you're fine"
   is exactly what a coercer demands, so a long-press "I'm safe now" sends an
   `allclear` whose `coerced` flag rides inside the encryption — the sending
   screen and the wire look identical to a genuine stand-down, but receivers
   keep the alarm live.
2. **Duress must be indistinguishable and generative.** (Clark & Hengartner,
   2008.) A `help` trigger MUST look identical to normal use; the duress
   vocabulary MUST be generative, not a small fixed set (reuse canary-kit duress
   tokens).
3. **Key domain separation.** Beacon and duress payloads use distinct derived
   keys (`deriveBeaconKey` vs `deriveDuressKey`) — never share key material
   across signal types.
4. **Local evaluation.** Geofence membership is evaluated on-device; fence
   coordinates are shared only as a group-encrypted set, and raw positions are
   never transmitted except as an encrypted beacon after a triggering event.
5. **Asymmetric vs symmetric threat models.** Family mode carries child-safety
   and legal duty-of-care obligations and an asymmetric power relationship;
   night-out mode is consensual, symmetric, and ephemeral. Defaults differ
   accordingly and MUST NOT be conflated.
6. **Bounded relay retention.** Every gift wrap carries a NIP-40 `expiration`:
   one **uniform 16-day** window for all wrap types (a per-type window would be
   a type-tell), derived from the already-backdated `created_at` (real time
   would undo the timing blur) — so the tag adds zero information. Epoch
   rotation bounds a key compromise *forwards*; expiry bounds it *backwards* to
   ~two weeks of stored ciphertext. Consequence: relay replay only covers the
   window, so long-lived synced state (the fence set, §3.2) MUST be republished
   by its author when a new member appears.

## 7. Open items

- Formal geo-indistinguishability (planar-Laplace) for night-out beacons.
- Background delivery on GrapheneOS without Google APIs — **unproven**, must be
  prototyped before the native path is locked (see DESIGN Phase 0).
- A registered/parameterised Nostr application profile (NIP-FLOCK), analogous to
  canary-kit's NIP-CANARY.
