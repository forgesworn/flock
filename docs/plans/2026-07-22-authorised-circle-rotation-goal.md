# Goal: authorised, continuity-checked circle membership and rotation

**Date:** 2026-07-22 · **Status:** implementation goal · **Priority:** security-critical
before treating member removal or circle disband as adversarially robust

## Objective

Make every circle membership change an **authorised, continuity-checked state
transition** so that:

- only the circle's recorded lifecycle authority can rotate its access secret,
  remove members, change rotation authority, or disband the circle;
- a recipient adopts a new secret only when it extends the circle state they
  currently hold, or arrives through an explicit authorised catch-up path;
- removed members cannot regain access, inject circle actions, rotate the circle,
  or disband it merely because they retain old identifiers and member pubkeys;
- legitimate removals, routine rotation, offline catch-up, and re-invitation
  continue to work over the existing privacy-preserving transport;
- the relay still learns no real member pubkeys, roster, inner action type, or
  circle identity.

This is a membership and authority hardening goal. It must preserve Flock's
coercion, disclosure, metadata, native-background, and off-relay invariants.

## Why this is required

**The concrete security failure is that removing a hostile member does not
reliably keep that member out.**

An attack using the acceptance-test actors is:

1. `owner-a`, `member-b`, and `former-c` share a circle.
2. `owner-a` removes `former-c` and sends the honest replacement seed to
   `member-b`.
3. `former-c` still knows the circle id and `member-b`'s public key. That is
   normal former-member knowledge, not an owner-key or relay compromise.
4. `former-c` signs and encrypts a personal-inbox `reseed` for that known circle,
   containing a seed chosen by `former-c`.
5. `member-b` verifies that the message is signed and decryptable, but the
   current receive path checks only that the circle exists and the seed is new.
   It does not require the signer to be the circle's lifecycle authority and
   does not require the reseed to extend the exact epoch `member-b` holds.
6. `member-b` adopts the attacker-chosen seed. `owner-a` and `member-b` are now
   split across different circle states, while `former-c` knows the seed held by
   `member-b` and can create traffic that device can decrypt.

Because shared-inbox traffic is also processed before a single current-member
gate, attacker-authored traffic can then reach map, alert, buzz, ring, find,
notification, join, or lifecycle handling before the application establishes
that the signer is still allowed in the circle. Separately, any signer able to
produce a valid disband payload can currently pass the payload/signer binding;
the receiver does not additionally prove that the signer may end the circle.

The attacker does **not** need the owner's private key, control of a relay, or a
cryptographic break. A removed member already has the identifiers and member
pubkeys needed to address surviving devices. The missing check is application
authority and state continuity.

The resulting failures are not cosmetic:

- a removed member can split surviving members onto attacker-selected state;
- the attacker can regain a usable shared secret with a targeted survivor;
- location and safety effects may be accepted from someone the user believes
  has been removed;
- an ordinary or removed member may end a circle they do not control;
- stale or competing reseeds can roll devices backwards or leave honest members
  permanently disagreeing about the current circle.

For a cooperative group these cases may never occur. Flock's threat model
explicitly includes relationships becoming hostile, compromised, or coercive,
so removal must remain valid when the removed person actively resists it.

The current reseed path proves that a personal-inbox message is correctly signed
and decryptable by its recipient, but the application does not prove that its
sender is authorised to change the named circle or that the new seed extends the
recipient's current epoch.

Today:

- `Circle` records a seed, local epoch, members, and removal tombstones, but no
  immutable owner or lifecycle authority;
- a received `reseed` for a known circle id can replace the held seed without an
  authority check, predecessor commitment, or monotonic wire epoch;
- removal tombstones stop the ordinary refresh path handing a seed back to a
  removed member, but they do not authenticate the state transition that carries
  those tombstones;
- incoming shared-inbox signals are decrypted and acted on before a single
  up-front current-member/ban gate;
- a disband signal binds `by` to its own authenticated signer, but does not prove
  that signer is entitled to end the circle.

The current browser tests prove the **honest path**: one member removes another,
the retained members receive the new seed, and the removed browser stays on the
old inbox. They do not prove the hostile-former-member, forged-transition,
competing-rotation, or unauthorised-disband cases.

### Non-negotiable security outcome

After `owner-a` removes `former-c`:

- every retained device must remain on the state authorised by `owner-a`;
- a reseed, catch-up, removal, authority change, or disband authored by
  `former-c` must be rejected without changing state or causing an application
  side effect;
- knowing the old seed, circle id, roster, or retained member pubkeys must not
  let `former-c` regain future access;
- replaying an older valid transition must not roll any retained device back;
- `owner-a` and `member-b` must still converge when messages are delayed,
  duplicated, reordered, or delivered after an offline period.

This is the minimum promise the implementation and hostile-path tests must prove.

## Security boundary

Flock must distinguish three properties that are currently too closely coupled:

1. **Circle identity** — the permanent identity of this particular circle and
   the authority under which its lifecycle is governed.
2. **Access** — possession of the current secret, which permits decryption and
   publication to the current shared inbox.
3. **Authority** — permission to change access, remove members, delegate the next
   rotation, or end the circle.

Possessing the access secret is membership. It must **not**, by itself, be
lifecycle authority.

## Required protocol properties

### 1. Self-certifying, immutable circle identity

New secure circles MUST record:

- `ownerPk` — the founding lifecycle authority;
- `ownerSalt` — fresh random 32-byte salt;
- `circleId` derived with a domain-separated commitment, for example:

```text
circleId = sha256("flock/circle/v1" || ownerPk || ownerSalt)
```

Every invite and transition carries the identity material needed to recompute the
id. A recipient rejects an owner/id mismatch. The access secret is separate and
may rotate without changing the circle id.

The permanent id MUST NOT appear bare on relays. It travels only inside encrypted
invites, transitions, backups, and signals where required by the inner protocol.

### 2. Explicit lifecycle authority

The default authority model is:

- the founder is the owner and initial rotator;
- sharing and ordinary circle actions remain peer-to-peer;
- only the current lifecycle authority can rotate, remove, change lifecycle
  authority, or disband;
- an owner MAY delegate rotation to a named guardian/rotator through an
  owner-signed, versioned authority state;
- owner-only is the safe default and a complete supported configuration.

An authority grant MUST be versioned, signed by the owner, bound to the circle id,
and hash-addressed. A transition made under delegation cites the exact authority
version and hash it relies upon. Recipients resolve the citation against their
current authority state rather than accepting an old, once-valid grant.

Do not build a general-purpose server-role system in this slice. Flock needs a
narrow lifecycle authority model, not arbitrary moderation or channel roles.

### 3. Authorised adjacent rotation

A normal rotation is an encrypted, per-recipient transition containing at least:

```text
version
circleId
ownerPk
previousEpoch
nextEpoch
previousCommitment
nextSeed
removedPubkeys
authorityVersion
authorityHash
rotationId
createdAt
```

The authenticated inner signer is the actor; never trust an actor copied into the
payload. `previousCommitment` is domain-separated and commits to the exact state
being replaced, for example:

```text
sha256("flock/epoch/v1" || circleId || previousEpoch || currentSeed)
```

A recipient adopts an adjacent transition only when all of these are true:

- the circle identity recomputes and matches the stored circle;
- the actor is the owner or the current valid delegated rotator;
- `previousEpoch` equals the held epoch;
- `nextEpoch` equals `previousEpoch + 1`;
- `previousCommitment` matches the held seed and epoch;
- the removal set is well-formed, cumulative, and does not silently undo an
  existing removal;
- the recipient is retained by the transition;
- the transition is not expired, malformed, replayed, or a losing concurrent
  candidate;
- every field used for the decision is covered by the actor's signature.

Continuity is not authority: a former member may know the previous seed and can
therefore compute its commitment. The authority signature and continuity check
are both mandatory.

### 4. Deterministic convergence

Two devices using the same authorised signer can race. All recipients must still
choose one result.

Define and vector-test a deterministic winner for candidates extending the same
`(circleId, previousEpoch, previousCommitment)`, using a field derived from the
signed transition rather than arrival time. A lower canonical transition hash is
the preferred shape unless implementation work proves a safer total order.

Clients must retain enough information to move from a previously seen losing
candidate to the winning candidate without treating the switch as a new epoch.
The rule must be **one-way** so a partial relay replay cannot make a settled client
oscillate between siblings.

If safe same-epoch healing cannot be specified and tested, restrict v1 to one
active lifecycle signer and fail closed on a second candidate. Do not silently
use latest-arrival-wins.

### 5. Authorised offline catch-up

Routine adjacent transitions can expire before a long-offline member returns.
Weekly refresh must therefore become an explicit, authenticated catch-up
operation rather than an unversioned copy of the current seed.

A catch-up snapshot MUST:

- be signed by the owner/current lifecycle authority;
- carry the immutable identity and current authority citation;
- carry a strictly higher epoch than the recipient holds;
- carry the current cumulative removal set;
- be encrypted to one retained recipient through the personal inbox;
- never allow a same/lower-epoch replay to replace settled state;
- have deterministic conflict handling for two snapshots at the same epoch.

Prefer a verifiable transition chain where practical. If a compact latest-state
snapshot is retained for usability, document explicitly that its owner signature
is the trust anchor for the skipped epochs.

### 6. Gate incoming actors before side effects

After unwrapping a shared-inbox event and verifying its inner signature, the
receiver MUST determine whether the actor is allowed before changing any state,
raising any notification, sounding any alarm, answering a find request, or
rendering any location.

- Current retained members may perform ordinary peer actions.
- Removed/banned pubkeys are rejected before action-specific dispatch.
- Unknown key-holders follow one explicit admission path. They must not become
  silently authorised merely because an event decrypts.
- A join announcement may propose the actor as a new member, but admission must
  follow the secure circle's invite/admission rules and surface visibly.
- Lifecycle actions additionally require the lifecycle-authority check.

Keep the existing per-action actor bindings (`payload.from/by/member === inner
signer`) as defence in depth. The new central gate does not replace them.

### 7. Authorised disband

Disband becomes an owner-authorised, terminal lifecycle transition:

- owner-signed by default;
- bound to the immutable circle identity and current epoch/commitment;
- rejected from an ordinary member, removed member, stale authority grant, or
  old epoch;
- replay-idempotent and impossible to undo;
- still carried through the ordinary opaque shared-inbox transport.

If delegated disband is ever allowed, it must be a distinct explicit permission;
rotation authority must not imply it accidentally.

### 8. Honest limits

This goal cannot make a shared secret unshareable. Any current member can copy
the secret to another person or device. Flock can make that appearance visible,
reject an unadmitted actor, and rotate the secret away; it cannot cryptographically
stop a legitimate key-holder disclosing bytes they already possess.

Rotation protects future traffic. It cannot revoke plaintext or keys already
copied, screenshots already taken, or ciphertext already decrypted.

## Privacy invariants that must survive

The implementation MUST retain all of these properties:

- sensitive relay traffic remains outer kind `1059`;
- steady-state wraps keep disposable outer authors;
- shared traffic routes through the opaque, rotating circle inbox;
- direct invites, transitions, and catch-up route through
  `personalInboxTag`, never a real member pubkey in an outer `p` tag;
- no bare roster, owner, role, transition type, circle id, or removal list;
- the uniform NIP-40 retention window remains type-indistinguishable;
- ordinary signal timestamp blur, cadence jitter, cover traffic, multi-relay,
  Tor, and BLE paths remain intact;
- exact one-to-one disclosures remain readable only by their named recipient;
- no central membership or plaintext-location service is introduced.

Do not solve authority by publishing a stable public group-state event or roster.

## Existing-circle migration

Existing circles do not record a common lifecycle owner. Inferring one silently
from local member order, lowest pubkey, inviter memory, or whichever device
upgrades first would turn inconsistent local history into security authority.
That is not acceptable.

Choose and implement one explicit path:

1. **Replacement circle (preferred for the current proof-of-concept):** create a
   secure circle, explicitly invite retained members, verify their arrival, then
   leave/disband the legacy circle. No silent owner inference.
2. **Unanimous upgrade ceremony:** every retained member explicitly accepts the
   same proposed owner and new self-certifying circle identity before traffic
   moves. Any mismatch or absent confirmation stops the upgrade.

Legacy circles must be visibly marked as using legacy membership. Do not call
their removal/disband adversarially secure. A release may make legacy circles
read-only if that is the only safe way to prevent indefinite use.

## Layer placement

Follow the established kit-first boundary:

- **`flock-kit`** owns the pure authority state, transition builders/parsers,
  commitments, validation, deterministic convergence, and golden vectors;
- **`covey-kit`** remains the generic personal-inbox transport. If an additive
  payload-carriage change is required there, keep policy and authority decisions
  out of it;
- **flock app** owns persistence, UI, explicit migration, relay publication,
  subscription, notification suppression, and applying validated transitions;
- **native** must match any membership/ingress decision it performs while the
  WebView is unavailable. Trace the actual native receive path before deciding
  that no parity work is needed.

Land provider changes through their package gates, then bump immutable SHAs in
this repository. Never edit installed dependencies or restore a local alias.

## Ordered implementation plan

### Phase 1 — pin the hostile cases first

Add failing pure/integration tests proving the current gap without depending on
UI timing:

- unrelated signer + known circle id cannot rotate a circle;
- former member cannot rotate after a legitimate removal;
- member holding the prior seed cannot forge authority by supplying a valid
  predecessor commitment;
- stale, skipped, replayed, malformed, and same-epoch losing transitions fail;
- removal tombstones cannot shrink through a later transition;
- unauthorised disband fails;
- removed/unknown actors produce no beacon, alert, buzz, ring, find response,
  notification, or roster mutation;
- a legitimate owner rotation still succeeds.

The adversarial test must exercise the real personal-inbox wrap/unwrap boundary,
not only a mocked parsed object.

### Phase 2 — pure protocol in `flock-kit`

Implement and test:

- self-certifying circle identity;
- epoch commitments;
- authority state and citations;
- adjacent rotation transition;
- cumulative removals;
- deterministic candidate selection/healing;
- catch-up snapshot or transition-chain validation;
- terminal disband validation;
- versioned wire parsers with strict bounds and fail-closed unknown values.

This is a deliberate wire-format change. Extend compatibility vectors
append-only and regenerate them only as part of this deliberate change.

### Phase 3 — app integration

- Extend `Circle` with required secure identity, authority, epoch, commitment,
  and transition state.
- Create new circles in the secure format.
- Carry the required identity/epoch material in every invite path: QR/text,
  remote personal-inbox, and spoken-code second hop.
- Replace raw reseed adoption with pure transition validation.
- Replace weekly raw-seed refresh with authorised catch-up.
- Apply the central actor gate before action dispatch.
- Make remove/reset/disband controls reflect actual authority.
- Keep ordinary members peer-equal for location sharing, chat, buzz, lost-phone,
  and radar consent.
- Give rejected transitions no observable coercion tell beyond safe local
  security diagnostics; never echo rejection onto the wire.

### Phase 4 — migration and recovery UX

- Mark legacy circles clearly.
- Implement the chosen explicit replacement/upgrade flow.
- Explain who controls lifecycle operations before confirmation.
- Make lost-owner consequences honest. Do not pretend a lost owner key is
  recoverable until a separately reviewed recovery/delegation mechanism exists.
- Preserve App Lock, decoy, encrypted backup, and remote-signer behaviour.

### Phase 5 — native and two-person proof

- Trace background/inbound/native membership decisions and implement parity
  where required.
- Run the focused browser scenarios over the real local test relay.
- If the wire reaches Kotlin, verify the extended golden vectors through the
  native JVM suite before field testing.

## Required acceptance scenarios

Use concrete actors `owner-a`, `member-b`, and `former-c` in the evidence.

1. **Legitimate three-person removal:** `owner-a` removes `former-c`; `owner-a`
   and `member-b` converge on the same next epoch and continue exchanging
   traffic; `former-c` cannot decrypt it.
2. **Hostile former member:** after removal, a transition authored by `former-c`
   is rejected by both survivors and changes no state.
3. **Known-id hostile signer:** an unrelated signer knowing the circle id and
   recipient pubkeys cannot replace a seed or create a valid catch-up.
4. **Post-removal injection:** traffic signed by `former-c` cannot create a pin,
   beacon, buzz, ring, lost flag, exact-ping response, alert, notification, join,
   or disband on a survivor.
5. **Continuity:** wrong predecessor, skipped adjacent epoch, lower epoch, replay,
   and malformed removal set all fail closed.
6. **Concurrency:** two candidates for one predecessor converge on the specified
   winner, or the unsupported second candidate visibly fails closed without
   splitting honest members.
7. **Offline retained member:** a retained device offline beyond normal wrap
   expiry catches up through the authorised path and rejoins the current inbox;
   a removed device cannot.
8. **Re-invitation:** an owner can deliberately re-admit a removed pubkey through
   a fresh invite; an old invite or old transition cannot resurrect it.
9. **Disband:** only the owner or explicitly authorised disband authority can end
   the circle; replay is harmless and an ordinary member cannot.
10. **Privacy regression:** relay-captured events contain no real member pubkey,
    roster, circle id, action type, removal list, or stable sender introduced by
    this work.
11. **Signer compatibility:** local keys and the supported Signet/NIP-07/Amber/
    NIP-46 paths can create, validate, rotate, catch up, and disband without raw
    owner-key access in the app.
12. **Legacy boundary:** an old circle cannot silently acquire an inferred owner;
    replacement/upgrade requires the documented explicit user action.

## Verification gates

Run the provider package gates first, then in this repository:

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run gen:vectors
npm run test:native
npm run test:e2e -- e2e/invite.spec.ts
npm run test:e2e -- e2e/reseed.spec.ts
npm run test:e2e -- e2e/remove-member.spec.ts
npm run test:e2e -- e2e/disband.spec.ts
```

Add a focused hostile-membership e2e spec rather than overloading only the happy
paths above, and run it directly. If any change spans two people over the wire,
the relevant Playwright spec is mandatory.

Build a release APK only after all source, pin, vector, app, e2e, and native gates
are green on a clean tree.

## Stop conditions

Stop and surface the blocker rather than weakening the goal if:

- ownership for a legacy circle cannot be established explicitly;
- a proposed transition can be accepted without both authority and continuity;
- two honest retained members can settle on different current seeds indefinitely;
- offline catch-up requires accepting an unauthorised or non-monotonic snapshot;
- a removed member can cause any action-specific side effect before rejection;
- a remote signer cannot perform the required signature/NIP-44 operations without
  exporting its private key;
- the design places real member pubkeys, roster data, circle identity, transition
  type, or removal data in relay-visible tags;
- native and TypeScript interpretations of the wire format differ;
- a dependency pin cannot be advanced without overwriting unrelated work;
- the implementation only makes the happy-path test green while leaving the
  hostile-former-member case unproved.

## Non-goals

- No general-purpose community channel/role/moderation system.
- No public group directory or public membership event.
- No central membership server or trusted relay enforcement.
- No claim that copied plaintext, old keys, or screenshots can be revoked.
- No claim that a current member can be prevented from leaking a secret they hold.
- No replacement of Flock's existing signal, location-policy, radar, Tor, BLE,
  App Lock, or decoy architecture.
- No unrelated radar, map, UI-polish, or release work in the security slice.

## Definition of complete

This goal is complete only when current code and test evidence prove all of the
following:

- every secure circle has immutable, self-certifying identity and explicit
  lifecycle authority;
- rotation, removal, catch-up, authority change, and disband are authenticated
  and continuity-checked;
- former/unknown actors are rejected before any application side effect;
- legitimate retained members converge across removal, concurrency, replay, and
  offline catch-up;
- legacy circles cross the boundary only through an explicit safe flow;
- local and remote signers work without private-key extraction;
- relay metadata remains within Flock's documented privacy model;
- compatibility vectors and native parity cover the final wire format;
- focused hostile and honest multi-person e2e tests pass;
- `FLOCK.md`, `docs/ARCHITECTURE.md`, `docs/PRIVACY.md`, `README.md`, and
  `docs/ROADMAP.md` describe the shipped boundary without claiming more than the
  evidence proves.

Until then, member removal remains an honest-client behaviour with a known
authority/continuity gap, not a completed adversarial security guarantee.
