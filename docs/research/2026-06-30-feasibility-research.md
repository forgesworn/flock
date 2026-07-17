# flock — Feasibility & Design Research

**Date:** 2026-06-30
**Method:** Deep-research harness — 6 search angles, 25 sources fetched, 118 claims
extracted, 25 adversarially verified (3-vote, need 2/3 to refute). 24 confirmed, 1
refuted, 0 unverified.
**Scope:** technical feasibility, privacy/threat model, and protocol/data model
on top of `canary-kit` / `spoken-token`.

> **Historical research snapshot.** Its PWA platform constraint still holds,
> but its “GrapheneOS unproven” status was superseded: the shipped Kotlin
> publisher passed locked walking and stationary deep-Doze hardware tests.
> Flock chose a persistent Stay reachable relay service for opt-in app-closed
> inbound alerts; UnifiedPush remains research, not an implemented feature.
> See `../ROADMAP.md` and `../ARCHITECTURE.md` for current state.

---

## 0. Bottom line

A privacy-preserving family / night-out safety app built on `canary-kit`'s primitives is
**feasible**, but with one hard constraint that dictates the whole architecture: **no
web/PWA platform can deliver reliable background geofencing in 2026.** A PWA covers the
foreground; the native Capacitor wrapper is *mandatory* for background breach detection.
The privacy and coercion design is well-grounded in peer-reviewed literature, and the
Nostr protocol mapping onto `canary-kit` is almost 1:1.

---

## 1. Technical feasibility (most important)

### 1.1 The web/PWA platform cannot do background geofencing — *high confidence, 3-0*

- The **W3C Geofencing API is dead**: the repository was *"archived by the owner on Jan
  25, 2019… now read-only"*; W3C records say the work was *"discontinued, partly out of
  struggles to find a good approach to permission needs… and because the API depended on
  Service Workers."* No resumption through June 2026.
- The only PWA background-trigger primitive, **Periodic Background Sync**, *"is not
  available in the context of a regular tab"* and works only *"after a person has
  installed it… and has launched it as a distinct application."* Its cadence is **not
  under app control**: *"The timing of synchronizations are not controlled by developers…
  will align with how often the app is used"*; `minInterval` is a lower-bound hint only,
  Chrome won't fire below a site-engagement threshold, and the API is **Chromium-only**
  (absent on iOS Safari and Firefox).
- On **iOS**, Background Sync, Periodic Background Sync **and** Background Fetch **all do
  not work**. An installed iOS PWA (16.4+) can show Web Push notifications but **cannot
  obtain location while backgrounded or closed**.

**Net:** a PWA can do foreground `watchPosition` while open. Breach detection while the
phone is pocketed/locked needs native.

### 1.2 The Capacitor native fallback — *high confidence, 3-0*

Two viable plugins with opposite trade-offs:

- **`transistorsoft/capacitor-background-geolocation`** — *"background location-tracking &
  geofencing SDK with battery-conscious motion-detection intelligence for iOS and
  Android."* Uses accelerometer/gyroscope/magnetometer to turn location services off when
  stationary and only record at a `distanceFilter` when moving (directly addresses
  battery). Delivers native region monitoring a PWA cannot. **Android release builds
  require a paid licence** (debug free). iOS region monitoring caps at **20 geofences**
  (CLLocationManager).
- **`capacitor-community/background-geolocation`** (free) — *"lets you receive geolocation
  updates even while the app is backgrounded"* via an `addWatcher()` callback, using
  standard Android `LocationManager` (**not** Google Play Services / `FusedLocationProvider`)
  — i.e. **Google-free**. But it *"does NOT support geofencing, region monitoring, or
  enter/exit region events"*, so the app must perform geofence evaluation (point-in-polygon
  for polygons, distance check for circular zones) **locally on-device** — which matches
  the decentralised "each device evaluates its own fence" decision.

> **⚠️ Refuted claim (0-3):** that the community plugin's *"foreground-service-with-
> notification is THE mechanism that works on GrapheneOS where Google APIs are absent"*
> was **refuted**. The precise GrapheneOS background-delivery mechanism is therefore
> **unverified and must be prototyped early.**

### 1.3 Push on de-Googled phones — *high confidence, 3-0*

- **FCM is unavailable** on GrapheneOS / de-Googled OSes: *"FCM cannot be included in
  F-Droid apps and relies on having Google services"*; without GAPPS, *"Google Play
  Services will be absent and along with that… FCM and push notifications."* The microG
  workaround still relays via Google servers.
- **UnifiedPush** is the open standard: *"allows you to get push notifications without
  being tied to a single company"*, using a device-side **distributor** app that
  *"maintains a single server connection to receive all notifications"* and fans out.
  Confirmed still active (F-Droid "5 years of UnifiedPush", Jan 2026).
- **Caveat:** UnifiedPush needs explicit app-author support; and the canonical Nostr push
  proposal still routes triggers through Apple/Google push services, so it is **not**
  FCM-free by itself. The persistent **Nostr relay WebSocket** (held open by a foreground
  service) can itself deliver alerts, reducing dependence on any push intermediary.

### 1.4 Battery

Continuous background GPS is expensive. transistorsoft mitigates via motion-detection
(GPS off when stationary). A free-plugin approach must implement its own duty-cycling.

---

## 2. Privacy & threat model

### 2.1 Withholding location must not be a detectable "tell" — *high confidence, 3-0*

Levy & Schneier, *Privacy threats in intimate relationships* (J. Cybersecurity 6(1),
2020): the dominant threat is a **physically co-present coercer**, not a remote attacker.
*"Intimate attackers can coerce or threaten their victims to keep their smartphones
unlocked, divulge the passwords… or enable location tracking."* Critically:

- *"Removing an attacker's access to data, without plausible deniability, may be the worst
  thing one can do"* — iOS notifying *"Alice has stopped sharing location with you"* is a
  **tell**.
- *"Even when disclosive settings can be manually overridden by the user, overriding a
  default can itself create suspicion that the user has something to hide"* — which can
  escalate danger.

**Design implications:** (a) the withheld-until-event default must be **observationally
identical** to active sharing; (b) a coerced "stop sharing" should emit a **silent alarm**,
never a visible status change.

### 2.2 Duress credentials — *high confidence, 3-0*

Clark & Hengartner, *Panic Passwords* (HotSec 2008): the naive "regular + panic password"
model *"is susceptible to iteration and forced-randomization attacks, and is secure only
within a very narrow threat model."* Against a persistent coercer, any finite panic set
fails because he *"could eventually exhaust Alice's memory of panic passwords"*, so a sound
scheme must *"equip Alice with an arbitrarily large number of panic passwords"* (a
**generative** rule, not a memorised list). Indistinguishability is mandatory: *"A proper
panic password scheme should cause Alice's use of a panic password to be indistinguishable
by Oscar from use of her valid password."* (Nissen & Kulyk, CSCW 2025, confirm the modern
"duress password" framing.)

**Maps onto** `canary-kit`'s duress tokens (`deriveDuressToken`) and duress-alert
broadcasting — reuse directly for "I need help".

### 2.3 Rough sharing has a formal basis — *high confidence, 3-0*

Andrés et al., *Geo-Indistinguishability* (ACM CCS 2013): *"a formal notion of privacy for
location-based systems that protects the user's exact location, while allowing approximate
information… to be released… protection within a radius r with a level of privacy that
depends on r"*, a *"generalized version of differential privacy"*. The planar-Laplace
mechanism is the rigorous footing for night-out coarse sharing and low-precision geohash
beacons.

### 2.4 Two distinct threat models

- **Family (asymmetric):** guardian↔child, oversight, child-safety/legal duty.
- **Night-out (symmetric):** peers, consent, ephemerality.

These warrant different defaults — treat as two modes, not one.

---

## 3. Market comparison

Detailed competitor research is intentionally maintained outside this
repository. Product requirements below stand on Flock's threat model and user
needs rather than public comparative claims.

---

## 4. Protocol & data model — maps ~1:1 onto canary-kit

(Confirmed against the live `canary-kit` source, not just docs.)

| Need | Reuse from canary-kit | New work |
|---|---|---|
| Group lifecycle (guardians+kids / night-out) | `createGroup`, `addMember`, `removeMember`, `reseed`; kind **30078** group-state | role tags (guardian=admin vs child) |
| Ephemeral night-out group | kind 30078 + **NIP-40 `expiration`** (already in `buildGroupStateEvent`) | auto-dissolve on expiry |
| Geofence definitions (shared, encrypted) | `buildStoredSignalEvent` (kind 30078, replaceable) + AES-256-GCM | `geofence` signal type; on-device point-in-polygon / haversine |
| Withheld location beacon | `BeaconPayload {geohash, precision, timestamp}`, `deriveBeaconKey`, `encryptBeacon` | **emission policy** (nothing normally / coarse on timer / full on trigger) |
| "Breach" + "pick me up" | `buildSignalEvent` (kind **20078** ephemeral, `t`=type) | two new signal types |
| **"I need help / SOS"** | `buildDuressAlert` / `encryptDuressAlert` (`scope: group\|persona\|master`, precision-11) | wire to UI panic trigger |
| Metadata-hiding transport | **NIP-59** gift wrap (kind 1059) + **NIP-17**, all **NIP-44** | *proposal:* wrap live beacons/alerts (currently raw AES-GCM) |

**Key insight:** "privacy-protected unless triggered" is an **emission policy, not new
cryptography**. The device holds location locally, evaluates the fence locally, and only
`encryptBeacon`-and-publishes when (a) it crosses a fence, (b) pick-me-up, or (c) help.
Night-out mode flips the policy to coarse (geo-indistinguishable) beacons on a timer with
NIP-40 expiry.

> **NIP-59-for-beacons caveat (2-1 split):** gift-wrap is currently used for private
> seed/reseed payloads, while live signals (kind 20078) and beacons use AES-256-GCM
> envelopes. Wrapping live beacons/alerts in NIP-59 is a sound proposal the primitives
> support — not yet the shipped path.

---

## 5. Caveats & volatility

- **Platform volatility (highest risk):** browser/OS capabilities change frequently;
  iOS installed-PWA limits are the likely binding constraint and must be re-verified on
  live devices before committing the PWA-first plan.
- **GrapheneOS background reliability is unproven** — the one claim pinning the mechanism
  down was refuted. Prototype early.
- **Plugin licensing/maintenance:** transistorsoft's native geofencing needs a paid Android
  licence; confirm both plugins' Capacitor-version compatibility and maintenance.

## 6. Open questions (carry into Phase 0)

1. Measured background-location / geofence-wake reliability on **GrapheneOS without Google
   Play Services** (raw GPS + foreground service + local point-in-polygon, ± microG/UnifiedNlp).
2. Precise current (2026) background limits of an installed PWA on **iOS Safari** — is the
   Capacitor wrapper mandatory on iOS from day one?
3. Concrete construction for **"withheld-until-event"** location that still permits local
   geofence evaluation, *and* interacts correctly with the requirement that withholding
   must not be an observable "tell".

---

## Sources

**Primary:**
- W3C Geofencing API (archived) — https://github.com/w3c/geofencing-api ·
  https://www.w3.org/standards/history/geofencing/
- Periodic Background Sync — https://developer.chrome.com/docs/capabilities/periodic-background-sync
- transistorsoft plugin — https://github.com/transistorsoft/capacitor-background-geolocation · https://docs.transistorsoft.com
- capacitor-community plugin — https://github.com/capacitor-community/background-geolocation
- UnifiedPush — https://unifiedpush.org/news/20221218_unifiedpush/ · https://f-droid.org/2026/01/08/unifiedpush-5-years.html · https://www.f-droid.org/en/2018/09/03/replacing-gcm-in-tutanota.html
- Geo-indistinguishability — https://dl.acm.org/doi/10.1145/2508859.2516735 · https://arxiv.org/abs/1212.1984
- Panic Passwords — https://users.encs.concordia.ca/~clark/papers/2008_hotsec.pdf
- Duress passwords (CSCW 2025) — https://dl.acm.org/doi/10.1145/3715070.3749266
- Intimate threats — https://academic.oup.com/cybersecurity/article/6/1/tyaa006/5849222
- NIP-59 — https://github.com/nostr-protocol/nips/blob/master/59.md ·
  NIP-17 — https://github.com/nostr-protocol/nips/blob/master/17.md ·
  NIP-78 — https://github.com/nostr-protocol/nips/blob/master/78.md ·
  NIP-40 — https://github.com/nostr-protocol/nips/blob/master/40.md ·
  NIP-01 — https://github.com/nostr-protocol/nips/blob/master/01.md ·
  NIP-EE — https://github.com/nostr-protocol/nips/blob/master/EE.md

**Secondary / forum / blog (push/platform constraints):**
- GrapheneOS UnifiedPush — https://discuss.grapheneos.org/d/8503-notifications-without-google-services-unifiedpush
- iOS PWA limits — https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide
- Nostr push proposal — https://github.com/nostr-protocol/nips/issues/257
