# BLE mesh v2 (store-and-forward) — the 2/3-device hardware test plan

**Date:** 2026-07-04 · **Updated:** 2026-07-20 · **Status:** bounded live
peer reconciliation is implemented and unit-tested through shared `mesh-kit`
and `capacitor-mesh-ble`; hardware verification **not done** — this doc is the
plan for the session that does it.
Mirrors `docs/plans/2026-06-30-phase0-graphene-spike.md`'s format.

## Why this exists

Task A of `docs/plans/2026-07-04-mesh-bridge-goal.md` first shipped retention
plus a restart-time full-buffer re-flood. On 2026-07-20 that approximation was
replaced by the real bounded path: the shared plugin emits a learned `peer`
route, `mesh-kit/sync/v1` exchanges room-scoped paged manifests, and each side
unicasts only missing opaque wraps while preserving their original bytes. The
old raw gift-wrap wire remains unchanged for mixed-version peers. What remains
is proving it on real radios. The existing BLE-nearby validation (2026-07-04, A32 ↔ Pixel 10
Pro, see `docs/plans/2026-07-04-ble-nearby-transport.md` phasing item 4) proved
arbitration, the NOTIFY reverse channel, and single-hop crowd-mesh delivery —
but not retention, not the manifest exchange, and not multi-hop relay depth
(that doc's own "Gaps" note: *"3-device multi-hop (relay depth, h>0 past one
hop) still needs a third phone"*). This plan is that follow-up session.

## Devices

- **Tier 2 (have it):** Samsung A32 (Android 13/API 33) + Pixel 10 Pro
  (Android 16/API 36) — same pair as the existing BLE validation (`adb`
  reachable per `flock test devices` memory).
- **Tier 3 (new):** a third phone for genuine multi-hop. Anything running the
  APK works — GrapheneOS is not required for this (BLE, not background
  location). Borrow one if a friend's device is available.
- All networking OFF on every device (Wi-Fi off, mobile data off / no SIM) —
  relay delivery must be physically impossible, so any signal that arrives
  proves the mesh path and nothing else.

## What's ALREADY proven (do not re-test)

From the 2026-07-04 BLE-nearby session — carry this context in, don't redo it:
- Arbitration (tiebreak → one link per pair, roles flip correctly on restart).
- NOTIFY reverse channel (server→client buzz renders on the initiator).
- Both directions end-to-end (WRITE + NOTIFY) on a shared circle.
- Mode switch (festival on/off → discreet ↔ crowd mesh, hops 0 ↔ 3).

## What THIS session must prove

### 1. Retention — the walk-in-late scenario (2 devices)
The core mesh-v2 claim: a phone that wasn't in range when a wrap was sent
still gets it later, from the SAME peer's buffer (no third device needed for
this one).

1. A32 + Pixel both join the same circle, both start festival ("find each
   other") so crowd mesh (hops 3) is active on both.
2. Walk the Pixel **out of BLE range** (a different room/floor — a few metres
   isn't enough, confirm via `adb logcat` that the link actually drops).
3. On the A32, send a buzz (or let a beacon publish). Confirm the Pixel does
   **not** receive it (out of range — expected).
4. Walk the Pixel back into range.
5. **Expected:** reconnect learns the Pixel's peer route, immediately exchanges
   bounded manifests and unicasts the earlier missing wrap; no app/radio restart
   or full-buffer broadcast is required. The Pixel decrypts and renders it.
6. Repeat with the roles reversed (Pixel sends while A32 is out of range).

**Pass/fail:** the late-arriving device receives the missed wrap without a
relay being reachable at any point. **Fail modes to watch for:** the `peer`
route event never fires after a valid frame; a manifest control is rejected;
or the receiving device's own `markWrapSeen` already consumed the id from a
PARTIAL BLE receive earlier and drops it silently
(check `native/ble.ts`/the Android plugin's chunk-reassembly logs).

### 2. Manifest reconcile — prove the real hook (2 devices)
The logic and mixed-version wire compatibility are unit-tested in
`native/ble.test.ts`; hardware must now prove the lifecycle edge.

1. Start both phones in crowd mode and send distinct wraps from each.
2. Break the BLE link, send one more wrap on A, then reconnect B.
3. Open `?diag=ble` in a diagnostic build and confirm `Reconcile` shows held
   frames and one recovered offer; native status should show a learned peer id.
4. Confirm the missing wrap is sent directed to the learned route, while a
   normal gift wrap remains raw NIP-59 JSON (no `_flockMeshSync` wrapper).
5. Repeat with an old APK on B: ordinary wraps must still deliver; the old app
   may ignore v2 controls and therefore does not receive the backlog.

**Pass/fail:** two current clients recover only the gap without restarting or
re-broadcasting the whole buffer, and mixed old/new live traffic is unchanged.

### 3. Downlink bridging (2 devices, one needs connectivity)
1. A32: Wi-Fi/data ON, subscribed to the circle's relay as normal. Pixel:
   networking OFF, in BLE range, festival/crowd-mesh on both.
2. From a THIRD context (e.g. a laptop browser session on the same circle, or
   a second relay-connected phone) publish a signal through the relay.
3. **Expected:** the A32 receives it over the relay, then floods it DOWN into
   the mesh (`onSignalWrap`'s downlink-bridge branch); the Pixel — relay-less
   — receives it over BLE and decrypts it.
4. Confirm dedup: the A32 must not re-publish it a second time if it also
   arrives back over BLE from another path (multi-path in a real crowd).

**Known gap in the current wiring (fix if it bites in practice):** the
downlink-bridged frame is rebuilt as `{id, pubkey, content}` — it deliberately
omits `sig`, so a THIRD device that receives it over BLE and also has relay
connectivity will not additionally re-publish it upstream (its own uplink
bridge in `onBleFrame` gates on `typeof ev.sig === 'string'`). This is a minor,
accepted degradation for v1 (the wrap still decrypts and renders fine via
`giftUnwrap`, which never needed `sig`) — note whether it matters in practice
before spending effort threading a real signature through.

### 4. Multi-hop relay depth (3 devices — the genuine gap)
1. Three phones (A32, Pixel 10 Pro, + the borrowed third), all networking OFF,
   same circle, crowd mesh on all three.
2. Arrange them so **A and C are NOT in direct BLE range of each other**, but
   both are in range of B (a physical line: A — B — C).
3. A sends a buzz. **Expected:** B relays it (flood, hop count `h`
   decrementing per `BLE_MESH_HOPS = 3`), and C receives + decrypts it despite
   never having a direct link to A.
4. Confirm the reverse direction (C → A via B) and check hop-count behaviour
   at the boundary (does a 4th hypothetical hop get dropped once `h` reaches
   0? — can't fully test with only 3 devices, but confirm the counter is
   decrementing as expected in `adb logcat`).

## Tuning follow-ups to log, not fix blind

- **Reconcile timing.** There is deliberately no polling timer
  (battery-is-a-feature). If the `peer` route edge is missed, the first valid
  inbound frame also starts a bounded manifest round. Log any device where
  neither trigger occurs; do not add a blind JS interval.
- **GrapheneOS address rotation** was already flagged in the BLE-nearby doc as
  producing redundant client links (a peer appears under ~3 rotating
  addresses); check whether that churn gets worse now that a reconnect also
  triggers a re-flood.
- **Buffer size in practice.** 200 wraps / 15 min are the design doc's
  defaults (`MESH_BUFFER_DEFAULTS`) — sanity-check they're the right order of
  magnitude for a real festival-sized crowd's traffic volume, not just a
  round number.

## Acceptance

- §1 (retention), §2 (real manifest reconciliation), and §3 (downlink bridging) pass on the existing 2-device pair
  — these are the sessions that actually validate the shipped Task A code.
- §4 (multi-hop) passes once a third device is available — tracked, not
  blocking Task A's completion (the design doc already carried this gap
  forward from the single-hop validation).
- Any fail mode gets a follow-up commit with its own test where the logic is
  pure enough to unit-test, or a native-side fix + a note here if it's a
  genuine hardware/radio issue.
