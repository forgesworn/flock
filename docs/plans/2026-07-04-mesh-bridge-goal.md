# Mesh & bridge — research consolidation and the executable goal

**Date:** 2026-07-04 · **Author:** research session (Fable) · **Executor:** a Sonnet 5 agent (see §5)

This document consolidates today's research (locked-screen reliability, relay
reachability, DarkFi survey, relay-metadata audit) into one self-contained goal
an implementation agent can complete without re-deriving context.

---

## 1. Where we are (shipped today, 2026-07-04)

- **Locked-screen sharing fixed at the root:** Doze suspended the WebView's
  relay socket minutes after lock (fixes kept arriving from the FGS; publishes
  failed). The battery exemption is now requested when *sharing* starts and its
  absence surfaces as an actionable Home card (`batteryCard`, app.ts).
- **Reachability fixed:** `SimplePool({ enableReconnect: true, enablePing: true })`
  — subscriptions now survive socket drops with since-catch-up replay; the ping
  detects half-dead sockets. Before this, one drop killed all incoming until an
  app restart.
- **Circle chat + private threads:** Signal-style group thread on Home
  (persisted, deduped against relay replays by the rumor's own `(from, at,
  text)` triple), 1:1 threads under You, MessagingStyle conversation
  notifications in the native shell.
- **Check-in roll-call:** a buzz can carry `ask: 'location'` (inside the
  encrypted envelope — zero wire-visible change). Recipients already sharing
  freshen their beacon; everyone else gets an explicit "share once?" card.
  Never automatic.
- **Bridge v1 (single-hop):** a phone that receives a wrap over BLE and has
  connectivity re-publishes the full signed wrap to its relays
  (`onBleFrame`, app.ts). Deduped; relays drop duplicate ids.

## 2. Research findings that shape the goal

### DarkFi survey (full report in session log, 2026-07-04)
- **Adopt: Tor `.onion` relay endpoint, as a user toggle.** DarkFi runs over
  Tor in production but *reverted Tor-by-default* — unreliable on poor mobile
  connectivity. PRIVACY.md already names IP exposure as the high-leverage fix.
- **File for later: event-graph (tips-DAG) gossip** — the proven server-free
  pattern for multi-hop message sync, *if/when* BLE-nearby goes multi-hop.
  Do not build ahead of the need.
- **Reject: RLN zk anti-spam** (wrong threat model — circles are invite-only)
  and **on-device p2p daemons/blockchain** (battery + background-execution
  reality on Android; the Capacitor shell exists precisely because nothing
  survives the background without native hooks).
- **Note: per-message forward secrecy** for DMs (Double-Ratchet-style) would
  tighten the compromise window from ~one seed epoch (~monthly rotation +
  NIP-40 expiry) to per-message. Genuine but incremental hardening.

### Relay-metadata audit
- See §4 — the audit's confirmed findings become this goal's hardening tasks.

## 3. The vision (Darren, 2026-07-04)

> "those on BLE mesh with those on BLE and ultimately hit someone with 5G and
> piggy backed safely and privately to nostr relays — proper mesh and bridge
> tech!"

A crowd at a festival with no signal: wraps hop phone-to-phone over BLE until
they reach anyone with connectivity, who uplinks them to the relays — and the
reverse: a connected phone pulls the circle's wraps down and floods them into
the mesh. All strictly additive to the relay path, opt-in, battery-sane.

## 4. Goal for the implementation agent

**Deliver mesh & bridge v2 plus the audit's hardening items, without touching
the relay path's behaviour for anyone who hasn't opted in.**

### Hard constraints (non-negotiable, from CLAUDE.md / FLOCK.md §6)
1. The relay path must be byte-for-byte unchanged when BLE is off (it is the
   default-off, native-only, opt-in transport).
2. Privacy invariants: withholding ≡ sharing observationally; duress ≡ normal;
   beacon/duress key separation; coordinates never leave the device except as
   an encrypted beacon after a triggering event.
3. Library stays pure (no transport/encoding); TDD; British English; ESM-only;
   `type: description` commits, no Co-Authored-By.
4. Battery is a feature: no polling loops, no wake-locks beyond the existing
   FGS, hop caps and dedup on everything that floods.

### Task A — mesh v2: store-and-forward multi-hop (the big one)
- Extend the BLE pipeline so wraps received in crowd-mesh mode are RETAINED
  (bounded ring buffer, e.g. 200 wraps / 15 min TTL respecting NIP-40) and
  re-advertised to LATER-arriving peers — today a frame floods only to peers
  connected at that instant; a phone walking into range gets nothing.
- Reconciliation: on peer connect, exchange compact id manifests (the DarkFi
  tips-DAG is the reference pattern; a sorted id-list diff is an acceptable v2
  — do not build a full DAG until sync cost demands it).
- Keep the existing hop cap (`BLE_MESH_HOPS = 3`) and `markWrapSeen` dedup as
  the flood-control backbone; TTL + ring buffer bound memory.
- Downlink bridging: a connected phone in mesh mode floods RELAY-received
  wraps into the mesh (mirror of today's uplink bridge). Gate on festival
  mode; same dedup.
- Tests: the pipeline tap and buffer/reconcile logic are pure TS — full vitest
  coverage. Hardware verification is explicitly OUT of scope (2-device session
  with Darren; leave a test plan in `docs/plans/`).

### Task B — Tor `.onion` relay endpoint (opt-in toggle)
- Stand-up doc + config: PRIVATE_RELAYS gains an optional `.onion` twin; a
  You→Settings toggle ("Route through Tor when available") that is OFF by
  default and clearly labelled unreliable-on-mobile (DarkFi's lesson).
- In the native shell, detect Orbot (Tor SOCKS on 127.0.0.1:9050) and route
  the relay websocket through it when the toggle is on; in the PWA the toggle
  explains it needs the app + Orbot.
- Never silently fall back from Tor to clearnet when the toggle is on —
  fail loud (the user chose the property; a silent downgrade is a leak).

### Task C — audit hardening (from the relay-metadata audit)
- The full audit is `docs/research/2026-07-04-relay-privacy-audit.md`; its
  "Mitigations, priority order" section is the work list. Item 1 (Tor) is
  Task B. Implement 2–5 as individual commits:
  2. cadence jitter + low-rate stationary cover traffic (F1);
  3. profile-fetch fix — honest toggle warning + per-pubkey REQs (F3);
  4. word-invite hardening — 6 words / costlier scrypt / park a one-time
     reference not the seed, delete-on-fetch (F4);
  5. delete the dead `subscribeSignals`/`publishEvent` bare-20078 paths and
     warn when a relay outside the known no-log list is added (F5).
  Also align FLOCK.md §3 / PRIVACY.md with the shipped wrap-everything wire
  model (spec drift noted in the audit). Item 6 (weekly inbox rotation
  option) → roadmap note only.

### Task D — DM forward secrecy (stretch, only if A–C land clean)
- Per-message ratchet over the existing gift-wrap DMs (hash-ratchet forward
  secrecy is sufficient; full Double Ratchet with DH steps is overkill for a
  same-epoch thread). Wire-compatible: old clients keep reading nothing they
  couldn't already; version field inside the encrypted payload.

### Acceptance
- `npm run build && npm test && npm run typecheck && npm run lint` green;
  `npm run build:app` green; targeted e2e specs green (do NOT run the full
  suite; never edit source mid-e2e-run — HMR corrupts it).
- Every new module has tests written first (failing → passing).
- A short `docs/plans/` note per task: what shipped, what's hardware-gated.
- No new always-on network or radio behaviour without an explicit opt-in.

## 5. Execution notes for the agent
- Read first: `CLAUDE.md`, `FLOCK.md` §6, `docs/PRIVACY.md`,
  `docs/plans/2026-07-04-ble-nearby-transport.md`, `native/ble.ts`,
  `app/src/app.ts` (BLE + publishSignal + onBleFrame), `app/src/bleId.ts`.
- The generated `android/` project is gitignored; all native config flows
  through `native/patch-android.mjs` + `native/android-src/*.java`.
- Relay traffic goes to PRIVATE_RELAYS only (Darren distrusts public relays);
  never add a public relay default.
- Work in a branch; commit per task; leave the tree green.
