# BLE-nearby transport — design

**Status:** design, 2026-07-04. First rung of the off-relay transport ladder
(roadmap Phase E: `mesh-kit` / `mesh-webrtc-lan` / LoRa). Grounded in a survey of
the sibling repos `meatchat`, `mesh-kit`, `mesh-webrtc-lan`, `intermesh-plans`.

## Goal

Let circle members who are **physically near each other** exchange flock signals
**directly, phone-to-phone, over Bluetooth LE** — no relay, no cell, no internet.
The flagship first use is **festival "find each other"**: co-located members
sharing exact-spot beacons with **zero relay traffic** (the minimal-footprint
north star made literal, and the coercion story too — the relay can't track what
it never sees).

## Why BLE-nearby before LoRa

Same seam, but BLE reaches users **today with no extra hardware** (every phone
has it), and flock's highest-value moments are co-located groups (festival, hike,
night out, jammed-cell protest) — exactly BLE's range. Building it also de-risks
LoRa: LoRa is "BLE-nearby but the local hop is a paired radio," so the mesh
plumbing (transport seam, chunking, dedup, membership discovery) is shared.

## The transport ladder

gift-wrap-everything already made flock **transport-agnostic** — every signal is
an opaque NIP-59 `kind:1059` wrap addressed to a rotating inbox key. A transport
is just "a way to move opaque bytes." The device prefers, in order:

1. **BLE-nearby** — a circle member in range → deliver directly. Zero relay,
   zero internet, works with no signal.
2. **LoRa mesh** *(later)* — off-grid, out of BLE range, radio paired.
3. **Nostr relay** *(today)* — global reach, online fallback.

Same bytes at every rung; a wrap arriving via two rungs dedups by Nostr event id
(flock's pool already dedups multi-relay delivery — reuse that seen-set).

## Safety — do not break what flock does today (the top constraint)

BLE is **strictly additive**. The relay path every field user runs stays exactly
as it is. Non-negotiable guarantees:

- **Native-only + opt-in + off by default.** The web PWA can't do BLE at all, so
  every PWA user is byte-for-byte unaffected. On the APK, BLE sits behind a flag,
  **off** until explicitly enabled — so even native users are unaffected until
  they opt in.
- **The relay path is not refactored — BLE taps in *beside* it.** We do **not**
  rewire `publishSigned`/`subscribeGiftWraps`/`onIncoming`. A BLE publisher fires
  *alongside* the relay publish (never instead of); a BLE subscriber feeds the
  **same** `onSignalWrap` pipeline. Existing relay code is untouched.
- **No protocol change.** BLE carries the same opaque `kind:1059` wraps into the
  same `giftUnwrap → onIncoming` path. Old installs and the relay see nothing new.
- **Relay is never gated on BLE.** A relay publish/subscribe never awaits or
  depends on BLE. If BLE is off / missing (older shell) / permission-denied /
  adapter-off / peerless, it is a silent no-op — exactly how `notifyIfHidden`
  degrades. The relay carries everything, as today.
- **Double-delivery guard.** A `seenWrapIds` set makes a wrap deliver once even if
  it arrives on both BLE and relay — and defensively hardens the existing
  multi-relay path too.
- **e2e is the regression gate.** flock's suite drives real relay round-trips
  between two browsers; the full suite runs before and after every step. If the
  relay path shifts at all, it fails — no BLE step merges without it green.
- **Revertible in slices.** Each phase is its own commit (BLE tap, plugin behind
  the flag, festival wiring). Any can be reverted without touching the others;
  relay-only is always the fallback.

## Two modes: discreet (default) + crowd mesh (2026-07-04 decision)

The spike proved 1-circle point-to-point delivery, but the real target is a
crowd: N co-located people across M **overlapping** circles (5 in A, 5 in B, 3 of
each also in C). That breaks a per-circle-UUID point-to-point model three ways:
a BLE advert (~31 B) barely holds ONE 128-bit UUID (can't advertise M circles);
two people sharing circle C but scanning different active-circle UUIDs never find
each other; and 10 people ≠ 10 GATT links (BLE caps ~7 connections → needs
relaying, not full mesh). So BLE-nearby has **two modes**:

- **Discreet (default).** Per-circle rotating advertId (`bleId.ts`), the ACTIVE
  circle only, single-hop, members-only discovery. **Zero presence leak** — a
  scanner can't even tell flock is present. For everyday "me + a mate".
- **Crowd mesh (opt-in, tied to festival / "Find each other").** A **common**
  flock discovery UUID so ANY two flock phones in range connect regardless of
  circles; messages stay opaque `kind:1059` wraps that **flood + relay** across
  the crowd; each device **decrypts every circle it's in** and blindly relays the
  rest. Overlapping circles + sub-group bridging fall out for free (a relayer
  can't read what it forwards). This is the multi-hop mesh meatchat/mesh-kit punted.

**The unavoidable tradeoff (accepted):** a cross-circle mesh needs a *common*
discovery identifier — so a passive scanner learns "a flock device is nearby"
(never who / which circle / what; proximity-only ~10–100 m). You cannot have both
"hide flock's presence" AND "mesh across circles that share no secret". Mitigate:
the common UUID rotates on a **coarse public epoch** (daily) — `meshUuid =
uuid(HKDF("flock-ble-mesh-v1", floor(now/86400)))`, no secret, every device
computes the same per day → discoverable but not a permanent beacon; plus OS MAC
randomisation. The leak only happens in **crowd mode**, which is coupled to the
explicit "I'm in a crowd" festival signal.

**Mesh mechanics (crowd mode):**
- Discovery: advertise + scan the common daily `meshUuid`. `room = meshUuid` so the
  plugin's room check passes for all participants.
- Envelope gains a **TTL/hop** byte (absent today). Flood: on an unseen frame →
  try-decrypt-all-my-circles (render if one works) → re-broadcast to my *other*
  links with TTL−1. Dedup by message id (`seenIds`, already present) stops loops.
- **Connection cap**: initiate at most K (≈4) GATT client links; flooding gives
  reach past directly-connected peers. Role **arbitration** (below) halves links.
- Decrypt-all-circles is a JS change (`onBleFrame` → try every circle's inbox key,
  like the relay multi-inbox subscription), and applies in both modes.

**Slicing:**
1. **Harden the connection layer (both modes):** role arbitration (advertised
   tiebreak → only the higher side initiates, kills dual-role glare / "out of
   resources"), reconnect backoff, and native logging. *(This slice — the spike's
   churn fix; foundational for the mesh.)*
2. **Mesh transport:** common daily `meshUuid`, TTL envelope + flood/relay,
   connection cap, a mode flag from JS.
3. **JS integration:** `syncBle` picks discreet vs mesh (festival active →
   mesh); `onBleFrame` decrypts across all circles; wire festival → crowd mode.
4. **Validate on-device** (multi-hop truly needs ≥3 phones; 2 proves mesh-mode
   delivery + decrypt-all-circles, not relay depth — log the gap).

## Reuse map (from the survey)

| Piece | Verdict |
|---|---|
| `mesh-kit` `MeshTransport`/`MeshFrame` 3-method interface (`broadcast`/`send`/`subscribe`, opaque `payload`) | **Reuse** — the transport seam. Tiny, zero-dep. |
| `meatchat/app/src/core/transport.ts` "one interface, N transports behind a mode enum" | **Reuse the pattern.** |
| meatchat's bespoke native plugin (`MeatchatNativeBle`, dual-role central+peripheral, Android Java + iOS Swift; **no off-the-shelf Capacitor BLE plugin**) | **Fork/adapt** — ~80% reusable; it already advertises as a GATT peripheral, scans as central, chunks for MTU. |
| Chunking pattern (magic+ver+msgId+idx/total header, MTU-probed payload, 30 s reassembly TTL) | **Reuse the pattern**, not the bytes (see envelope note). |
| meatchat discovery identity (**static** service UUID + `SHA-256('ambient:nearby')` scan-response) | **Do NOT copy** — a stable, trackable beacon. meatchat's own `identity.ts:78-82` concedes transport-layer unlinkability is unsolved. **This is flock's design work.** |
| meatchat envelope (raw → base64 → JSON `{v,r,t,f,id,d}` → UTF-8 → chunk) | **Do NOT copy** — ~33 %+ overhead, and flock wraps are already JSON/base64; stacking compounds. Use a **flat binary chunk envelope**. |
| multi-hop store-and-forward | **Nobody built it** (mesh-kit + both native plugins explicitly punt). flock v1 is **single-hop**; multi-hop is a later design. |

## The load-bearing decision: a rotating, members-only advertising identity

A BLE advertisement with a *stable* identifier is a physical-world device tracker
— **worse** than the relay flock exists to avoid. meatchat leaves this unsolved;
flock must not.

**Design:** the advertised 128-bit service UUID is **derived from the circle seed
and the current time window**, so only circle members can compute or recognise it,
and it changes every window:

```
window   = floor(now / WINDOW_SECONDS)          // WINDOW_SECONDS ≈ 900 (15 min)
advertId = uuid(HKDF(circleSeed, "flock-ble-adv" || window)[0..16])
```

- **Advertise** `advertId(activeCircle, now)` — one UUID at a time (the circle
  that has "find each other" active; festival-first means normally exactly one).
- **Scan-filter** on the set `{ advertId(c, w) : c ∈ my circles, w ∈ {t-1, t, t+1} }`
  (±1 window for clock skew). A match ⇒ the peer is in circle `c` ⇒ connect.
- To any **non-member** the advert is a random 128-bit value that **rotates every
  window and is unlinkable across windows** (HKDF output is unpredictable without
  the seed) — no stable tracker, and it doesn't even announce "a flock device is
  here" (no fixed flock UUID). Combined with OS BLE MAC randomisation (both
  platforms) there is no stable identifier at any layer.

**Trade-off, stated:** a rotating members-only UUID means a **non-member cannot
discover us to relay our opaque bytes onward** — so it is incompatible with
future *multi-hop-by-strangers*. That is the right v1 posture (single-hop,
members-only, presence-hiding). If/when multi-hop reach matters more than hiding
app-presence, revisit with a fixed flock UUID + in-GATT membership proof. Noted,
not now.

**Hardening follow-up:** the rotating UUID proves membership at discovery, but a
sniffer who captured the current-window UUID could connect. Wraps are opaque
(NIP-59), so a false connector only ever gets ciphertext — acceptable for v1. Add
a challenge-response proving seed knowledge before exchange as a follow-up.

## Wire format

- flock signals ride as `MeshFrame { kind: 'wrap', payload: <the kind:1059 event>, from? }`.
- **Flat binary chunk envelope** (not meatchat's double-encode): `[magic:1][ver:1]
  [msgId:4][idx:1][total:1][payload…]`; MTU-probed payload size (iOS
  `maximumWriteValueLength`, Android request MTU 247); reassembly keyed
  `peer:msgId`, dropped after 30 s. Payload is the serialised wrap bytes.
- On receive: reassemble → hand the wrap to the **existing**
  `onSignalWrap → giftUnwrap → onIncoming` pipeline. A wrap not for us fails
  `giftUnwrap` silently (already the case). **No protocol change** above the
  transport.

## flock integration

- **Additive, not a refactor.** The existing relay calls stay as they are. BLE is
  a *parallel* publisher (fires alongside the relay publish) and a *parallel*
  subscriber (feeds the same `onSignalWrap`), guarded by a `seenWrapIds` dedup so
  a wrap delivers once. No `TransportPool` rewrite of the live path in v1 — the
  clean `Transport` interface can come later once BLE has proven itself; today's
  priority is zero risk to the relay path.
- **Native plugin** `FlockBle` (Capacitor), adapted from meatchat's plugin:
  Android first (`native/android-src/`, injected by `patch-android.mjs` like
  `FlockNotifyPlugin`), dual-role advertise+scan+GATT, **rotating advertId**, flat
  binary envelope. iOS later. Permissions: `BLUETOOTH_ADVERTISE`, `BLUETOOTH_SCAN`
  (with `neverForLocation` where possible), `BLUETOOTH_CONNECT`.
- **Festival wiring:** when "find each other" is on, the exact-spot beacon
  publishes via the pool → BLE delivers to in-range members with no relay; relay
  is the fallback. Battery-gate advertise/scan to sharing + festival/off-grid.

## Hard limits (carry into every discussion)

- **Native-only.** Web Bluetooth is central-only (can't advertise) and iOS Safari
  has none — a PWA can never be a BLE peripheral. BLE-nearby is an **APK feature**,
  like background geofencing. GrapheneOS-fine (pure AOSP Bluetooth, no Google).
- **Two physical devices to validate** — one advertising, one scanning. Have: A32
  on adb; Pixel 10 Pro on adb (per notes). Emulators can't do BLE.
- **Foreground v1.** meatchat's field test was foreground-only; backgrounded BLE
  advertising/reconnect/battery is an unsolved hard problem everywhere — defer.
- **Single-hop v1.** Multi-hop store-and-forward is a later design.
- **iOS later.** Android ships first (as flock already does).

## Phasing

1. **Spike** — fork meatchat's Android plugin as `FlockBle`, swap in the rotating
   advertId + flat envelope; prove two-device discovery + one opaque wrap
   delivered phone-to-phone (A32 ↔ Pixel).
2. **Transport seam** — `Transport` interface + `RelayTransport` + `TransportPool`
   (dedup by event id); relay path unchanged behind it.
3. **BleTransport** — the plugin behind the seam; publish/subscribe opaque wraps.
4. **Festival wiring** — prefer BLE for exact-spot beacons; relay fallback;
   battery-gate. On-device validation on two Androids.
5. **Later** — iOS, multi-hop, then the LoRa bearer on the same stack.

## Open decisions for sign-off

- **A. Discovery identity:** rotating circle-derived UUID (recommended — members
  only, unlinkable, presence-hiding) vs a fixed flock UUID (enables future
  stranger multi-hop but leaks "flock user here"). → **rotating for v1.**
- **B. Native plugin:** fork/adapt meatchat's bespoke plugin (fast, ~80 % reuse)
  vs write fresh. → **fork/adapt.**
- **C. v1 scope:** festival "find each other" (exact-spot beacons over BLE),
  single-hop, Android, foreground. → **agreed.**
