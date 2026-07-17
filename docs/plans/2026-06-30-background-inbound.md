# Background inbound — receiving alerts with the app closed

**Date:** 2026-06-30 · **Owner:** flock · **Status:** **OPTION A SHIPPED.** The opt-in, location-free Stay reachable foreground service keeps the existing relay/WebView path alive for app-closed alerts and has a Samsung A32 hardware pass. UnifiedPush remains an unimplemented fallback considered in this historical design. Broader battery/device evidence remains in `../ROADMAP.md`.

## Why this exists

flock has **two** background problems, not one. The Phase 0 spike
([`2026-06-30-phase0-graphene-spike.md`](2026-06-30-phase0-graphene-spike.md))
measures the **outbound** half — detecting *my* geofence breach when my phone is
pocketed and locked. This doc is the **inbound** half: receiving *someone else's*
SOS / breach / missed check-in when **my** app is closed.

In the PWA, `app/src/services.ts › subscribeGiftWraps` holds a relay socket open
to read NIP-59 gift wraps addressed to my rotating inbox key. That socket dies
the instant the app is backgrounded — so a closed-app flock receives nothing. No
web platform fixes this (see the feasibility research §1.1); like outbound, it
needs the native shell.

## Constraints

- **De-Googled.** No FCM on GrapheneOS. Delivery must not depend on Google/Apple
  push (`PRIVACY.md` / research §1.3).
- **Metadata-minimal.** The relay already sees only opaque `kind:1059` to an
  opaque, rotating inbox (gift-wrap-everything). Any inbound mechanism must not
  re-introduce a `{device ↔ real identity}` or `{device ↔ inbox}` link to a third
  party.
- **Alert, don't tell.** An inbound SOS *should* raise a visible, audible, haptic
  notification — that's the point. The always-on "keeping watch" foreground-service
  notification is the coercion-sensitive one (FLOCK.md §6).

## Option A — persistent relay socket in the foreground service (recommended)

The foreground service already running the background-geolocation watcher also
holds a Nostr WebSocket open. Reuses the existing transport almost wholesale:

1. derive the current gift-wrap inbox filter(s) from the store (the rotating
   `deriveInbox` key, per circle + epoch),
2. subscribe on the private relay (`app/src/relays.ts`) with
   `{ kinds:[1059], '#p':[inboxPubkeys] }` — the same filter `subscribeGiftWraps`
   uses,
3. on an event → unwrap via `app/src/giftwrap.ts` → classify the inner signal,
4. on `help` / `breach` / missed check-in → fire a local notification + haptic.

Re-derive the filter on epoch rollover (reseed) and re-subscribe on reconnect;
dedupe by event id (relays replay on reconnect — the app already does this).

| Pro | Con |
|---|---|
| No third party, no push intermediary, fully GrapheneOS-native | Only delivers while the foreground service is alive |
| Rides in the process already kept alive for outbound GPS | Needs robust reconnect across wifi↔cell + Doze windows |
| Strongest privacy — nothing new learns the social graph | Reliability ceiling **=** the Phase 0 foreground-service survivability result |

**The synergy:** one Phase 0 result de-risks *both* directions. If the service
survives Doze well enough for outbound breach detection, the same socket carries
inbound alerts for free — so inbound needs no separate spike, just one extra
assertion in the same run (spike test #5: publish an SOS from a second device
while the spike phone is locked; confirm a local notification fires).

**Build items (small)**

- deps: `@capacitor/local-notifications`, `@capacitor/haptics` (both Google-free).
- `native/inbox.ts` (sibling to `background.ts`): derive inbox filter from store →
  subscribe → unwrap → classify → notify; re-derive on epoch change; reconnect with
  backoff.
- start it from `app/src/main.ts` alongside the GPS watcher under
  `Capacitor.isNativePlatform()`.

## Option B — UnifiedPush + a bridge (fallback)

A device-side distributor (e.g. ntfy) holds one socket for all apps and wakes
flock on a push. Nostr relays don't push to UnifiedPush, so a small
(self-hostable) **bridge** beside the relay subscribes to inbox filters and POSTs
the device's UnifiedPush endpoint on a match.

| Pro | Con |
|---|---|
| Survives flock's *own* service being killed (distributor holds the socket) | More infra: a distributor app + a bridge service |
| One socket for all apps → less aggregate battery | Bridge learns a `{endpoint ↔ inbox pubkey}` map — a timing/graph leak (content stays opaque) |
| | The canonical Nostr push proposal still routes via Apple/Google — *not* FCM-free; UnifiedPush is the de-Googled escape, at this cost |

Mitigations: self-host the bridge; keep registration coarse; rotate it as the
inbox keys rotate.

## Recommendation & sequence

1. **Run Phase 0 first** (the outbound spike). Its foreground-service
   survivability result is the gate for inbound Option A too.
2. Service survives → ship **Option A**: zero new infra, best privacy, ~one new
   module (`native/inbox.ts`). MVP-complete for de-Googled alerts.
3. Reach for **Option B** only if real-device testing shows the service dies too
   often (more a stock-Android / OEM concern than AOSP / GrapheneOS). It slots
   behind the same `services.ts` transport seam.

## Decision gate

- Phase 0 service survives Doze (#3) **and** an alert is delivered while locked
  (#5) → build Option A (`native/inbox.ts`).
- Service dies under Doze → either tune the watcher, or adopt Option B's
  distributor + bridge and accept the extra metadata surface.
