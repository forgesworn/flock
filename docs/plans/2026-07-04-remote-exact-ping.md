# Remote exact ping ("find my phone") — design

**Status:** design + build, 2026-07-04. The last item in the lost-phone playbook
(`docs/ROADMAP.md` → "Lost phone"). Consent design is the work; the mechanism
reuses the come-to-me one-shot.

## The problem

A phone is lost (back of a taxi). Its friends can watch its last-known pin, buzz
it, ring it (Make it ring) — but if it stopped beaconing, or only ever shared a
coarse cell, they can't get an **exact** fix to go and fetch it. "Find my phone"
lets a member **ask** the lost device for a one-shot exact location.

## The tension it must resolve

Two invariants stand in the way of any remotely-triggered disclosure:

- **FLOCK §6.4 / §4:** raw coordinates leave only as a beacon **after a
  triggering event**, and geofence/disclosure decisions are made **on-device**.
- **Roadmap permanent non-goal:** *remote "start sharing"*. If sharing was off
  when the phone was lost, nothing may switch it on from outside — a remote-enable
  switch is indistinguishable from a stalking tool.

A naive "member asks → phone answers with GPS" breaks both: it is a disclosure
whose origin is *someone else's* device.

## The reconciliation: pre-authorisation makes the owner the origin

The remote party never flips a switch. They send a **request**; the phone answers
**only because the owner previously consented, on their own device**, that this
circle may ping it if it is lost. Without that standing consent a ping does
**nothing** — silently ignored, no observable difference (no tell). So the
disclosure still originates from the device's own settings; the remote ask only
*triggers* a pre-authorised, bounded disclosure. This is categorically different
from remote "start sharing":

| | Remote start-sharing (non-goal) | Remote exact ping (this) |
|---|---|---|
| Consent | none / implicit | explicit, standing, per-circle, opt-in |
| Duration | continuous | **one** beacon |
| Changes settings? | turns sharing on | never — slider/cadence/toggle untouched |
| Refuge safety | — | no-report zones still cap it |
| Visibility to owner | silent | requires a **visible "lost" alarm** first + a cancel banner |

## The gate stack (ALL must hold for the phone to answer)

Chosen model: **pre-auth + flagged-lost** (the strict option — the safest, and it
fits the lost-phone playbook exactly). Recorded 2026-07-04; the owner-tradeoff
question was put to Darren and defaulted to the recommended (strict) option.

1. **Pre-auth** — per-circle, **off by default**, device-local (`Circle.pingConsent`,
   never synced — the invite/reseed wire builders pick explicit fields, so it never
   leaves the phone). "If I lose my phone, let *this circle* ping it for an exact
   location."
2. **Flagged lost** — the phone must currently be flagged `lost` (same gate as Make
   it ring). This is the anti-stalk keystone: a covert track must **first raise a
   visible "reported lost" alarm on the target's own phone** (the finder card +
   roster pill). There is no silent path to a fix.
3. **Cancel window** — on a qualifying ping the phone shows a loud banner with a
   ~10 s countdown ("📍 <name> is asking this phone for its exact location —
   Cancel"). An owner holding the phone vetoes it. A genuinely lost phone has
   nobody to cancel, so it answers when the window elapses.
4. **One-shot only** — a single `beacon` at precision 9; **never** enables continuous
   sharing, **never** touches the slider or cadence, and runs through
   `decideEmission({trigger:'pickup'})` so **no-report zones still cap it** (a
   refuge is never pinned). Reuses the come-to-me answer path verbatim.
5. **Rate-limited** — at most one answer per circle per 60 s (anti-spam / battery;
   still ample for watching a taxi's pin move minute by minute).

If any gate fails the phone stays **silent** — the asker cannot distinguish
"pre-auth off" from "phone off / no fix / cancelled", so there is no tell.

## Wire protocol

- **The ask** — a new signal `t = "findreq"` (`src/findping.ts`), group-envelope
  encrypted (`deriveGroupKey`), targeted at one member. A **new type** (not an
  overloaded `buzz`) deliberately: a plain targeted buzz already *rings* a lost
  phone (Make it ring), and consent semantics deserve to be explicit and
  separable. Payload `FindPing {from, target, timestamp}`.
- **The answer** — a plain `beacon` at precision 9. **No new answer type** — it is
  indistinguishable on the wire from any other beacon (FLOCK §6.1), and lands on
  every device's map through the existing presence machinery.

## Coercion / decoy safety

- **No tell:** the answer beacon is an ordinary beacon; the ask is an opaque
  `kind:1059` like every signal. Pre-auth is device-local, so enabling it emits
  nothing.
- **Decoy:** a hidden app holds no circles and no subscription, so it never
  receives a ping and can never answer.
- **Coercion:** pre-auth is off by default and gated behind a visible lost alarm
  + a cancel window; it is not a silent backdoor. A coercer can already force any
  sharing; this adds no weaker path.

## Implementation map

- `src/findping.ts` (lib) — `FIND_PING_SIGNAL_TYPE`, `FindPing`,
  `buildFindPingSignal`, `decryptFindPing`; exported from `src/index.ts`. Unit
  tests: round-trip, validation, target required.
- `app/src/findping.ts` (app, pure) — `shouldAnswerFindPing({preAuthorised,
  iAmFlaggedLost, targetedAtMe})`, `withinPingRateLimit(lastAt, now, gap)`, and the
  `FIND_PING_CANCEL_SECONDS` / `FIND_PING_MIN_GAP_SECONDS` constants. Unit tests:
  every gate combination + the safety invariants (never answer without pre-auth,
  without the lost flag, or when not targeted) + the rate-limit.
- `app/src/store.ts` — `Circle.pingConsent?: boolean` (device-local).
- `app/src/app.ts`:
  - Refactor the come-to-me answer half into `sendExactBeacon(c)` (currentPosition
    → `decideEmission` pickup → beacon@9 → publish → saveBeacon), reused by both.
  - Pre-auth toggle on the Circle screen (off by default, plain-words copy).
  - Finder button "📍 Find (exact)" on a flagged-lost member's row (beside Ring /
    Found it) → `buildFindPingSignal`.
  - Receiver: `t === FIND_PING_SIGNAL_TYPE` → gate → cancel-window banner →
    (uncancelled) `sendExactBeacon` + stamp the rate-limit clock; Cancel clears it.
- `e2e/find-my-phone.spec.ts` — A pre-authorises, B flags A lost, B asks, A shows
  the cancel banner, the window elapses, A's exact pin lands on B — over the live
  relay.
- Docs: FLOCK.md (findreq row + a §6 item), roadmap check-off.
