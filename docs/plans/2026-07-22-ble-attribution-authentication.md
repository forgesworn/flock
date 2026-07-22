# BLE RSSI attribution — the proper authentication fix

**Date:** 2026-07-22 · **Status:** design (immediate mitigation SHIPPED same day) · **Owner:** capacitor-mesh-ble + flock

## The problem

Radar's Phase-3 BLE assist attributes a signal-strength band to a specific member
via a MAC↔peer binding the mesh plugin calls "authenticated." It is not. The
binding is made in `MeshBlePlugin.learnPeer(from, source)` from the **self-declared
plaintext `f` field** of the transport envelope; the payload (`d`) is an opaque
NIP-59 wrap the plugin never decrypts or verifies (it relays "even frames we cannot
decrypt"). Two consequences, both live only when **crowd/mesh mode** is on
(`initialHops > 0`, the festival "find each other" path, `hops = 3`):

1. **Relay reattribution (no attacker needed).** A relayed frame keeps the original
   `from` but arrives on the *relayer's* MAC, so `learnPeer` binds the sender's
   pubkey to a relayer's MAC. RSSI on that link is proximity to the relayer, not the
   named friend.
2. **Active spoofing.** The crowd discovery UUID `meshUuid = sha256("flock:ble-mesh:v1:"+epoch)`
   is **keyless by design**, and the GATT server is unbonded (`connectGatt(…, false, …)`,
   plain `PERMISSION_READ/WRITE`). Any nearby device can connect and inject one frame
   with `f` = a target's pubkey, binding its own MAC to that identity, then drive the
   RSSI a victim's radar attributes to their friend.

**Bound (why it isn't catastrophic):** the flock-kit honesty gates are correct — BLE
can only floor the HOMING cadence, hold HOMING, or speak "Very close — by Bluetooth",
and only when the target's own GPS disclosure already places them ≤50 m and non-coarse.
No false bearing, no fabricated position. Worst case is a false/misattributed
*proximity nudge* inside an already-50 m GPS window.

## Immediate mitigation — SHIPPED 2026-07-22

Attribution is now suppressed entirely while relaying, at two layers:

- **Plugin (source of truth):** `MeshBleWire.shouldAttributeRssi(initialHops)` →
  `initialHops == 0`; `emitRssiForAddress` returns early when false, so **neither** the
  JS `rssi` event **nor** the `MeshBleRssiBus` (the locked-phone `RadarGuideService`
  consumer) receives a sample in crowd mode. JVM-tested.
- **flock app (belt + braces, battery):** `native/ble.ts` tracks `meshHops`;
  `armRssiWindow` refuses (returns null) while `bleMeshRelaying()`, so the foreground
  path never even starts the sampler. Vitest-covered.
- Misleading "authenticated" language corrected in `definitions.ts`, the changelog,
  `ble.ts` and `radarMode.ts`.

This reduces the exposure to the **insider-only** case in discreet mode (a member who
already knows the circle seed could still spoof `f`), which the proper fix below closes.

## The proper fix — verified attribution

Attribution must come from a frame the app has **decrypted and verified as originating
from `from`**, not from the transport envelope. The plugin cannot do this (the payload
is opaque to it by design), so the trust decision moves up to flock, which holds the
keys.

**Approach A (recommended): app-confirmed peer binding.**
- The plugin stops asserting identity. It exposes the raw observation only: "MAC `X`
  delivered a frame claiming origin `P`" — an *unconfirmed* candidate, plus RSSI keyed
  by MAC, never by peer id.
- flock's BLE receive path already decrypts each wrap to consume it. On a wrap that
  cryptographically verifies as sealed by `P` (NIP-59 seal author check), flock calls a
  new `confirmPeerAddress(P, X)` to bind — and RSSI attribution to `P` is only ever
  derived from a MAC that flock itself confirmed this way, within a freshness window.
- Radar then reads RSSI for a confirmed (P, X) pair only. A spoofed `f` never verifies,
  so it never confirms; a relayed frame verifies as `P` but its *delivering* MAC is the
  relayer's, so binding must additionally require the frame to be **direct** (0 hops
  travelled) — carry the travelled-hop count to the app and confirm only `hops == initialHops`.

**Approach B (narrower): direct-link + bonded GATT.**
- Require BLE bonding/encryption on the crowd GATT link and attribute only actively-polled
  `readRemoteRssi` on links *we* initiated to a peer whose identity we verified in-band.
  Heavier (bonding UX, pairing prompts) and still needs the in-band identity proof, so A
  is preferred.

## Concrete touchpoints (traced 2026-07-22 — ready to implement Approach A)

The seal-verified sender already exists in the flock unwrap path; the wiring gap is that
attribution is decided a layer BELOW it, from unverified transport metadata. Specifically:

- **`app.ts onBleFrame(data)`** receives only the opaque wrap `{id,pubkey,content,sig}` —
  the wrap `pubkey` is the NIP-59 EPHEMERAL key, not the sender. It DROPS the transport
  `from` and never sees the delivering MAC or hop count (ble.ts calls `onFrame(payload,
  from)` but onBleFrame ignores `from`). It then `dispatchWrap(c.id, wrap, deriveInbox(
  c.seedHex).sk)` for every circle; the ONE circle whose inbox key decrypts reveals the
  real, seal-verified sender (`rumor.pubkey`). **That success point is the only honest
  identity signal, and today nothing feeds it back to BLE.**
- **Plan:**
  1. Plugin (Android `MeshBlePlugin` + iOS `MeshBlePlugin.swift`): stop attributing RSSI
     via `peerAddresses` (the `learnPeer` envelope binding). Add a SEPARATE
     `confirmedAddresses` (peer→{address,atMs}) populated ONLY by a new `confirmPeer(peer,
     address)` bridge method; `emitRssiForAddress` attributes via `confirmedAddresses`
     within a freshness window (a rotated MAC lapses). Include the delivering `address`
     and travelled-hop count on the `frame` event.
  2. `ble.ts`: thread `address`+`hops` through to `onBleFrame`; expose `confirmPeer`.
  3. `app.ts onBleFrame(data, address, hops)`: only when `hops === 0` (direct) AND a
     `dispatchWrap` unwrap SUCCEEDS (seal author verified), call `confirmPeer(rumor.pubkey,
     address)`. A spoofed `f` never unwraps → never confirms; a relayed frame has hops>0.
  4. Once confirmed attribution is live and field-proven, RELAX the discreet-mode gate
     (`ble.ts bleMeshRelaying` / `MeshBleWire.shouldAttributeRssi`) so crowd-mode BLE assist
     returns — now honestly, on verified direct links only.
- **Tests:** the acceptance list above, plus a unit test that a `confirmedAddresses` entry
  older than the freshness window yields no attribution, and that `onBleFrame` confirms
  only on a successful unwrap.
- **Effort:** two-platform plugin change + crypto-path wiring + honesty tests — a focused
  slice of its own, deliberately NOT rushed alongside other work (a subtle error re-opens
  the hole). The shipped discreet-mode gate is the safe interim until this lands.

## Acceptance
- A frame with a spoofed `f` (valid crowd UUID, no valid seal for that pubkey) produces
  **no** RSSI attribution to the impersonated member — in crowd mode, foreground and locked.
- A genuine member's frame that crossed ≥1 relay hop produces no attribution (its
  delivering MAC is not the member's).
- A direct, seal-verified member link in crowd mode **does** attribute — restoring the
  indoor endgame the assist exists for, now honestly, without needing discreet mode.
- Discreet mode behaviour unchanged.

## Non-goals
No RSSI-to-metres. No attribution from unverified adverts. No relaxing the kit honesty
gates (≤50 m GPS story, coarse-share exclusion, blend/hold-only) — this fix hardens the
*identity* feeding them, nothing else.
