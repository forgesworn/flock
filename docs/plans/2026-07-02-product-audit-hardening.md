# Product audit hardening — plan

**Date:** 2026-07-02 · **Status:** Proposed · **Tracked in:** `docs/ROADMAP.md` Phase I

A full product audit (docs + protocol spec + every app/library module, findings
verified against the code) concluded: **the wire protocol is world-class; the
failure modes around the human are where the gaps are.** Gift-wrap-everything has
no bypass path, key domain separation holds at the crypto layer, and the spoken
pick-up duress check is the standout feature. The gaps are incremental — fences
that silently don't sync, keys that can't be recovered, coercion points without
duress cover, error toasts where a family member needed guidance.

This plan turns every finding into an independently shippable slice, ordered so
small security-critical fixes land first and the biggest feature (fence sync)
starts as soon as they're in. Repo rules apply to every slice: **failing test
first**, library stays pure, **no feature is done without a two-person e2e**,
tick the ROADMAP checkbox on ship.

---

## Slice 1 — No-report zones fail-safe under GPS noise 🔴 security-critical

**Finding.** Family breach detection is accuracy-aware (`classifyContainment`
requires *confidently outside* before firing — `src/geofence.ts:186`), but the
no-report cap uses crisp `isInside` on the raw fix (`src/noreport.ts:36,47`,
applied in `src/policy.ts` `applyNoReportCap`). A noisy fix near the edge of a
private place during a genuine SOS can classify as *outside* the zone and pin
the exact address — the opposite of the feature's purpose.

**Change (pure lib).**
- `src/noreport.ts`: `inNoReportZone` / `noReportPolicyAt` take the fix's
  `accuracyMetres` and use `classifyContainment`, treating **`uncertain` as
  inside** (cap applies). Only a confident `outside` escapes the cap — the exact
  mirror of breach logic, flipped to the fail-safe direction for redaction.
- `src/policy.ts`: thread `ctx.accuracyMetres` into the cap (breach path already
  has it). Default accuracy 0 keeps existing behaviour, so the 216-permutation
  truth-table (`src/policy.matrix.test.ts`) is unchanged; add an accuracy
  dimension sweep for the no-report cases (mirroring `policy.accuracy.test.ts`).

**Tests.** Unit: uncertain-near-zone-edge ⇒ capped, for every trigger incl.
`help`; confident-outside ⇒ uncapped. E2e: an imprecise fix near a private place
during an SOS still fires the alert but **withholds/coarsens** the address
(extend the existing no-report-cap spec with a low-accuracy fix).

**Size:** small. **Files:** `src/noreport.ts`, `src/policy.ts`, tests.

---

## Slice 2 — Confirm destructive actions 🔴 data-loss trap, trivial fix

**Finding.** "Sign out & reset this device" executes instantly
(`app/src/app.ts:1994` → `resetDevice()`, button at `app.ts:733`); "Remove
member" likewise (`app.ts:1951`). Disband already has the right idiom — an
inline two-step confirm (`disbandConfirm`, `app.ts:724-730`).

**Change (app).** Apply the disband two-step inline confirm pattern to both
actions. Reset copy must say plainly what is lost: *"This wipes your key and
every circle from this device. Without a backup there is no way back."* (The
backup link arrives with Slice 4.)

**Tests.** E2e: first tap arms, second tap executes, tapping elsewhere disarms —
for both actions; remove-member keeps the existing 3-party reseed spec green.

**Size:** tiny. **Files:** `app/src/app.ts`.

---

## Slice 3 — Safe places sync across the circle 🔴 flagship gap

**Finding.** `persisted.geofences` is **device-global and local-only**
(`app/src/store.ts:36`); no signal type ever transmits a fence set, and breach
evaluation reads only the local device's zones (`app.ts:2189,2233,2310`). A
guardian drawing "school = safe place" changes **nothing on the child's phone**,
and no UI copy says so. `FLOCK.md` §3.2 describes group-encrypted fence sharing
— unimplemented, and specified pre-gift-wrap (kind 30078 + stable d-tag would
now be a metadata leak).

**Design decisions (recommended).**
- **Safe places sync; private places never do.** No-report zones are on-device
  by design (`PRIVACY.md`) — your home never leaves your device, even encrypted.
  The map panel must state both behaviours explicitly.
- **Transport follows the shipped architecture, not the stale spec:** a new
  gift-wrapped signal `t: 'fences'` carrying the **full replacement set**
  `{ fences: Geofence[], updatedAt, setBy }`, group-envelope keyed like
  rzv/mtg — idempotent full-state, **latest-wins by `updatedAt`** (no CRDT;
  two guardians editing at once resolve to the later save; role-gated editing
  waits for dominion, Phase B). Update `FLOCK.md` §3.2 to match.
- **Fences become per-circle** (`circle.geofences`), family-mode only.
  **Migration is behaviour-preserving:** device-global fences already applied to
  *every* family circle, so copy them into each existing family circle.
  Private places stay device-global (unchanged).
- **Republish triggers:** on every local edit; on detecting a new member
  (so late joiners converge); after reseed (new epoch key).

**Sub-slices** (each committed + deployed):
- **3a — data model:** per-circle fences + migration + evaluation reads the
  active circle's set. No transport yet; all existing tests stay green.
- **3b — sync signal:** lib builder/parser (`src/` — new `fences` type in
  `signals.ts` or a sibling module), latest-wins merge in the app, republish
  triggers. Unit tests: build/parse round-trip, latest-wins both orders,
  reject malformed.
- **3c — UI truth:** "Safe places are shared with the circle · Private places
  never leave this device" copy; a synced/updated-by indication; FLOCK.md §3.2
  rewrite.

**E2e (the money test).** Guardian A draws a safe place → it renders on child
B's map; B leaves it → A gets the breach alert **without B ever having
configured anything**. Plus: a new member joining receives the current set.

**Size:** large (the biggest slice). **Files:** `src/signals.ts` (or new module),
`app/src/store.ts`, `app/src/app.ts`, `FLOCK.md`, e2e.

---

## Slice 4 — Circle-root backup & restore 🟠 the worst user story, stopgap now

**Finding.** No backup/export exists for `circleRootHex` — the single secret
from which every circle seed derives (`app/src/keys.ts:20`, whose own comment
calls it "the single thing to back up"). Device loss or a reset (Slice 2)
permanently destroys every circle. Social recovery (`shamir-words`/`cairn-kit`,
Phase E) is the real fix; this is the stopgap so nobody loses a family circle
in the meantime.

**Design (recommended).**
- **Export payload:** `{ v, circleRootHex, identity, circles: [{ id, name,
  mode, epoch, expiresAt? }] }` — the root alone can't re-derive seeds without
  each circle's `(id, epoch)`, and keeping the identity key preserves how the
  roster/petnames know you.
- **Format:** passphrase-encrypted blob — WebCrypto PBKDF2 (native, no new
  dependency) → canary-kit's AES-256-GCM envelope (**no new crypto
  primitives**, per the architecture rule). Offered as a copyable string, a
  downloadable file, and a QR. Import = a "Restore from backup" path on
  onboarding.
- Settings gains a **Back up this device** card; the Slice 2 reset confirm
  links to it. When `stash`/`shamir-words` land (Phase E), this becomes their UI.

**Tests.** Unit: round-trip, wrong-passphrase rejection, forward-compat version
field. E2e: A backs up → resets the device → restores → still decrypts a signal
from B in the old circle (same identity on B's roster).

**Size:** medium. **Files:** new `app/src/backup.ts`, `app/src/app.ts`,
`app/src/store.ts`, e2e.

---

## Slice 5 — Duress cover for "stop sharing" / "I'm OK" / "take a break" 🟠 spec MUST

**Finding.** `FLOCK.md` §6.1: a coerced "stop sharing" SHOULD emit a silent
alarm. In code, `stopSharing()` (`app.ts:2151`), `disarmCheckin()`
(`app.ts:1409`) and `goDark()` (`app.ts:1488`) — the three most plausible
coercion points — just do what they say. The hard machinery already exists in
spoken-verify: the duress-key path, and tell-safe suppression.

**Design (recommended).**
- **A silent long-press variant** on all three actions (the same invisible
  affordance as the spoken-verify duress reveal): performs the **identical
  visible action** — sharing stops, check-in disarms, break starts — *and*
  emits a silent `help` via the duress key.
- **Tell-safety rule:** a `help` alert whose subject is *you* never surfaces on
  *your own* device (a coercer may be holding it) — only other members light up.
  Verify the inbound guard enforces this for the relay echo of your own alert.
- **Network shape:** all wraps are uniform `kind:1059`, so the one extra wrap a
  duress-stop emits is indistinguishable from a buzz or check-in. Note it in
  PRIVACY.md regardless.
- **Education:** one discreet onboarding note covering both silent long-presses
  (this + the spoken-verify reveal — already a tracked follow-up).

**Tests.** Unit for any lib addition. E2e (3-person, mirroring the
spoken-verify duress spec): coerced stop on A → A's screen shows a completely
normal stop, B (guardian) gets the silent alarm, nothing surfaces on A.

**Size:** medium; the design care is the work. **Files:** `app/src/app.ts`,
possibly `src/signals.ts`, `FLOCK.md` (§6.1 → implemented), e2e.

---

## Slice 6 — Uniform expiry on every gift wrap 🟠 retention bound, an afternoon

**Finding.** Wraps carry no NIP-40 `expiration` (`app/src/giftwrap.ts:31-48`);
kind 1059 is a regular stored kind, so a logging relay retains every
beacon/SOS/check-in ciphertext **forever**. A future compromise of one device's
`circleRootHex` (plaintext localStorage until keystore-kit) retroactively
decrypts a family's entire history. Epoch rotation bounds it forwards; nothing
bounds it backwards. Not currently listed in PRIVACY.md's residual table.

**Change.**
- `giftWrap()` adds `['expiration', String(created_at + WINDOW)]` with **one
  uniform window for every wrap type** (differing windows would be a type-tell).
  Derive from the (already backdated) `created_at`, not real time — so the tag
  carries **zero new information** and retention is still bounded.
- **Window: 16 days** — comfortably past the 2-day `created_at` randomisation
  and the "reseed must reach a member offline for days" requirement
  (`keys.ts` `personalInboxTag` rationale).
- Verify `relay.trotters.cc` honours NIP-40 (the night-out groups already rely
  on it); add the retention row to PRIVACY.md's table.

**Tests.** Unit: every wrap type carries the same window; smoke: wrapped signal
still accepted + round-trips on the live relay. Full e2e suite green.

**Size:** small. **Files:** `app/src/giftwrap.ts`, `docs/PRIVACY.md`, tests.

---

## Slice 7 — "Joined the circle" notice 🟡 cheap tell for a leaked invite

**Finding.** Seed possession = membership: `ensureMember()` silently adds any
sender whose signal decrypts (`app.ts:2565` → `1268`). Inherent to the
shared-seed design — but silence means a photographed QR or cloud-synced
clipboard grants an **invisible** member.

**Change (app, on-device only — no new traffic).** When `ensureMember` adds a
previously unseen pubkey, surface a banner ("〰️ A new phone joined <circle>")
and a members-list highlight until viewed. Pair with **remove member** (already
one tap + Slice 2's confirm) as the remedy, and a hint to reseed if unexpected.

**Tests.** Unit: notice fires only on genuinely-new members (not reseed
re-adds). E2e: C joins via invite → A and B both see the notice.

**Size:** small. **Files:** `app/src/app.ts`, `app/src/store.ts`.

---

## Slice 8 — Permission-denied guidance + invite-wait feedback 🟡 "just works" polish

**Findings.**
- Denying geolocation surfaces the raw browser error as a ~2.8 s toast and
  silently flips sharing back off (`services.ts:143`, `app.ts:2134`) — a
  non-technical dead end: the toggle un-taps itself, nothing explains why.
- "Join remotely" spins on "⟳ Waiting for a secure invite…" forever
  (`app.ts:899-910`) with no timeout messaging or retry guidance.

**Change (app).**
- Map `GeolocationPositionError.code` to a **persistent, actionable card** (not
  a toast): permission-denied ⇒ per-platform "how to re-enable location for
  your browser" steps; position-unavailable/timeout ⇒ "couldn't get a fix,
  retrying". The card explains why sharing reverted and offers retry.
- Invite wait: after ~60 s show "still waiting — check the inviter has your
  code; it can take a minute on a slow connection", keep listening, and make
  cancel-and-retry explicit.

**Tests.** E2e: Playwright denies geolocation → the card renders with guidance
and sharing reverts *visibly explained*; invite-wait timeout copy appears
(clock control).

**Size:** small–medium. **Files:** `app/src/services.ts`, `app/src/app.ts`.

---

## Slice 9 — Invite hygiene: share-sheet over clipboard 🟡

**Finding.** `copyInvite()` puts the raw seed on the OS clipboard
(`app.ts:2339`) — phone clipboards sync to cloud services (Google/Samsung/
Microsoft), an exfiltration path the "treat it like a password" note doesn't
cover.

**Change (app).** Prefer QR (already primary in person) and `navigator.share`
(the share-sheet hands the code straight to the chosen app without parking it
on the clipboard). Keep copy as the fallback with a sharper warning ("your
clipboard may sync to the cloud — prefer the QR"). Note: remote gift-wrap
invites already avoid this entirely; keep steering users there.

**Tests.** E2e: share path invoked where supported; fallback copy + warning
renders otherwise.

**Size:** tiny. **Files:** `app/src/app.ts`.

---

## Slice 10 — Cloudflare in the threat model + private map path by default 🟡 infra/docs

**Findings.**
- The host sits **behind Cloudflare** (orange-clouded). CF terminates TLS and
  therefore sees what the same-origin proxies were built to hide from OSM:
  user IP + tile viewports, Nominatim place-name queries, Overpass bboxes, and
  `/api/extract` bodies (≈ where home is). PRIVACY.md's threat table covers the
  relay but not this hop — the Stage-0 win partly *moved* the leak.
- The zero-network vector basemap is proven but flag-gated
  (`VITE_PMTILES`/`VITE_OFFLINE_MAP`), so out of the box every pan hits
  `/tiles/*`.

**Change.**
1. **Decide the CF hop:** grey-cloud (DNS-only) `flock.forgesworn.dev` so TLS
   terminates at Caddy only — the recommended end-state (weigh the loss of CF's
   DDoS shielding + the tile-cache TTL we currently lean on) — **or** keep CF
   and add it to PRIVACY.md's threat table honestly.
2. **Make the private map path the default:** offline/vector basemap on by
   default in the canonical deploy; raster `/tiles` becomes the fallback for
   unsaved areas. (Already proven end-to-end on prod — this is a flag flip +
   copy.)
3. Document `/api/extract` as a sensitive endpoint (bbox ≈ home) in PRIVACY.md
   — mitigations: no app-level logging (done), Caddy access logs off (done),
   the per-IP rate-limit follow-up, and the CF decision above.

**Size:** small code, one infra decision. **Files:** `docs/PRIVACY.md`, deploy
config, `app/src/map.ts` defaults.

---

## Discovered during implementation

- **Typing is wiped by any inbound re-render** (found while shipping Slice 2). The
  render-on-state controller rebuilds the DOM whenever a signal arrives, so text a
  user is mid-typing (a buzz reason, a petname, the relay list…) is silently lost —
  and a buzz submitted right after the wipe no-ops with "Pick or type a reason".
  This made `remove-member.spec.ts` fail deterministically (C's buzz never
  published → A's roster never learnt C). Workaround shipped: the `sendBuzz` e2e
  fixture fills + clicks atomically in one in-page task. Real fix (own slice, 🟡):
  input-preserving renders — skip the re-render while a form control is focused, or
  preserve focused-input value/selection across renders. Tracked in ROADMAP Phase I.

## Explicitly deferred (tracked elsewhere, not re-planned here)

- **Second no-log relay** + **`.onion` endpoint** — the highest-leverage fix for
  the IP residual; `docs/plans/2026-07-01-second-no-log-relay.md`.
- **Timing hygiene / cover traffic** — the silence-vs-breach-burst shape tell is
  real but in direct tension with the minimal-footprint north star; sequence
  **after** Tor (which blunts the observer it worries about). PRIVACY.md §8.
- **keystore-kit / key-at-rest** — the localStorage-root exposure that makes
  Slice 6 matter; Phase E / Phase G as tracked.
- **shamir-words social recovery** — replaces Slice 4's stopgap; Phase E.
- **dominion roles** — guardian-only fence editing etc.; Phase B.

## Suggested batches

| Batch | Slices | Theme |
|---|---|---|
| 1 | 1, 2 | Small security-critical + the trap, both quick |
| 2 | 3 (a→c) | The flagship gap — fence sync |
| 3 | 4, 5 | Recovery + duress cover (the human failure modes) |
| 4 | 6, 7 | Wire hardening (retention, join notice) |
| 5 | 8, 9, 10 | Polish + infra/docs honesty |
