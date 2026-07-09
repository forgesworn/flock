# Goal - phone-hosted onion relay for a circle

**Date:** 2026-07-09 · **Status:** goal/feasibility spike · **Owner:** flock app + native

## The one-sentence goal

Let the creator of a temporary circle host that circle's Nostr relay from their
Android/GrapheneOS phone as a Tor onion service, with relay events held in
memory only and destroyed when the circle is burned, expires, or the host stops
the service.

This is the sovereign version of ephemeral relay rooms: no managed VM, no shared
host, no provider-owned relay database. The creator's phone becomes the room.

## Feasibility judgement

Feasible enough to spike on Android/GrapheneOS. Not something to promise as
"no trace".

The pieces exist:

- Nostr relay traffic is WebSocket based, so a small local WebSocket relay can
  serve the subset flock needs.
- Tor onion services can expose a local service without inbound port forwarding.
- Orbot already supports Tor routing on mobile and says phones can host onion
  services.
- Flock already has native Android background work, Tor route detection, a
  fail-loud onion relay path, gift-wrapped opaque events, and RAM-only hosted
  relay-room semantics to reuse as a threat model.

The hard parts are mobile reliability and integration:

- The relay host phone must stay online, awake enough, and running a foreground
  service.
- Orbot may not expose a clean stable API for programmatic onion-service
  creation; manual setup may be acceptable for a spike but not for product.
- Tor onion service latency and mobile network handover may make live location
  feel slower.
- iOS is out of scope for v0 because continuous background hosting is not a
  realistic first target.
- If the creator's phone dies, loses data, reboots, or Tor is blocked, the room
  disappears.

The honest product claim is:

> Relay state lives in memory and can be burned.

Do not claim:

> No trace.

## Privacy and trace boundary

Burning the room can wipe the relay's in-memory event buffer and stop the onion
endpoint. That is useful and on-brand. It does not erase every trace of the
conversation.

What burn can clear:

- the phone-hosted relay's event buffer;
- active subscriptions;
- the admin token/session material for that relay instance;
- the onion endpoint if the hidden-service key is discarded;
- app-level relay state, if the implementation avoids persistence.

What burn cannot honestly clear:

- messages or beacons already received and cached on member devices;
- notifications, screenshots, OS-level logs, keyboard history, backups, or crash
  reports;
- Tor usage metadata visible to the host phone's network provider;
- timing and bandwidth patterns visible to parts of the network;
- anything a modified or malicious client deliberately records;
- logs written by Orbot, Android, vendor services, or debugging tools outside
  flock's control.

The creator-hosted room improves the hosted-room trust boundary: a cloud
provider no longer sees the relay room. It does not make infrastructure blind.
Members still have to trust their own phones, the circle creator not to modify
the app, and the Tor route to be active.

## Product shape

The flow should be explicit and temporary.

1. A user creates a night-out circle.
2. They choose "Host this circle from this phone".
3. Flock starts a native foreground service with a local in-memory relay.
4. Flock exposes that local relay through a Tor onion service.
5. The invite includes the onion relay URL and enough room metadata for members
   to use it.
6. Members join through the native app with Tor routing enabled; the PWA can
   explain that this mode needs the app plus Orbot.
7. The creator sees a clear "Relay active" state, member connection count if
   safe to show, expiry, and a Burn button.
8. Burn stops the relay, clears memory, tears down the onion endpoint where
   possible, and switches the circle to unavailable unless a fallback relay was
   deliberately configured.

Default posture:

- off by default;
- Android/GrapheneOS first;
- temporary circles first;
- one active hosted circle per phone for v0;
- no persistent relay database;
- no app-level access logs;
- fail loud if Tor/onion hosting is not ready.

## Technical design target

### Relay scope

Do not build a full public Nostr relay. Build the smallest relay that flock
needs, then document the gaps.

Required v0 relay behaviour:

- Accept WebSocket connections on localhost.
- Implement the NIP-01 message shapes needed by flock:
  - `EVENT` from client to relay;
  - `REQ` filters for `kind:1059` gift wraps by `#p`;
  - `CLOSE`;
  - `EVENT`, `EOSE`, `OK`, and `NOTICE` from relay to client.
- Store only bounded in-memory events:
  - max event count;
  - max event bytes;
  - max age / NIP-40 expiry if present;
  - oldest-first eviction.
- Broadcast new matching events to current subscribers.
- Drop everything on burn, expiry, service stop, or process death.
- Never persist event bodies, room IDs, admin tokens, or onion private keys
  unless a later product decision explicitly accepts that tradeoff.

Non-goals for v0:

- public relay use;
- paid access;
- moderation;
- search;
- profile fetching;
- long-term history;
- iOS hosting;
- proving "no logs" with TEE/attestation.

### Android host service

Add a native Android foreground service dedicated to the phone-hosted relay.

It should:

- start only after explicit user action;
- show a persistent notification while active;
- use the correct Android foreground-service type(s);
- bind the local relay to loopback only;
- expose start/stop/status through a narrow Capacitor plugin;
- stop cleanly on burn, circle expiry, reset, app lock teardown, and sign-out;
- avoid disk writes and avoid logging event contents;
- survive screen lock as far as Android permits.

Prefer a Kotlin/JVM relay core with tests. Keep protocol parsing, filtering,
memory storage, expiry, and burn semantics pure enough to test without Android.

### Tor onion service

First prove which path is viable:

1. Orbot-managed onion service that forwards to the local relay port.
2. Embedded Tor library controlled by flock.
3. Manual Orbot setup as a spike-only fallback.

The implementation agent must not assume Orbot can be configured
programmatically. Verify it against current Orbot behaviour and document the
result.

The onion URL should be `ws://<v3-onion>.onion` or equivalent WebSocket-over-
onion. Do not require clearnet TLS for the onion path in v0; the privacy
property comes from the onion service and the application encryption. Do fail
loud if the app would otherwise fall back to clearnet.

### App integration

Add a new circle relay mode without disturbing existing relay paths:

- existing hosted/default relays continue to work unchanged;
- phone-hosted relay is opt-in per circle;
- invites can carry the onion relay URL for the circle;
- `effectiveRelays` must keep its no-silent-downgrade rule;
- member devices need a clear error when Tor is off, Orbot is missing, or the
  onion relay is unreachable;
- burn/leave/disband must prune local chats and relay state consistently with
  the existing ephemerality model.

## Claude execution goal

Deliver an Android/GrapheneOS feasibility spike for creator-hosted onion relay
rooms, then implement the narrow v0 only if the spike proves the route.

### Read first

- `CLAUDE.md`
- `docs/relay-room-privacy.md`
- `docs/runbooks/relay-rooms.md`
- `docs/plans/2026-07-01-second-no-log-relay.md`
- `docs/plans/2026-07-04-mesh-bridge-goal.md`
- `native/orbot.ts`
- `app/src/relays.ts`
- `app/src/services.ts`
- `app/src/store.ts`
- `server/rooms.mjs`

### Phase 1 - prove the route

Create a short research note under `docs/research/` answering:

- Can current Orbot on Android expose a local WebSocket service as a v3 onion
  service in a way flock can guide or automate?
- If not, what is the smallest embedded-Tor or manual-spike fallback?
- Can another Android device running Orbot connect to a local test WebSocket
  server through the onion address?
- What survives screen lock, Doze, network handover, and app backgrounding?
- What logs or persistent files are created by flock, Orbot, and Android during
  the spike?

Do not proceed to product code until this note gives a clear recommendation.

### Phase 2 - relay core

If Phase 1 passes, build a tested in-memory relay core:

- pure Kotlin/JVM or pure TypeScript if that proves easier to bridge, but it
  must run inside the Android host path;
- NIP-01 subset only;
- bounded event memory;
- expiry and burn;
- no persistence;
- tests for publish, subscribe, replay, expiry, eviction, burn, malformed
  messages, and event-size limits.

### Phase 3 - native Android host

Add the Android foreground service and Capacitor bridge:

- start phone relay for active circle;
- stop phone relay;
- get status;
- return local port and onion URL;
- emit clear errors for Tor unavailable, onion setup failed, relay failed, or
  service killed.

Keep generated Android output out of git; update `native/patch-android.mjs` and
committed native source files only, following the repo convention.

### Phase 4 - Flock UX and invite wiring

Add the smallest usable UI:

- creator action: "Host from this phone";
- visible active relay state with expiry and Burn;
- invite carries onion relay details;
- join path explains native app plus Orbot requirement;
- settings/status uses honest wording: "Memory relay. Burn clears this phone's
  relay buffer. It cannot erase copies already delivered."

Avoid marketing claims and avoid "no trace".

### Phase 5 - verification

Required automated checks:

- relay-core unit tests;
- `npm run build`;
- `npm test`;
- `npm run typecheck`;
- `npm run lint`;
- `npm run build:app`;
- `npm run test:native` if native Kotlin code is touched.

Required manual/hardware checks:

- creator GrapheneOS/Android phone hosts the relay;
- second Android phone joins over Orbot/onion;
- publish a wrapped signal;
- receive it on the second phone;
- lock creator phone and confirm whether relay remains reachable;
- burn the room and confirm reconnect/replay fails;
- inspect app-visible storage/logging for event bodies or relay buffers.

Record the hardware results in `docs/runbooks/` or `docs/research/`.

## Acceptance criteria

- We can state clearly whether phone-hosted onion relay rooms are product-viable,
  spike-only, or not viable.
- If viable, a creator can host one temporary circle relay from an Android phone
  and another Android phone can exchange flock gift wraps with it over Tor.
- Burn clears the relay's in-memory event buffer and stops the endpoint.
- No existing user is moved to Tor, onion relays, or phone hosting unless they
  opt in.
- Failure is loud and actionable; there is no silent clearnet fallback.
- Product copy says memory/burn/minimisation, never "no trace".

## References

- Orbot mobile Tor/onion service overview: https://orbot.app/
- Tor onion service setup model: https://community.torproject.org/onion-services/setup/
- Nostr NIP-01 relay WebSocket model: https://github.com/nostr-protocol/nips/blob/master/01.md
- Android foreground services: https://developer.android.com/develop/background-work/services/fgs
- Android 14 foreground-service type requirements: https://developer.android.com/about/versions/14/changes/fgs-types-required
