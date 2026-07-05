# flock — the goal

## THE GOAL

**A phone in a pocket, screen off, tracks and alerts exactly as reliably as
one held in your hand, open, staring at it.** Right now it doesn't — that's
the single biggest thing standing between flock and what it's for. Everything
else in this document is context for why that's the goal and what it's in
service of; it is not a substitute for it.

Concretely, right now: fix background publish (see
[`docs/plans/2026-07-05-native-background-publish.md`](plans/2026-07-05-native-background-publish.md)) —
move the fix→beacon→publish pipeline into native code so it keeps working
when Android suspends the WebView's JS in the background. That is the
literal next thing to build. Everything below is why it matters and what it
has to be consistent with while we build it.

## One line

A safety net for the people you actually trust, that no company gets to
hold, sell, subpoena, or lose.

This document is the "why" and "what we're building toward" — the thing every
other doc, plan, and line of code should trace back to. `README.md` is the
current status; `ARCHITECTURE.md` is the stack; `FLOCK.md` is the protocol;
`PRIVACY.md` is the threat model. This is the goal all of those serve.

## The problem

Every mainstream location-sharing product (Life360, Find My, Google's
Timeline, Snap Map) makes the same trade: convenience for a permanent,
centralised record of where you and the people you love have been. That
record is a single company's to keep, to monetise, to hand to a subpoena, to
lose in a breach, or — the case that matters most — to hand to an abuser who
has your login, your court order, or your child's phone.

Two groups are underserved by that trade-off in opposite directions:

- **People who need *less* surveillance, not more.** Someone leaving or
  living with a coercive partner cannot install a location-sharing app that
  is itself evidence, that shows a detectable "I turned tracking off" tell,
  or whose provider can be compelled to hand over history. For this group,
  the safety feature *is* the ability to appear to be sharing nothing
  unusual while quietly raising an alarm, and to make the app itself
  deniable if a phone is searched.
- **People who need occasional, low-friction coordination, not a standing
  surveillance relationship.** A festival friend group wants to find each
  other in a crowd for one night and never again. A family wants to know a
  teenager left school safely without keeping a permanent map of their whole
  life. These groups are currently forced into the SAME always-on,
  everything-logged-forever product as the first group, because that's what
  the market offers.

flock's bet: **one architecture can serve both**, because the right default
for both is the same — *disclosure is a deliberate, momentary act, never a
standing state* — and the same privacy machinery that protects a domestic-
abuse survivor also happens to be exactly what a privacy-conscious friend
group or family wants, whether they'd use that language for it or not.

## Who this is for

- **A friend group on a night out or at a festival** (tonight's live test):
  set a circle up in advance, share only while it's useful, see roughly
  where everyone is, find each other in a crowd, know if someone's phone
  died or they went home early — without any of it living anywhere after
  the fact.
- **A family** wanting to know a child got somewhere safely, or an elderly
  relative is where they should be, without an always-on tracker and
  without trusting a US ad-tech company with a minor's movement history.
- **Someone in a coercive relationship** who needs a way to signal for help
  that looks identical to normal use, an app that can be searched by a
  controlling partner and reveal nothing, and a "stop sharing" that can
  double as a silent alarm if that's ever forced on them.
- **Anyone who has simply decided a for-profit company should never be the
  custodian of "where my family was, forever."**

## The design principles that aren't up for negotiation

These come straight from `FLOCK.md` §6 and `PRIVACY.md`, restated as intent
rather than spec, because every feature decision gets checked against them:

1. **Withholding must be indistinguishable from sharing.** If an observer —
   the relay, someone glancing at the phone, an abuser — can tell "sharing
   is currently off" as a distinct state from "sharing is on but nothing has
   happened yet," the withholding has already failed its purpose. This is
   the single hardest, most load-bearing constraint in the whole product,
   and it shapes UI decisions that would otherwise look unusual (e.g. why a
   coerced stop-sharing silently alarms the circle instead of just stopping).
2. **Disclosure is event-driven, never continuous by default.** Location is
   plaintext only on the holder's own device. It becomes an encrypted,
   published beacon only because something justified it — the user turned
   sharing on, a geofence was breached, someone asked and was granted
   pre-authorised consent. The default, always, is nothing leaves the phone.
3. **No company, ever, holds a plaintext location history.** Not us, not a
   relay operator, not a hosting provider. Nostr relays are dumb, replaceable
   pipes that see opaque ciphertext from rotating throwaway keys; anyone can
   run their own relay; anyone can self-host the whole thing. There is no
   "flock account" to subpoena.
4. **Reuse proven cryptography; invent as little as possible.** flock adds
   *zero* new cryptographic primitives on top of `canary-kit`/`spoken-token`
   — group lifecycle, beacon/duress encryption, NIP-44/NIP-59 transport are
   all reused, audited, and battle-tested elsewhere. The places we *have*
   built new things (the disclosure policy engine, geofencing, night-out
   presence, the word-code invite hardening) are pure, unit-tested, and kept
   as small as the job allows.
5. **Coercion-resistance is a first-class feature, not an edge case.** The
   decoy view, the App Lock, the silent-duress vocabulary, and the "a
   compelled unlock must find nothing" design all exist because a safety
   tool that can be turned into a weapon against the person it's meant to
   protect isn't a safety tool.
6. **Minimise what even a hostile relay learns.** Gift-wrap everything,
   rotate the inbox per epoch, never put a real pubkey or a stable
   identifier in a p-tag, jitter timing, cap retention to ~16 days. The
   honest framing (see `PRIVACY.md`) is that this is defence in depth on top
   of "assume the relay is hostile," never a reason to trust it — and the
   remaining leak (IP-level connection metadata) is Tor's job, addressed
   separately, not papered over with a "no-log" promise nobody can verify.
7. **Battery, relay traffic, and metadata are one concern, not three.**
   Every beacon has a cost — GPS wake, a relay publish, a data point that
   exists at all, however briefly. The cadence gate, the movement filter,
   coarse-by-default precision, and "ask before defaulting to more detail"
   (festival mode) are all the same instinct: disclose the least that
   accomplishes the goal, as infrequently as accomplishes the goal.

## What's built and validated

The library (`src/`) carries the full family-safety feature set — geofence
breach, SOS/duress, dead-man's-switch check-ins, breadcrumb trails, no-report
zones, rendezvous/meeting points, off-grid mode, spoken pick-up verification
— all pure, all tested, all ready for the app UI to grow back into as it
matures past MVP. The shipped app (`app/`) currently focuses the whole
feature set down to **live location sharing with one group of friends**, and
tonight's live field test (a real event, real phones, real friends, screen
locked and unlocked) validated a lot of it working exactly as intended:

- Circle creation, QR/word-code/remote invites, and the precision slider
  (region → exact spot) all worked correctly on real hardware.
- Circle chat, private 1:1 threads, and quick actions (Check in / Come to me
  / Where are you? / Call me / On my way) all delivered correctly over the
  live relay in both directions.
- Lost-phone flagging, ringing, and the pre-authorised remote-exact-ping
  consent flow all worked as designed.
- **Foreground behaviour is solid.** Every explicit, in-the-app action —
  toggling sharing, responding to a roll-call, sending a message — worked
  instantly and correctly, every time, all night.

## The evidence behind THE GOAL

Tonight, live, at a real event: a phone locked and carried while walking
produced one location jump instead of continuous tracking; Android's own
location indicator went dark the moment the app left the foreground; a
"your phone was reported lost" alert only appeared once the recipient
reopened the app, never as a background notification — even with every
relevant permission and battery setting confirmed correct.

The root cause is now understood precisely (see the plan doc linked above):
native GPS sampling keeps working via the foreground service — **now measured,
not assumed (see below)** — but delivering that fix into JavaScript, and
everything downstream of it (cadence gating, encryption, gift-wrap, publish),
depends on the WebView actually executing JS, which Android throttles or
suspends while backgrounded. The fix isn't a setting; it's moving that pipeline
into native code, sharing infrastructure with the existing (also not-yet-built)
plan for receiving alerts in the background
([`docs/plans/2026-06-30-background-inbound.md`](plans/2026-06-30-background-inbound.md)).

**Confirmed by measurement (2026-07-05).** A standalone native probe
(`native/gps-probe/` — a `location` foreground service on the raw
`LocationManager`, no WebView, no JS) on a **GrapheneOS Pixel 10 Pro** (API 37)
logged **46 fixes at ~10 s cadence, longest gap 10 s**, screen locked and
carried on a walk, the foreground service never killed. So the platform half is
proven: GrapheneOS *does* deliver GPS to a locked background service. The
remaining failure is entirely the WebView-JS seam — so moving the pipeline
native **will** close THE GOAL's gap, not merely might. (Still to run: a
stationary deep-Doze pass.)

## Roadmap shape

**Near-term (blocking the core promise):**
- Native background publish (the design doc above) — the single biggest
  unlock, closing the gap between "works when I'm watching" and "works when
  I'm not."
- Re-run a proper Phase 0-style measurement with split native/JS instrumentation
  once the native pipeline exists, so a future regression can tell "GPS sampling
  stopped" from "JS delivery stalled" apart. **The native-side half is already
  measured green (2026-07-05, `native/gps-probe/`)** — GPS delivery to a locked
  GrapheneOS service is confirmed; what remains is instrumenting the JS side once
  the pipeline lands.

**Also on the list, lower urgency:**
- A genuine movement trail (direction/speed at a glance) for live-sharing
  members — deliberately *not* bolted onto the existing alert-only trail
  mechanism, which exists for a narrower, more sensitive purpose; this needs
  its own small design pass on how much history to keep and for how long.
- Light/dark mode (currently dark-only).
- A second no-log relay for redundancy (currently opt-in, one relay).
- BLE-nearby mesh hardware validation on real, co-located devices (built,
  shipped, not yet measured in the field).
- Adopting `dominion` for circle membership/access control in place of the
  hand-rolled reseed-via-gift-wrap (see `FORGESWORN-TOOLKIT.md`).

**Further out:**
- `signet-login` as the default signing path (already supported, not yet the
  default) — the key leaves the app entirely.
- Re-expanding the app UI back out to the library's full safety surface
  (geofences, SOS, check-ins, rendezvous) once the MVP core is solid.
- iOS, gated on background reliability answers there being at least as good
  as Android's.

## What flock deliberately will not become

- **Not a business that monetises location data.** There is no data to sell;
  that is the point, not an oversight.
- **Not a "provable no-log" relay as the headline privacy claim.** The
  honest position is "assume the relay is hostile and architect around it,"
  because a promise nobody can verify isn't a security property.
- **Not convenience-first at the cost of the coercion-resistance invariants.**
  A feature that makes the product nicer for the average user but adds a
  detectable tell for the person under duress doesn't ship as designed.
- **Not a platform that requires an account, a phone number, an email, or
  any identity we could be compelled to hand over** — because there isn't
  one to hand over.

## How we'll know this is working

The test isn't "does the demo look good" — it's **does it hold up exactly
the way tonight's live test held it up**: real friends, a real event, phones
locked in pockets, screens off, someone actually needing to find someone
else in a crowd. When background sharing is as reliable as foreground
sharing already is, and a family could trust it for a child's phone without
a second thought, flock will be doing the thing it exists to do.
