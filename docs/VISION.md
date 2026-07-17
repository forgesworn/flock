# flock — the goal

## THE GOAL

**Trusted adults can find and help each other when it matters, without creating
a provider-readable movement history or a permanent remote-tracking
relationship.** A phone in a pocket, screen off, must be as useful as one held
open — and every disclosure must remain explicit, minimal, and defensible under
the coercion threat model.

Android outbound background publishing now meets that core requirement: the
Kotlin pipeline is shipped and hardware-measured while locked, walking, and in
stationary deep Doze on GrapheneOS. That does not mean “all native work is
done”. Locked-phone radar, the live Orbot route, inbound battery/device breadth,
and any future iOS native path retain their own evidence gates in the roadmap.

## One line

A safety net for the people you actually trust, that no company gets to
hold, sell, subpoena, or lose.

This document is the "why" and "what we're building toward" — the thing every
other doc, plan, and line of code should trace back to. `README.md` is the
current status; `ARCHITECTURE.md` is the stack; `FLOCK.md` is the protocol;
`PRIVACY.md` is the threat model. This is the goal all of those serve.

## The problem

Many location-sharing products make convenience depend on an account, a
central relationship graph, provider-readable location, or retained movement
history. Those are different risks and not every product makes every trade:
some mainstream systems now protect live location end-to-end or limit its
retention. Flock's narrower claim is architectural and testable: its service
and relays do not receive plaintext circle location, there is no Flock account,
and precision/lifetime are controlled at the sending device.

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
  other in a crowd for one night and never again. The product should make that
  temporary purpose easier than creating an always-on tracking relationship.

flock's bet: **one architecture can serve both**, because the right default
for both is the same — *disclosure is a deliberate, momentary act, never a
standing state* — and the same privacy machinery that protects a domestic-
abuse survivor also happens to be exactly what a privacy-conscious friend
group wants, whether they'd use that language for it or not.

## Who this is for

- **A friend group on a night out or at a festival** (tonight's live test):
  set a circle up in advance, share only while it's useful, see roughly
  where everyone is, find each other in a crowd, know if someone's phone
  died or they went home early — without any of it living anywhere after
  the fact.
- **Trusted adults supporting one another** — including an elderly relative who
  chooses to join — without an always-on tracker. The current hosted preview is
  18+ and must not be used to track children; see `docs/LEGAL.md`.
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
4. **Reuse established cryptography; invent as little as possible.** flock adds
   *zero* new cryptographic primitives on top of `canary-kit`/`spoken-token`
   — group lifecycle, beacon/duress encryption, NIP-44/NIP-59 transport are
   reused rather than reimplemented. That is a smaller review surface, not a
   substitute for named audit evidence (`SECURITY.md`). The places we *have*
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
feature set down to **private coordination across trusted adult circles**:

- multiple circles with ongoing/today/custom lifetimes;
- QR, link, six-word, and remote-signer invitations;
- explicit default-off live sharing with region-to-exact precision;
- group chat, private threads, roll-call and direct quick actions;
- temporary exact festival mode, lost/ring/find, and foreground radar;
- backup/reseed/remove/disband, offline maps, Tor/onion routing, App Lock, and
  a decoy view;
- native Android background publish plus opt-in app-closed reachability.

The July field passes covered real phones, real relays, screen-off walking,
stationary deep Doze, circle messaging, invitations, lost/find flows, and the
native outbound round trip. Tests distinguish unit, e2e, JVM parity, and
hardware evidence; the roadmap names the remaining field-only checks instead
of treating “built” as “proven everywhere”.

## The evidence behind THE GOAL

The first live event test exposed the actual failure: Android could keep a
foreground location service alive, but the WebView stopped running the
JavaScript policy/encryption/publish pipeline reliably after lock. The fix was
architectural, not a battery-setting instruction: move the complete outbound
pipeline into native code.

That work is now shipped. The standalone probe first measured locked GPS fixes
on a GrapheneOS Pixel 10 Pro. The production Kotlin publisher then passed
locked walking and stationary deep-Doze round trips through the real relay and
decrypt path. Shared golden vectors and CI protect the JavaScript/Kotlin wire
boundary. This closes the original outbound gap while leaving inbound battery
breadth, locked radar, the live Orbot route, and iOS as separate claims.

## Roadmap shape

**Near-term evidence and reliability:**
- Complete the real-hardware locked-phone radar pass.
- Complete the live GrapheneOS/Orbot onion-route beacon pass.
- Measure Stay reachable battery/reconnect behaviour across the target Android
  and GrapheneOS device matrix.
- Keep the native Kotlin→JavaScript reverse-vector gate and 80% coverage gate
  enforced in CI.

**Also on the list, lower urgency:**
- A genuine movement trail (direction/speed at a glance) for live-sharing
  members — deliberately *not* bolted onto the existing alert-only trail
  mechanism, which exists for a narrower, more sensitive purpose; this needs
  its own small design pass on how much history to keep and for how long.
- Light/dark mode (currently dark-only).
- Broader BLE-nearby device coverage beyond the completed two-device hardware
  pass.
- Adopting `dominion` for circle membership/access control in place of the
  hand-rolled reseed-via-gift-wrap (see `FORGESWORN-TOOLKIT.md`).

**Further out:**
- `signet-login` as the default signing path (already supported, not yet the
  default) — the key leaves the app entirely.
- Re-expanding the app UI back out to the library's full safety surface
  (geofences, SOS, check-ins, rendezvous) once the MVP core is solid.
- A native iOS path only if its background reliability and privacy model can be
  evidenced as clearly as Android's.

## What flock deliberately will not become

- **Not a business that monetises location data.** Flock does not receive
  plaintext circle location and will not sell the connection metadata its
  infrastructure inevitably processes.
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

The test isn't “does the demo look good”. It is: real trusted adults, a real
event, phones locked in pockets, screens off, poor connectivity, and someone
actually needing to regroup. Flock is doing the thing it exists to do when the
same privacy and reliability claims survive that setting across the supported
device matrix — and when every remaining limitation is visible before anyone
relies on it.
