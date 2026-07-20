// flock PWA — UI controller. Vanilla TS, render-on-state. Wires the flock
// library (decideEmission → build signal) to real Nostr publish/subscribe.

import * as store from './store'
import * as svc from './services'
import { makeLocalSigner, makeSignetSigner, type FlockSigner } from './signer'
import { buildSignInOptions } from './signin'
import { PRIVATE_RELAYS, ONION_RELAYS, parseRelayList, unknownRelays, effectiveRelays } from './relays'
import {
  WORD_INVITE,
  buildWordInviteDeletion,
  buildWordInviteRef,
  deriveCircleSeed,
  deriveInbox,
  deriveWordCodeSeed,
  newWordCode,
  normaliseWordCode,
  personalInboxTag,
  readWordInviteRef,
  suggestWords,
  wordInviteParkKey,
  wordInviteTag,
} from '@forgesworn/covey-kit'
import { giftWrap, giftUnwrap, rawNip44Decrypt, rotationDue, refreshDue } from '@forgesworn/roost-kit'
import { getProfile, fetchProfiles } from './profiles'
import { encode, decode, bounds, precisionToRadius } from 'geohash-kit'
import { shouldEmitBeacon, hasMoved, nextPollDelaySeconds, jitteredSeconds, shouldEmitCover, type BeaconCadence } from './cadence'
import { shouldRing, RING_VIBRATION } from './ring'
import { PIN_KINDS, PIN_KIND_LIST, pinLabel as pinKindLabel, isPinKind, buildPinSignal, decryptPin, withPin, type Pin, type PinKind } from './pin'
import { openRadar, closeRadar, radarBeaconLanded } from './radarMode'
import { memberHue, nameInitials } from './avatar'
import { shouldAnswerFindPing, withinPingRateLimit, FIND_PING_CANCEL_SECONDS, FIND_PING_MIN_GAP_SECONDS } from './findping'
import { advertIdNow, meshUuidNow } from './bleId'
import { classifyScan, shouldOfferAppHandoff } from './joinassist'
import qrcode from 'qrcode-generator'
import { npubEncode } from 'nostr-tools/nip19'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { MapView, MapPoint, DroppedPinPoint } from './map'
import { bboxContains, type BBox } from './area'
import { isNativeShell, shareOrigin, isApkUpdateAvailable } from './native'
import { buildInviteWrap, buildReseedWraps, readInvite, readInviteViaRef, buildDmWrap, readDmWrap, buildPrivateLocationWrap, readPrivateLocationWrap, type DirectMessage, type PrivateLocationShare } from './invite'
import { exportBackup, importBackup, applyBackup } from './backup'
import { newSalt, deriveDecoyKey, sealState, openState, dummyWork } from './decoy'
import { generateStorageSecret, setupPin, unlockWithPin, unlockWithGrace, burnLock } from './lock'
import { hasLegalAcceptance, recordLegalAcceptance } from './legalAcceptance'
import {
  decideEmission,
  haversineMetres,
  signalTypeForReason,
  buildLocationSignal,
  classifyPresence,
  buildBuzzSignal,
  decryptBuzz,
  RING_LOST_PHONE_LABEL,
  GROUP_COORDINATION_ACTIONS,
  DIRECT_COORDINATION_ACTIONS,
  coordinationLabel,
  coordinationActionFromLabel,
  isGroupCoordinationAction,
  isDirectCoordinationAction,
  buildDisbandSignal,
  decryptDisband,
  DISBAND_SIGNAL_TYPE,
  buildJoinedSignal,
  decryptJoined,
  JOINED_SIGNAL_TYPE,
  buildLostSignal,
  decryptLost,
  LOST_SIGNAL_TYPE,
  buildFindPingSignal,
  decryptFindPing,
  FIND_PING_SIGNAL_TYPE,
  deriveBeaconKey,
  decryptBeacon,
  type MemberBeacon,
  type LostReport,
  type GroupCoordinationAction,
  type DirectCoordinationAction,
} from '@forgesworn/flock'

// ── State ──────────────────────────────────────────────────────────────────
let persisted = store.load()
let legalAccepted = hasLegalAcceptance()
let tab: 'home' | 'chat' | 'circle' | 'you' = 'home'
let fix: svc.Fix | null = null
// Location is private by default on every launch. Sharing begins only after a
// deliberate tap and remains session-only, so closing/reopening returns to off.
let sharing = false
let geoIssue: 'denied' | 'nofix' | null = null // actionable location trouble shown as a card, not a toast
let stopWatch: (() => void) | null = null
let hidden = false // app backgrounded (page hidden) — pause sampling; a hidden PWA can't sample reliably anyway
const subs = new Map<string, () => void>() // circleId@relay@inboxPk → unsubscribe (one per circle)
// Pool-staleness recovery: a gift-wrap arriving on the relay pool proves it's live,
// so we only REBUILD the pool (the heavy, connection-churning recovery) when none
// has arrived in a while. This keeps an active conversation churn-free (fast) while
// still healing a genuinely dead pool. See recoverIfStale / resubscribe.
let lastWrapAt = 0 // unix-sec of the last wrap the relay delivered (0 = none yet)
let lastPoolReset = 0 // unix-sec of the last pool rebuild — a cooldown so recovery can't hammer reconnects
const POOL_STALE_SEC = 60 // no wrap for this long ⇒ suspect a dead pool
const POOL_RESET_COOLDOWN_SEC = 60 // rebuild the pool at most this often on the stale path
// Last automatic beacon per circle — drives the movement-aware re-emit gate so a
// stationary member (identical geohash cell) doesn't keep waking the relays.
const beaconCadence = new Map<string, BeaconCadence>()
// Automatic-emit cadence (seconds). Heartbeats stay well under the 600s presence
// "stale" window, so a still member keeps reading as "active" without spamming.
const COARSE_MIN_INTERVAL = 45 // never faster than this
const COARSE_HEARTBEAT = 300 //  …but re-affirm presence every 5 min when still
// Timing hygiene (audit F1): jitter softens the exact 45s/300s periods; cover
// traffic narrows the ~6x moving-vs-still swing with a low-rate decoy publish
// that fills the quiet stretch between heartbeats (@forgesworn/flock/signals `cover` type
// — wire-identical, discarded unread by every receiver). Math.random() here
// mirrors giftwrap.ts's own NIP-59 timing blur (non-secret, purely obfuscating
// a fixed schedule).
const CADENCE_JITTER_FRACTION = 0.2
const COVER_INTERVAL_SECONDS = 90 // between the move floor and the still heartbeat
// Last cover-traffic publish per circle — session-scoped is enough, a restart
// just resumes the low-rate drip promptly (mirrors beaconCadence's reset-on-restart).
const coverCadence = new Map<string, number>()
// Adaptive sampling: back off the GPS poll when stationary, staying under the
// 600 s presence "stale" window so a still member never reads as "gone home".
const SAMPLE_POLL_BOUNDS = { minSeconds: 30, maxSeconds: 180 }
const SAMPLE_MOVE_FLOOR = 30 // metres of jitter to ignore before calling it movement
let lastSampleFix: svc.Fix | null = null
let stationaryStreak = 0
let root: HTMLElement
// The incoming-buzz banner lives in its OWN layer, a sibling of `root` that a
// full render() never touches. That way rapid buzzes update it in place instead
// of a render tearing it down and replaying its entrance animation every tick.
let bannerLayer: HTMLElement
// Modal overlays (the private-chat sheet, the long-press circle menu) live in
// this sibling layer for the SAME reason: a full render() rewrites root.innerHTML,
// which used to drop the open sheet and re-mount it — replaying its slide-up
// entrance every background tick (the "DM screen flicker"), and wiping whatever
// was half-typed. Kept outside root, the sheet survives renders untouched; only
// open/close and an in-place thread refresh ever touch it.
let overlayLayer: HTMLElement
let toastTimer = 0

let mapView: MapView | null = null
let mapInitToken = 0
// Where the map last sat, kept across a tab switch so returning to Home reopens
// that view instead of re-painting the London default and animating back (the
// map is destroyed off Home and rebuilt on return — see render/initMap).
let lastCamera: { lng: number; lat: number; zoom: number } | null = null
let offlineBBox: BBox | null = null // bounds of the active circle's saved map (null = not offline)
let focusMemberPk: string | null = null // "see on map" target — frame their cell once the map mounts
let focusGeohash: string | null = null // a one-off PM location share's cell — not a live circle beacon, framed once then forgotten

let stopInviteSub: (() => void) | null = null
let inviteSubKey = ''
let pendingInviteNpub: string | null = null // a scanned invite-key link, prefilled into the send form
let showInviteLinkText = false // clipboard copy failed — render the link as selectable text instead
let showInvite = false // Circle page: the top "Invite" button reveals the QR + link panel
let spokenCode: string[] | null = null // the live 6-word invite code, once generated + parked
let spokenCodeBusy = false // deriving/publishing a spoken code (scrypt + relay round-trip)
let updateAvailable = false // native shell only: the hosted deploy is newer than this build
let pendingJoin: store.Circle | null = null // a link/QR join awaiting the guest's name (join-name screen)

/** Compare this build's stamp against the latest PUBLISHED APK's build
 *  (downloads/apk.json), NOT the website deploy — the site redeploys on nearly
 *  every commit but a new APK ships far less often, so comparing to /version.json
 *  nagged "update available" after every content deploy (see isApkUpdateAvailable).
 *  Only the download-page nudge on Home hangs off it — never an auto-update.
 *  Always re-verifies rather than latching true forever: a build published
 *  while this session was already flagged (or one that gets rolled back to
 *  match) must be able to clear the nudge again, not just set it once. */
let lastUpdateCheck = 0
async function checkForUpdate(): Promise<void> {
  // A backgrounded WebView suspends timers, so the 6-hour interval is unreliable;
  // the resume/visibility hooks below drive most real checks. Throttle so rapid
  // foreground/background toggles don't hammer the deploy.
  const now = Date.now()
  if (now - lastUpdateCheck < 20_000) return
  lastUpdateCheck = now
  try {
    const res = await fetch(`${shareOrigin()}/downloads/apk.json`, { cache: 'no-store' })
    if (!res.ok) return // no APK published yet (or offline) → leave the current state as-is
    const v = (await res.json()) as { build?: string }
    const next = isApkUpdateAvailable(__FLOCK_BUILD__, v.build)
    if (next !== updateAvailable) { updateAvailable = next; render() }
  } catch { /* offline — checked again on the next boot, resume, or 6-hour tick */ }
}
let showAdvanced = false // You-tab advanced settings fold (session-only)
let showSettings = false // You-tab settings fold (session-only) — You leads with you, not dials
let awaitSince = 0 // when the remote-invite wait began — drives the 'still waiting' guidance
const AWAIT_GUIDE_MS = 60_000
let monitorTimer = 0
// The one live incoming alert shown as the top banner. A shared-inbox buzz (whole
// circle) or a private direct message (just me) — `private` flips the styling and
// copy so a 1:1 message never reads as a circle-wide buzz.
let activeBuzz: { from: string; reason: string; mine: boolean; circle?: string; private?: boolean } | null = null
// Rapid buzzes COALESCE into the one banner (buzzCount = how many are represented,
// shown as a "+N" pill) rather than thrashing one over another, and the banner
// auto-dismisses after a quiet spell so it never lingers. buzzTimer is the rolling
// dismiss; re-armed on each new buzz.
let buzzCount = 0
let buzzTimer = 0
const BUZZ_LINGER_MS = 6000
// Set on THIS phone when the circle is ringing it to find it (it's flagged lost
// and a member buzzed it). Drives the loud "being rung" card on Home; recent-only
// so a ring from an hour ago doesn't read as sounding right now. See app/src/ring.ts.
let beingRung: { circleId: string; by: string; at: number } | null = null
const RING_DISPLAY_WINDOW = 90 // seconds the "being rung" card stays loud after a ring
function ringingBy(circleId: string): string | null {
  if (!beingRung || beingRung.circleId !== circleId) return null
  if (nowSec() - beingRung.at > RING_DISPLAY_WINDOW) return null
  return beingRung.by
}
// Remote exact ping ("find my phone"): a qualifying request opens a cancel window
// on THIS phone (the owner's veto) before it answers with a one-shot exact fix.
let findPingPending: { circleId: string; from: string; deadline: number } | null = null
let findPingTimer = 0
// Per-circle clock of when we last answered a find-ping — rate-limit (in-memory).
const pingAnsweredAt = new Map<string, number>()
// Native only: is flock allowed to bypass Do Not Disturb (so "Make it ring"
// sounds in full DND)? null = not yet checked. Refreshed on the You tab and on
// return-to-foreground (e.g. back from the settings screen).
let dndAccess: boolean | null = null

// BLE-nearby: true while the off-relay Bluetooth transport is running. STRICTLY
// ADDITIVE — every BLE path is gated on this, so with it false (the default, and
// always on web/e2e) the relay path is byte-for-byte unchanged. `bleMode` is the
// active discovery mode: 'discreet' (per-circle rotating advertId, single-hop,
// zero presence leak — the default) or 'mesh' (common daily UUID, flood/relay
// across circles, tied to festival). See docs/plans/2026-07-04-ble-nearby-transport.md.
let bleActive = false
let bleMode: 'discreet' | 'mesh' = 'discreet'
// Crowd-mesh flood budget: how many extra hops a wrap is relayed past its first
// recipient. 3 covers a large room via a couple of intermediaries without letting
// traffic churn indefinitely (the native plugin also dedups by id + clamps hops).
const BLE_MESH_HOPS = 3
// Wraps already handled this session, so a wrap arriving via BOTH relay and BLE
// is processed once. Only consulted while BLE is active (bleActive), so it can
// never alter the relay-only path.
const seenWrapIds = new Set<string>()
function markWrapSeen(id: string): boolean {
  if (seenWrapIds.has(id)) return false
  seenWrapIds.add(id)
  if (seenWrapIds.size > 1000) seenWrapIds.delete(seenWrapIds.values().next().value as string)
  return true
}
// Crowd mode adds mesh-kit's bounded reconciliation in native/ble.ts: opaque
// signed gift wraps are retained for at most 15 minutes (200 entries), while
// room-scoped inventory tokens and a learned peer-route event recover missed
// wraps as soon as a later phone arrives. Discreet mode remains live single-hop.
// The open private-chat thread sheet, when any: the peer's pubkey. Mounted as an
// overlay (like the old compose sheet) so opening it never tears the map.
let dmPeer: string | null = null
// Native only: is flock exempt from Doze battery optimisation? Without it Android
// suspends the WebView's relay connection minutes after the screen locks — fixes
// keep arriving from the foreground service, but nothing can be PUBLISHED, so the
// circle silently stops seeing you. null = not yet checked (or web).
let batteryExempt: boolean | null = null
let batteryAsked = false // shown the system exemption dialog this session — don't re-nag
// A pending roll-call ("checked in — where is everyone?") awaiting MY answer.
// Only ever answered by an explicit tap; expires quietly (see LOC_ASK_WINDOW_SEC).
let locAsk: { circleId: string; from: string; at: number } | null = null
const LOC_ASK_WINDOW_SEC = 15 * 60
// Only a FRESH incoming message rings/notifies — a relay replaying history on a
// re-subscribe (reconnect, reboot) must repopulate the thread silently.
const MSG_FRESH_SEC = 3600
// Long-press-a-chip action sheet, when open: the id of the circle it acts on. Like
// compose, mounted as an overlay so it survives the re-renders around it.
let circleMenu: string | null = null
// Set the instant a long-press fires so the click that trails the press-and-hold
// doesn't ALSO switch to that circle. Cleared on a timer in case the click never lands.
let chipHeldGuard = false

let onboardStep: 'intro' | 'create' | 'join' | 'await' | 'restore' = 'intro'
let adding = false // adding another circle from within the app (not first-run onboarding)
let ttlMode: 'ongoing' | 'today' | 'custom' = 'ongoing' // chosen lifetime for a new circle
// The location posture + detail chosen for the circle being created/joined. Private
// (disclosure-on-event) is the safety-first default; the user picks explicitly.
let onboardTracking: 'always' | 'private' = 'private'
let onboardPrecision = 6 // geohash precision my shares default to (= PRECISION_DEFAULT, inlined — declared later)
let pinsOpen = false // the pins list sheet is open
let placing = false // placement mode: a finger-draggable pin is on the map
let placingKind: PinKind = 'meet' // the kind the draggable pin will drop
let placingPos: { lat: number; lon: number } | null = null // the draggable pin's live spot (full precision)
let editingPinId: string | null = null // when set, placement is MOVING this existing pin (not dropping a new one)
let removingPinId: string | null = null // when set, placement is a remove-only prompt for SOMEONE ELSE'S pin
let disbandConfirm = false // inline confirm for the destructive "disband for everyone"
let resetConfirm = false // inline confirm for the destructive "sign out & reset this device"
let removeConfirmPk: string | null = null // member pk pending an inline remove confirm
let lostConfirmPk: string | null = null // member pk pending an inline "report lost" confirm
let editingPetname: string | null = null // pubkey whose nickname is being edited inline
let expandedMemberPk: string | null = null // Circle tab: whose routine actions (message/locate/edit/remove) are revealed
let dmComeToMeArmed = false // PM "Come to me" inline confirm is open (it shares an exact spot, privately, to just this person)

// Per-circle live state — signals are circle-scoped, so beacons from one circle
// must never bleed into another. Keyed by circle id.
interface CircleState {
  beacons: Map<string, MemberBeacon>
  /** Latest lost-phone report per member (mark or clear — latest wins). */
  lost: Map<string, LostReport>
  /** Last time we heard ANYTHING from a member — a check-in/buzz counts, not
   *  just a location beacon. Reported live: "Rover checked in at 23:49 but
   *  the roster still says last seen 23:03" — a check-in only asks everyone
   *  ELSE to share, it isn't itself a location update (Rover's own pin only
   *  refreshes if he's already sharing), so his last-seen genuinely hadn't
   *  changed. That's correct for "last seen" (a location claim), but left the
   *  roster reading as if he'd gone quiet when he plainly hadn't. Never
   *  drives "last seen" (a location-specific, deliberately narrow claim) —
   *  only the presence pill, so someone active-but-not-sharing doesn't read
   *  as "no activity". */
  lastActivity: Map<string, number>
  /** Dropped pins in this circle (a member's car, a picnic spot). Latest-wins
   *  per id; a tombstone removes one. See app/src/pin.ts. */
  pins: Pin[]
}
const circleStates = new Map<string, CircleState>()
function cstate(id: string): CircleState {
  let s = circleStates.get(id)
  if (!s) { s = { beacons: new Map(), lost: new Map(), lastActivity: new Map(), pins: [] }; circleStates.set(id, s) }
  return s
}

/** The live lost report for a member in a circle, or null when not flagged. */
function memberLost(circleId: string, pk: string): LostReport | null {
  const r = cstate(circleId).lost.get(pk)
  return r?.lost ? r : null
}

// Session-scoped: has THIS phone already told the user about a member's current
// precision-jump-to-Exact stretch (see precisionJumpedToExact)? Cleared the
// moment their precision drops back below Exact, so a genuinely NEW jump later
// notifies again — but a 5-minute heartbeat at the same Exact-spot precision
// doesn't re-toast every beacon.
const exactJumpNotified = new Set<string>()

// Presence cache — mirror member beacons to localStorage so map pins survive a
// refresh / PWA relaunch (a peer's next beacon can be up to a heartbeat — 5 min —
// away, which would otherwise leave the map blank on reload). The live Map stays the
// source of truth; this just lets a fresh load rehydrate it. Pruned by age + circle
// existence in store.load(). On-device only — no new metadata leaves the phone.
function saveBeacon(circleId: string, b: MemberBeacon): void {
  cstate(circleId).beacons.set(b.member, b)
  persisted.presence[circleId] = [...cstate(circleId).beacons.values()]
  store.save(persisted)
  // An open radar tracking this member must hear about the fresh disclosure
  // NOW — with the screen locked only this event path runs, not JS timers.
  radarBeaconLanded(circleId, b.member)
}
/** Stopping sharing makes my own cached pins a stale claim of "still sharing" —
 *  drop them everywhere so my map reads honestly. Local only: publishing a
 *  "stopped" signal would leak the very metadata stopping is meant to protect. */
function dropMyPresence(): void {
  const me = persisted.identity?.pk
  if (!me) return
  for (const c of persisted.circles) {
    const st = cstate(c.id)
    if (st.beacons.delete(me)) persisted.presence[c.id] = [...st.beacons.values()]
  }
  store.save(persisted)
}
/** Forget a circle's cached pins (on reseed/leave) so stale positions never resurface. */
function dropPresence(circleId: string): void {
  if (persisted.presence[circleId]) { delete persisted.presence[circleId]; store.save(persisted) }
}
/** Restore cached pins into live state on startup so a reload doesn't blank the map. */
function rehydratePresence(): void {
  for (const [cid, list] of Object.entries(persisted.presence)) {
    const st = cstate(cid)
    for (const b of list) st.beacons.set(b.member, b)
  }
  for (const [cid, list] of Object.entries(persisted.pins ?? {})) cstate(cid).pins = [...list]
}

/** Persist a circle's dropped pins (they're ephemeral on the wire — the local
 *  cache is what survives a refresh). */
function savePins(circleId: string): void {
  persisted.pins ??= {}
  persisted.pins[circleId] = cstate(circleId).pins
  store.save(persisted)
}

/** Merge a received (or self-dropped) pin into a circle and re-render the map. */
function landPin(circleId: string, pin: Pin): void {
  const st = cstate(circleId)
  const next = withPin(st.pins, pin)
  if (next === st.pins) return // an echo / older than what we hold
  st.pins = next
  savePins(circleId)
  if (tab === 'home' && circleId === activeCircle()?.id) updateMapData()
  refresh()
}

/** Drop a pin of `kind` at a spot for the active circle. Exact by construction
 *  (precision 9). Pass `reuseId` to MOVE an existing pin (same id, newer timestamp
 *  → latest-wins replaces it everywhere). Optimistic: lands locally then publishes. */
async function dropPin(kind: PinKind, lat: number, lon: number, reuseId?: string): Promise<void> {
  const c = activeCircle()
  const id = persisted.identity
  if (!c || !id) return
  const precision = 9
  const pin: Pin = {
    id: reuseId ?? Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join(''),
    from: id.pk,
    kind,
    geohash: encode(lat, lon, precision),
    precision,
    timestamp: nowSec(),
  }
  landPin(c.id, pin) // optimistic — see sendGroupSignal
  toast(reuseId ? `Moved ${pinKindLabel(kind)}` : `Dropped ${pinKindLabel(kind)}`)
  try {
    await publishSignal(await buildPinSignal({ groupId: c.id, seedHex: c.seedHex, ...pin }), c)
  } catch { toast("Pin saved — but couldn't reach the network.") }
}

/** Retract a pin (a tombstone the circle applies latest-wins). ANY member may
 *  remove any pin — shared pins are shared housekeeping: whoever spots a stale
 *  pin clears it, from whichever phone. The tombstone's `from` is the REMOVER,
 *  not the original dropper: receivers bind `from` to the wrap's authenticated
 *  seal signer (no acting as another member), so a removal must be signed as
 *  yourself — and withPin lands it on the pin by id regardless of dropper. */
async function removePin(circleId: string, pin: Pin): Promise<void> {
  const c = persisted.circles.find((x) => x.id === circleId)
  const id = persisted.identity
  if (!c || !id) return
  const tomb: Pin = { ...pin, from: id.pk, timestamp: nowSec(), removed: true }
  landPin(circleId, tomb)
  try {
    await publishSignal(await buildPinSignal({ groupId: c.id, seedHex: c.seedHex, ...tomb }), c)
  } catch { /* the local tombstone stands; a re-broadcast can retry */ }
}

/** Enter placement mode: show a pin on the map IMMEDIATELY (at my last fix, else
 *  the map centre — never blocking on a location lookup, or there'd be nothing to
 *  grab), then long-press + drag it to the precise spot. Drop lands it there at full
 *  precision. A fresh fix, if it lands, recentres and moves the pin onto me. */
async function enterPlacement(kind?: PinKind): Promise<void> {
  if (!activeCircle()) return
  if (kind) placingKind = kind
  pinsOpen = false
  mountPinsSheet() // tear down the list sheet
  placing = true
  mountPlacement() // the aim bar + drag surface
  // Pin appears RIGHT NOW — on my last fix (recentre there) or the current centre.
  if (fix) mapView?.flyTo({ lat: fix.lat, lon: fix.lon }, { instant: true })
  const start = fix ? { lat: fix.lat, lon: fix.lon } : mapView?.center()
  if (start) raiseDraftPin(start.lat, start.lon)
  // Refresh the fix in the background; if we didn't have one and it arrives, recentre
  // and move the pin onto me — but never make the user wait to start dragging.
  if (!fix) {
    const f = await svc.currentPosition({ enableHighAccuracy: true, maximumAge: 15_000, timeoutMs: 8000 }).catch(() => null)
    if (f && placing) { fix = f; mapView?.flyTo({ lat: f.lat, lon: f.lon }, { instant: true }); raiseDraftPin(f.lat, f.lon) }
  }
}

/** Show the pin at (lat,lon); the drag-catcher overlay (mountPlacement) then drives
 *  its position as the user presses/drags anywhere over the map. */
function raiseDraftPin(lat: number, lon: number): void {
  placingPos = { lat, lon }
  mapView?.showDraftPin(lat, lon, PIN_KINDS[placingKind].glyph)
}

/** Long-press on a dropped pin. MY pin → move mode: placement seeded from the pin
 *  (its kind, at its spot), the original hidden so only the draggable copy shows;
 *  drop re-publishes it at the new spot. SOMEONE ELSE'S pin → a remove-only
 *  prompt (any member can clear a stale pin, but moving it would silently change
 *  its owner, so only removal is offered). The pin stays visible — it's the
 *  subject — and the map still pans/zooms while deciding. */
function editPin(pinId: string): void {
  const c = activeCircle()
  if (!c) return
  const pin = cstate(c.id).pins.find((p) => p.id === pinId && !p.removed)
  if (!pin) return
  pinsOpen = false
  mountPinsSheet()
  placing = true
  if (pin.from === persisted.identity?.pk) {
    editingPinId = pinId
    placingKind = pin.kind
    mountPlacement()
    updateMapData() // re-draw the pin layer WITHOUT the one we're moving
    const d = decode(pin.geohash)
    raiseDraftPin(d.lat, d.lon)
  } else {
    removingPinId = pinId
    mountPlacement()
  }
}

/** Wire the full-screen touch surface (over the map) that drives placement.
 *  It's OUR element, so maplibre's gesture handling is entirely out of the loop —
 *  every gesture the mode needs is recreated here deliberately:
 *    · press-and-HOLD (≈0.3s, a buzz) picks the pin up; drag slides it; lift sets it
 *    · a plain one-finger drag pans the MAP, so you can line up the exact spot
 *    · a two-finger pinch zooms the map around the fingers' midpoint
 *  A quick tap does nothing, so the pin is never nudged by accident.
 *  pointer-capture keeps move events flowing for every tracked finger. */
function wireDraftDrag(catcher: HTMLElement): void {
  const fingers = new Map<number, { x: number; y: number }>() // pointerId → last seen
  let firstId: number | null = null // the finger that can hold-grab the pin
  let grabbed = false
  let panning = false
  let holdTimer = 0
  let start = { x: 0, y: 0 }
  let pinchD0 = 0 // finger separation when the pinch began (0 = no pinch active)
  let pinchZ0 = 0 // zoom level when the pinch began
  const put = (e: PointerEvent): void => { const p = mapView?.moveDraftPinToClient(e.clientX, e.clientY); if (p) placingPos = p }
  const flag = (): Element | null => document.querySelector('.draft-pin')
  const grab = (e: PointerEvent): void => {
    grabbed = true
    try { navigator.vibrate?.(15) } catch { /* no haptics — fine */ }
    flag()?.classList.add('grabbed')
    put(e) // the pin comes to your finger the instant it's picked up
  }
  const release = (): void => {
    grabbed = false
    window.clearTimeout(holdTimer)
    flag()?.classList.remove('grabbed')
  }
  const two = (): { x: number; y: number }[] => [...fingers.values()]
  const pinchDist = (): number => { const [a, b] = two(); return Math.hypot(a.x - b.x, a.y - b.y) }
  catcher.addEventListener('pointerdown', (e) => {
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    try { catcher.setPointerCapture(e.pointerId) } catch { /* ok */ }
    if (fingers.size === 1) {
      firstId = e.pointerId
      panning = false
      start = { x: e.clientX, y: e.clientY }
      holdTimer = window.setTimeout(() => grab(e), 280) // hold ≈0.3s to pick it up
    } else if (fingers.size === 2 && !grabbed) {
      // A second finger → pinch-zoom, definitely not a pick-up or a pan.
      window.clearTimeout(holdTimer)
      panning = false
      pinchD0 = pinchDist()
      pinchZ0 = mapView?.zoomLevel() ?? 0
    }
  })
  catcher.addEventListener('pointermove', (e) => {
    const f = fingers.get(e.pointerId)
    if (!f) return
    const prev = { x: f.x, y: f.y }
    f.x = e.clientX; f.y = e.clientY
    if (grabbed) { if (e.pointerId === firstId) put(e); return }
    if (fingers.size >= 2) {
      if (pinchD0 > 0) {
        const [a, b] = two()
        mapView?.zoomAtClient(pinchZ0 + Math.log2(pinchDist() / pinchD0), (a.x + b.x) / 2, (a.y + b.y) / 2)
      }
      return
    }
    // One finger, no pin in hand: past the slop it's a map pan — and no longer a
    // pick-up, so a stray swipe never nudges the pin.
    if (!panning && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 12) {
      window.clearTimeout(holdTimer)
      panning = true
    }
    if (panning) mapView?.panByPixels(prev.x - e.clientX, prev.y - e.clientY)
  })
  const end = (e: PointerEvent): void => {
    if (!fingers.delete(e.pointerId)) return
    try { catcher.releasePointerCapture(e.pointerId) } catch { /* ok */ }
    if (e.pointerId === firstId) { firstId = null; release() }
    if (fingers.size === 1) {
      // Pinch down to one finger — it carries on as a plain pan.
      pinchD0 = 0
      panning = true
    }
    if (fingers.size === 0) { panning = false; pinchD0 = 0 }
  }
  catcher.addEventListener('pointerup', end)
  catcher.addEventListener('pointercancel', end)
}

/** Leave placement mode without dropping (or without moving, when editing). */
function exitPlacement(): void {
  const wasEditing = editingPinId
  placing = false
  placingPos = null
  editingPinId = null
  removingPinId = null
  mapView?.hideDraftPin()
  mountPlacement()
  if (wasEditing) updateMapData() // bring the un-moved pin back
}

/** Drop the pin exactly where it sits now (precision 9). When editing, reuse the
 *  pin's id so this MOVES it rather than adding a new one. */
async function confirmPlacement(): Promise<void> {
  const pos = placingPos ?? mapView?.draftPinPos() ?? null
  const reuseId = editingPinId ?? undefined
  placing = false
  placingPos = null
  editingPinId = null
  removingPinId = null
  mapView?.hideDraftPin()
  mountPlacement()
  if (reuseId) updateMapData() // the moved pin returns via dropPin's landPin below
  if (pos) await dropPin(placingKind, pos.lat, pos.lon, reuseId)
}

/** Switch which kind will drop, repainting the aim bar in place so the map and the
 *  pin underneath are never disturbed mid-aim. */
function setPlacingKind(kind: PinKind): void {
  placingKind = kind
  // Live-swap the icon under the finger so the map shows exactly what will drop.
  mapView?.setDraftPinGlyph(PIN_KINDS[kind].glyph)
  // Move the highlight in place rather than rebuilding the bar — a full rebuild
  // resets the icon strip's scroll to the start, hiding a chip you scrolled to reach.
  const chips = document.querySelectorAll<HTMLElement>('#pin-place-bar .pin-kind')
  if (chips.length) chips.forEach((c) => c.classList.toggle('on', c.dataset.kind === kind))
  else { const bar = document.getElementById('pin-place-bar'); if (bar) { bar.innerHTML = placementBarInner(); wirePinActions(bar) } }
}

// ── Active circle + writers ──────────────────────────────────────────────────
function activeCircle(): store.Circle | null {
  return persisted.circles.find((c) => c.id === persisted.activeCircleId) ?? persisted.circles[0] ?? null
}
/** Live state of the active circle (the one in focus). */
function active(): CircleState | null {
  const c = activeCircle()
  return c ? cstate(c.id) : null
}
function patchActive(patch: Partial<store.Circle>): void {
  const c = activeCircle()
  if (!c) return
  persisted.circles = persisted.circles.map((x) => (x.id === c.id ? { ...x, ...patch } : x))
  store.save(persisted)
}
function patchCircleById(id: string, patch: Partial<store.Circle>): void {
  persisted.circles = persisted.circles.map((x) => (x.id === id ? { ...x, ...patch } : x))
  store.save(persisted)
}
function upsertCircle(c: store.Circle, makeActive = true): void {
  const exists = persisted.circles.some((x) => x.id === c.id)
  persisted.circles = exists ? persisted.circles.map((x) => (x.id === c.id ? c : x)) : [...persisted.circles, c]
  if (makeActive) persisted.activeCircleId = c.id
  store.save(persisted)
}
function removeCircle(id: string): void {
  persisted.circles = persisted.circles.filter((c) => c.id !== id)
  circleStates.delete(id)
  beaconCadence.delete(id)
  coverCadence.delete(id)
  delete persisted.presence[id]
  if (persisted.activeCircleId === id) persisted.activeCircleId = persisted.circles[0]?.id ?? null
  store.save(persisted)
}
/** Drop transient circles whose lifetime has elapsed. Returns true if any were removed. */
function sweepExpired(): boolean {
  const now = nowSec()
  const live = persisted.circles.filter((c) => !c.expiresAt || c.expiresAt > now)
  if (live.length === persisted.circles.length) return false
  for (const c of persisted.circles) if (!live.includes(c)) { circleStates.delete(c.id); beaconCadence.delete(c.id); coverCadence.delete(c.id); delete persisted.presence[c.id] }
  persisted.circles = live
  if (!live.some((c) => c.id === persisted.activeCircleId)) persisted.activeCircleId = live[0]?.id ?? null
  store.save(persisted)
  return true
}
function switchCircle(id: string): void {
  if (!persisted.circles.some((c) => c.id === id)) return
  closeRadar() // the radar target is circle-scoped — never carry it across a switch
  persisted.activeCircleId = id
  store.save(persisted)
  disbandConfirm = false
  resetConfirm = false
  removeConfirmPk = null
  lostConfirmPk = null
  expandedMemberPk = null
  spokenCode = null // a code parked for the previous circle must not show for this one
  tab = 'home'
  syncWatch() // re-tier accuracy for the newly-focused circle's precision
  void syncBle() // BLE advertId is per-circle — re-point it at the new focus
  render()
}

// ── Helpers ────────────────────────────────────────────────────────────────
const nowSec = (): number => Math.floor(Date.now() / 1000)
const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))

function shortNpub(pk: string): string {
  try { const n = npubEncode(pk); return `${n.slice(0, 10)}…${n.slice(-4)}` } catch { return pk.slice(0, 10) }
}
function fullNpub(pk: string): string {
  try { return npubEncode(pk) } catch { return pk }
}
const initials = (pk: string): string => pk.slice(0, 2).toUpperCase()

function fmtAgo(sec: number): string {
  if (sec < 60) return 'just now'
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h ago`
  return `${Math.floor(sec / 86_400)}d ago`
}

/** Seconds from now until the next local 04:00 — the "Today" window (covers a night that runs past midnight). */
function todayWindowSec(): number {
  const now = new Date()
  const end = new Date(now)
  end.setHours(4, 0, 0, 0)
  if (end.getTime() <= now.getTime()) end.setDate(end.getDate() + 1)
  return Math.floor((end.getTime() - now.getTime()) / 1000)
}

// ── Location detail (the precision slider) ───────────────────────────────────
// The slider sets the geohash precision MY beacons carry in this circle — what
// everyone else sees. 3 (~a whole region or island, e.g. Mallorca) … 9 (~exact
// spot). It never changes what the phone samples for itself, only what leaves it.
const PRECISION_MIN = 3
const PRECISION_MAX = 9
// Start at neighbourhood detail. Exact disclosure remains available, but must
// be a deliberate choice rather than the first location a new circle receives.
const PRECISION_DEFAULT = 6
const COME_TO_ME_PRECISION = 9 // the one-shot "come to me" disclosure
const PRECISION_NAMES: Record<number, string> = {
  3: 'Region', 4: 'City', 5: 'Town', 6: 'Neighbourhood', 7: 'Street', 8: 'Building', 9: 'Exact spot',
}

// "Find each other" (festival mode): a temporary step-up to the finest detail
// flock offers — Exact spot (±~5 m) — so a group in a crowd can walk right to
// each other. This is the sharpest the slider goes, and it always reverts to
// the slider's own value on its own. A no-report place still caps it.
const FESTIVAL_PRECISION = PRECISION_MAX
const FESTIVAL_HOURS = [1, 3, 6] as const // offered windows; capped by circle expiry

/** Is "find each other" running for this circle right now? */
function festivalActive(c: store.Circle | null, now = nowSec()): boolean {
  return !!c?.festivalUntil && c.festivalUntil > now
}

/** Did a member's disclosed precision just jump to Exact spot from something
 *  meaningfully coarser? On the wire an Exact-spot beacon is indistinguishable
 *  from any other (FLOCK §6 invariant 1) — deliberately, so we can never say
 *  WHY (festival boost? "Come to me"? they moved their own slider?) — but a
 *  sudden jump with no explanation is exactly what read as unexplained/alarming
 *  in the field (a friend saw "now on exact spot" with nothing to say why).
 *  `undefined` previous precision (their very first beacon) never counts —
 *  everyone's baseline is unknown until we've actually seen it. */
function precisionJumpedToExact(prevPrecision: number | undefined, nextPrecision: number): boolean {
  return prevPrecision !== undefined && prevPrecision < PRECISION_MAX - 2 && nextPrecision >= PRECISION_MAX
}

/** The slider's own value (3–9), ignoring any festival step-up — this is what the
 *  precision control shows and edits, so a temporary boost never rewrites the base. */
function baseSharePrecision(c: store.Circle | null): number {
  const raw = Math.round(c?.sharePrecision ?? PRECISION_DEFAULT)
  return Math.min(PRECISION_MAX, Math.max(PRECISION_MIN, Number.isFinite(raw) ? raw : PRECISION_DEFAULT))
}

/** The precision my beacons ACTUALLY carry now: the slider base, raised to
 *  Exact spot while "find each other" is on (never lowered). */
function sharePrecisionOf(c: store.Circle | null): number {
  const base = baseSharePrecision(c)
  return festivalActive(c) ? Math.max(base, FESTIVAL_PRECISION) : base
}

/** The user's chosen distance units; undefined (fresh install) reads as metric. */
const distanceUnits = (): 'metric' | 'imperial' => persisted.units ?? 'metric'

/** "~600 m" / "~0.4 mi" — how closely a given precision places you, in the
 *  user's chosen units. Every user-facing distance goes through here. */
function precisionSize(p: number): string {
  return fmtDistance(precisionToRadius(p))
}

/** Format a distance in metres for display, honouring the units preference.
 *  Imperial switches to miles at 0.1 mi; below that it's feet (rounded to 10). */
function fmtDistance(metres: number): string {
  if (distanceUnits() === 'imperial') {
    const feet = metres * 3.28084
    if (feet >= 528) return `~${(metres / 1609.34).toFixed(1)} mi` // ≥ 0.1 mi
    return `~${Math.max(10, Math.round(feet / 10) * 10)} ft`
  }
  if (metres >= 10_000) return `~${Math.round(metres / 1000)} km`
  if (metres >= 1000) return `~${(metres / 1000).toFixed(1)} km`
  return `~${Math.round(metres)} m`
}

const precisionLabel = (p: number): string => `${PRECISION_NAMES[p] ?? 'Area'} · ${precisionSize(p)}`

function precisionNote(p: number): string {
  return p >= PRECISION_MAX
    ? 'Your circle sees your exact spot while you share.'
    : `Your circle sees roughly where you are — to within about ${precisionSize(p).replace('~', '')}. Never your exact spot.`
}

/** Display name for a member: my private petname → public profile (if opted-in) →
 *  a human placeholder. An npub is never shown as a person's NAME (it reads as a
 *  glitch); the 4-char tail keeps two unnamed members tellable apart. */
function nameFor(pk: string): string {
  const pet = persisted.petnames[pk]
  if (pet) return pet
  const handle = persisted.handles?.[pk] // what they call themselves (came in encrypted)
  if (handle) return handle
  if (persisted.showProfiles) { const p = getProfile(pk); if (p?.name) return p.name }
  try { return `Member ${npubEncode(pk).slice(-4)}` } catch { return `Member ${pk.slice(0, 4)}` }
}

/** The member's REAL chosen name only (petname → announced handle → opted-in
 *  profile), or '' when none is known — unlike nameFor, never a placeholder.
 *  Avatar initials and pin labels key off this so unnamed members fall back to
 *  a per-member pubkey pair instead of everyone collapsing into "ME…". */
function memberName(pk: string): string {
  return (persisted.petnames[pk] || persisted.handles?.[pk] || (persisted.showProfiles ? getProfile(pk)?.name : '') || '').trim()
}

/** Short label for a map pin: my private petname → their announced handle →
 *  public name (opted-in) → 2-char initials. Falls back to initials, never a
 *  long npub, so the pin tag stays tidy; caps a long name so one member can't
 *  stretch the tag across the map. Rendered via textContent in map.ts, so it
 *  is not (and must not be double-) HTML-escaped here. */
function pinLabel(pk: string): string {
  const name = memberName(pk)
  if (!name) return initials(pk)
  return name.length > 14 ? `${name.slice(0, 13)}…` : name
}

/** Avatar markup — a public picture (opted-in) or initials from the member's
 *  chosen name, over a stable per-member tint (same person = same colour on
 *  every phone), so "who is who" reads at a glance. `isMe` shows "You". */
function avatarHtml(pk: string, isMe: boolean, small = false): string {
  const cls = `${small ? 'avatar small' : 'avatar'}${isMe ? ' me' : ''}`
  const tint = ` style="--member-h:${memberHue(pk)}"`
  if (persisted.showProfiles) {
    const pic = getProfile(pk)?.picture
    if (pic) return `<span class="${cls}"${tint}><img src="${esc(pic)}" alt="" loading="lazy" referrerpolicy="no-referrer"/></span>`
  }
  return `<span class="${cls}"${tint}>${isMe ? 'You' : esc(nameInitials(memberName(pk), initials(pk)))}</span>`
}

/** Mirror a message to a real system notification while the app is hidden —
 *  an invisible in-app cue is exactly when the message matters (a signal
 *  arriving with the screen off). `opts` route it to the right channel (private
 *  1:1 / group / alert) with its own heading and stack. Shell only; a silent
 *  no-op in the PWA. */
type NotifyOpts = { kind?: 'dm' | 'group' | 'alert' | 'ring' | 'general'; title?: string; group?: string; sender?: string; conversation?: string }
function notifyIfHidden(msg: string, opts?: NotifyOpts): void {
  if (document.hidden && isNativeShell()) {
    void import('../../native/notify').then((n) => n.notify(msg, opts)).catch(() => { /* shell only */ })
  }
}

/** Re-read whether flock may bypass Do Not Disturb (native only); re-render only
 *  if it changed, so calling it from render() converges (no loop). */
async function refreshDndAccess(): Promise<void> {
  if (!isNativeShell()) return
  try {
    const g = await (await import('../../native/notify')).hasDndAccess()
    if (g !== dndAccess) { dndAccess = g; render() }
  } catch { /* older shell / unsupported — leave as null */ }
}

/** Open the system Do Not Disturb access screen, then re-check on return. */
function openDnd(): void {
  void import('../../native/notify').then((n) => n.openDndAccessSettings()).catch(() => { /* shell only */ })
}

// ── BLE-nearby (off-relay, native, opt-in) ───────────────────────────────────
/** Bring BLE up/down to match the opt-in flag, and pick the mode. Never throws —
 *  BLE unavailable/denied just leaves it off and the relay carries everything.
 *
 *  Two modes (docs/plans/2026-07-04-ble-nearby-transport.md):
 *   - CROWD MESH when "find each other" (festival) is on for ANY circle: advertise
 *     + scan the COMMON daily meshUuid so any flock phone in range connects, and
 *     flood wraps (hops > 0) so they bridge overlapping circles across a crowd.
 *   - DISCREET otherwise: the ACTIVE circle's rotating, members-only advertId,
 *     single-hop (hops 0), zero presence leak. */
async function syncBle(): Promise<void> {
  const c = activeCircle()
  const id = persisted.identity
  const mesh = persisted.circles.some((x) => festivalActive(x))
  const want = isNativeShell() && !!persisted.bleNearby && !!id && (mesh || !!c)
  try {
    const ble = await import('../../native/ble')
    if (want && id && (mesh || c)) {
      const uuid = mesh ? meshUuidNow(nowSec()) : advertIdNow((c as store.Circle).seedHex, nowSec())
      const hops = mesh ? BLE_MESH_HOPS : 0
      await ble.startBle({ room: uuid, selfId: id.pk, serviceUuid: uuid, hops, reconcileGiftWraps: mesh }, onBleFrame)
      bleActive = true
      bleMode = mesh ? 'mesh' : 'discreet'
    } else if (bleActive || ble.bleRunning()) {
      await ble.stopBle()
      bleActive = false
      bleMode = 'discreet'
    }
  } catch { bleActive = false; bleMode = 'discreet' /* older shell / BLE unavailable / denied — relay carries on */ }
}

// ── Tor `.onion` relay endpoint (native, opt-in, fail-loud) ──────────────────
// docs/plans/2026-07-04-mesh-bridge-goal.md Task B. Off by default; DarkFi
// reverted Tor-by-default (unreliable on mobile), so this is a deliberate user
// toggle, never automatic — and it must NEVER silently fall back to clearnet:
// the user chose the property (no IP exposure to the relay), so a route that
// isn't ready has to fail loud, not degrade invisibly.
let orbotDetected = false // refreshed on toggle-on, boot, and app-foreground — native shell only

/** Refresh whether Orbot's SOCKS proxy is reachable. Never throws; leaves
 *  orbotDetected false on the web PWA, an older shell, or any probe failure —
 *  activeRelays() below then fails loud rather than silently using clearnet. */
async function syncTor(): Promise<void> {
  if (!isNativeShell() || !persisted.torRelay) { orbotDetected = false; return }
  try {
    const orbot = await import('../../native/orbot')
    orbotDetected = await orbot.detectOrbot()
  } catch { orbotDetected = false }
}

/** The relay set for this call, honouring the Tor toggle (relays.ts
 *  effectiveRelays) — byte-for-byte `persisted.relayUrls` when Tor is off (the
 *  default, and every existing flow, untouched). THROWS when Tor is on but the
 *  route isn't ready (fail loud): callers already inside a try/catch let that
 *  surface as their existing failure toast. See the two variants below for
 *  call sites without one. */
function activeRelays(): string[] {
  return effectiveRelays({
    clearnetRelays: persisted.relayUrls,
    onionRelays: ONION_RELAYS,
    torEnabled: !!persisted.torRelay,
    orbotDetected,
  })
}

/** activeRelays(), toasting once and returning null instead of throwing — for
 *  fire-and-forget publishes with no surrounding try/catch. */
function activeRelaysOrToast(): string[] | null {
  try { return activeRelays() } catch (err) {
    toast(err instanceof Error ? err.message : 'Tor routing is on but not ready')
    return null
  }
}

/** activeRelays(), swallowing the error with no toast — for bookkeeping that
 *  runs on every render (subscription set-up); the toggle flip and the
 *  foreground refresh already own telling the user once, so this must not spam. */
function activeRelaysQuiet(): string[] | null {
  try { return activeRelays() } catch { return null }
}

/** Flip "route through Tor when available". Off by default; the Settings note
 *  labels it clearly unreliable on mobile (DarkFi's lesson) — a deliberate
 *  choice, never automatic, and the PWA copy explains it needs the app + Orbot. */
async function toggleTorRelay(): Promise<void> {
  persisted.torRelay = !persisted.torRelay
  store.save(persisted)
  render()
  await syncTor()
  toast(!persisted.torRelay
    ? 'Tor routing off'
    : ONION_RELAYS.length === 0
      ? 'Tor routing is on, but no .onion relay is set up yet'
      : orbotDetected
        ? 'Routing through Tor'
        : "Tor routing is on, but Orbot wasn't found. Open Orbot and make sure it's running.")
  render()
}

/** A wrap arrived over BLE: feed it into the SAME pipeline as a relay wrap. The
 *  crowd meshUuid carries EVERY circle's traffic (and even discreet frames may be
 *  for any circle a peer shares), so try every circle's inbox — giftUnwrap fails
 *  silently for the ones it isn't for. Dedup ONCE here (a mesh frame floods and may
 *  also arrive via relay), then dispatch per circle without re-deduping. */
function onBleFrame(data: string): void {
  let ev: { id?: unknown; pubkey?: unknown; content?: unknown; sig?: unknown }
  try { ev = JSON.parse(data) } catch { return }
  if (typeof ev?.id !== 'string' || typeof ev.pubkey !== 'string' || typeof ev.content !== 'string') return
  if (bleActive && !markWrapSeen(ev.id)) return
  const wrap = { pubkey: ev.pubkey, content: ev.content, id: ev.id }
  for (const c of persisted.circles) void dispatchWrap(c.id, wrap, deriveInbox(c.seedHex).sk)
  // BRIDGE: a wrap that reached me over Bluetooth may have come from a phone
  // with no signal — if I have connectivity, piggyback it up to the relays so
  // the rest of the circle (not in radio range) still hears it. Best-effort,
  // deduped above; relays drop duplicates by id, and the wrap is opaque
  // (kind 1059) so I re-publish nothing I can't already see on the wire.
  // Metadata cost: in crowd-mesh this links MY IP to another circle's inbox
  // tag on my relays — accepted within the festival opt-in (it IS the feature:
  // whoever has bars carries the crowd). Discreet mode only ever carries the
  // active circle's wraps, which my IP already subscribes to.
  if (bleActive && typeof ev.sig === 'string' && navigator.onLine) {
    const relays = activeRelaysQuiet()
    if (relays) void svc.publishSigned(relays, ev as never).catch(() => { /* best-effort */ })
  }
}

function toast(msg: string): void {
  // The hidden-gate also filters naturally: while the app is visible, toasts
  // stay in-app; while hidden, the only toasts firing are incoming signals
  // and timers — the ones worth waking the phone for.
  notifyIfHidden(msg)
  const t = document.getElementById('toast')
  if (!t) return
  t.textContent = msg
  t.classList.add('show')
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => t.classList.remove('show'), 2800)
}

/** A small "what & why" helper shown while learning the app. Each hint is
 *  dismissible (✕) and the whole set has a switch in settings — the calm way to
 *  explain without cluttering a practised user's screen. */
function hint(id: string, text: string): string {
  if (!store.hintShown(persisted.hints, id)) return ''
  // Class is "tip", not "hint" — "hint" reads as a form-field affordance in CSS.
  return `<div class="tip">
    <span class="tip-i">i</span>
    <span class="tip-text">${esc(text)}</span>
    <button class="tip-x" data-action="dismiss-hint" data-hint="${id}" aria-label="Got it">✕</button>
  </div>`
}

// ── Icons ──────────────────────────────────────────────────────────────────
const ICON = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5h16v10H9.5L5 19v-3.5H4z"/></svg>',
  circle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><path d="M16 5.5a3 3 0 0 1 0 5.8M16.5 20a5.5 5.5 0 0 0-3-4.9"/></svg>',
  you: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 7.7-7 9-4-1.3-7-4.5-7-9V6z"/><circle cx="12" cy="10" r="2.3"/><path d="M8.5 16.5a3.6 3.6 0 0 1 7 0"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12z"/><circle cx="12" cy="9" r="2.3"/></svg>',
}

// ── Mount / render ──────────────────────────────────────────────────────────
export function mount(el: HTMLElement): void {
  root = el
  // Persistent banner layer, outside `root` so render() (which rewrites root's
  // innerHTML) can't wipe or re-animate it. Reused across mounts.
  bannerLayer = document.getElementById('banner-layer') ?? document.body.appendChild(Object.assign(document.createElement('div'), { id: 'banner-layer' }))
  // Overlay layer for modal sheets — outside `root` so render() never tears them
  // down (and never replays their entrance animation). Reused across mounts.
  overlayLayer = document.getElementById('overlay-layer') ?? document.body.appendChild(Object.assign(document.createElement('div'), { id: 'overlay-layer' }))
  // App lock: ciphertext at rest means no state may exist in memory until the
  // PIN (or a live grace window) recovers the storage secret.
  if (store.lockedAtRest()) { void bootLocked(); return }
  bootUnlocked()
}

/** The locked boot: silent grace unlock inside the window, else the PIN screen. */
async function bootLocked(): Promise<void> {
  const secret = await unlockWithGrace()
  if (secret) {
    try {
      persisted = await store.openRest(secret)
      store.armRest(secret)
      bootUnlocked()
      return
    } catch { /* a grace secret that no longer decrypts falls through to the PIN */ }
  }
  // Locked at rest with no live session ⇒ background publish must be off — the
  // design doc's degrade-to-foreground-only rule. Cleared before the PIN screen.
  void import('../../native/publishMirror').then((m) => m.clearNativePublish()).catch(() => { /* plugin unavailable */ })
  renderLockScreen()
}

function bootUnlocked(): void {
  if (!legalAccepted) {
    // A stale native background configuration must not publish behind the legal
    // gate. Keep the join fragment intact; accepted users consume it on re-entry.
    if (isNativeShell()) {
      void import('../../native/publishMirror').then((m) => m.clearNativePublish()).catch(() => { /* plugin unavailable */ })
    }
    render()
    return
  }
  // Pause sampling when the app is backgrounded, resume when it returns — a hidden PWA
  // can't sample reliably anyway, so this is pure battery saved. `hidden` starts false
  // and only flips on a real visibilitychange, so headless/normal foreground always samples.
  document.addEventListener('visibilitychange', () => { hidden = document.hidden; syncWatch(); if (!document.hidden) void refreshDndAccess() })
  if (import.meta.env.DEV) (window as unknown as { flockSampling?: () => boolean }).flockSampling = () => !!stopWatch // e2e seam (dev only)
  watchBattery() // battery-aware sampling (conserve when low + discharging)
  rehydratePresence() // restore cached member pins so a refresh doesn't blank the map
  // Automatic seed rotation: shortly after boot (letting signer restore + subs
  // settle first), then hourly — the cadence is monthly, precision irrelevant.
  window.setTimeout(() => { void maybeRotateSeeds() }, 20_000)
  window.setInterval(() => { void maybeRotateSeeds() }, 3_600_000)
  store.save(persisted) // persist any legacy→multi-circle migration / pruning straight away
  // Mount is effectively "resuming" from whatever the native watcher did since
  // the app last ran (including a cold start after being fully killed, which
  // onForeground's resume hook never sees) — drain it here too, and queue it
  // BEFORE the first render() below: render's end-of-cycle config sync can
  // clear the native config, and the drain must be queued first so it isn't
  // racing a clear it hasn't read yet.
  void drainNativeJournal()
  // A join link (scanned QR / tapped in a chat) arrives as a #join= fragment —
  // never sent to any server. Scrub it from the address bar BEFORE anything else
  // runs: it carries the seed.
  const frag = consumeFragment()
  render()
  if (frag?.kind === 'join') joinFromLink(frag.value)
  if (frag?.kind === 'invite') inviteFromLink(frag.value)
  // Tapping a link while flock is already open is a fragment-only navigation —
  // no reload, no fresh mount — so consume those too.
  window.addEventListener('hashchange', () => {
    const f = consumeFragment()
    if (f?.kind === 'join') joinFromLink(f.value)
    if (f?.kind === 'invite') inviteFromLink(f.value)
  })
  // In the APK a tapped/scanned flock link arrives as an Android intent, not a
  // navigation — bridge it onto the same hashchange path (native/deeplink.ts).
  // And since sideloaded APKs never auto-update, quietly compare this build
  // against the hosted deploy (boot + 6-hourly) — the web app needs neither.
  if (isNativeShell()) {
    void import('../../native/deeplink').then((d) => d.watchDeepLinks())
    // Ask for notification permission NOW — asking later, from the background,
    // mid-emergency, is too late to show a prompt (native/notify.ts).
    void import('../../native/notify').then((n) => n.ensureNotifyPermission())
    // Bring the "stay reachable" service up to match the saved toggle (Signal
    // parity — receive while closed). No-op unless opted in.
    void syncStayReachable()
    // Bring BLE-nearby up to match its toggle (off-relay, additive). No-op unless
    // opted in; failures leave it off and the relay carries everything.
    void syncBle()
    // Re-check Orbot reachability to match the Tor toggle. No-op unless opted
    // in; ensureSubscriptions()/ensureInviteSub() re-run on the next render
    // regardless, so a status change here takes effect promptly.
    void syncTor().then(() => render())
    window.setTimeout(() => { void checkForUpdate() }, 15_000)
    window.setInterval(() => { void checkForUpdate() }, 21_600_000)
    // Seed the staleness clock: the pool we're about to use is freshly built, so
    // give it a grace period instead of reading lastWrapAt=0 as "stale" and
    // churning reconnects before its very first wrap has a chance to land.
    lastWrapAt = nowSec()
    // Belt-and-braces against the relay pool going quietly stale even in a long
    // CONTINUOUSLY-foregrounded session (onForeground's rebuild only fires on an
    // actual background→foreground transition, which never happens if the app was
    // simply left open). We check often (30s) but recoverIfStale only rebuilds the
    // pool when NO wrap has arrived for a while — so an active conversation keeps
    // it live and churn-free, and a genuinely dead pool is healed within ~a minute
    // (the reported symptom was "chat lags by a few minutes"). Blindly rebuilding
    // every tick — which an earlier cut did — tore down healthy sockets and made
    // delivery WORSE; this only reconnects when there's actually nothing arriving.
    window.setInterval(() => { recoverIfStale() }, 30_000)
    // The interval above is unreliable while backgrounded, so also re-check the
    // moment the user brings flock forward — a fresh deploy then shows within
    // seconds of reopening, not up to 6 hours later. Capacitor resume is the
    // robust signal; visibilitychange is the WebView-level fallback. Both are
    // throttled inside checkForUpdate. Coming forward also re-reads the battery
    // exemption (the user may just have granted it in system settings) and
    // clears delivered message notifications — the app being open IS the read.
    void import('../../native/lifecycle').then((l) => l.onResume(() => { onForeground() }))
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') onForeground()
    })
    void refreshBatteryExempt()
  }
  void restoreSignet()
}

/** Pull a #join= (circle invite — carries the SEED) or #invite= (someone's public
 *  key, to prefill the send-invite form) out of the fragment, scrubbing the address
 *  bar/history straight away. */
function consumeFragment(): { kind: 'join' | 'invite'; value: string } | null {
  const m = location.hash.match(/^#(join|invite)=(.+)$/)
  if (!m) return null
  history.replaceState(null, '', location.pathname + location.search)
  return { kind: m[1] as 'join' | 'invite', value: decodeURIComponent(m[2]) }
}

/** A scanned "invite key" QR: jump to the send-invite form with the key filled in. */
function inviteFromLink(npub: string): void {
  if (!persisted.identity || !activeCircle()) { toast('Create or join a circle first, then scan their key again'); return }
  try { store.npubToHex(npub) } catch { toast("That key doesn't look right — ask them to show the QR again"); return }
  pendingInviteNpub = npub
  tab = 'circle'
  render()
  toast('Key filled in — tap Send encrypted invite')
}

/** True when running as the installed home-screen app (PWA standalone) —
 *  the context where a join belongs, as opposed to a plain browser tab. */
const isStandaloneDisplay = (): boolean =>
  (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches) ||
  (navigator as unknown as { standalone?: boolean }).standalone === true

/** The in-app scanner, join flavour: scan the inviter's QR from INSIDE flock.
 *  This is the iPhone-PWA join path — a camera-app scan opens Safari, which
 *  keeps a different identity from the installed app (joinassist.ts). */
function openJoinScanner(): void {
  void import('./qrscan').then((m) => m.openQrScan({
    layer: overlayLayer,
    title: 'Scan their invite QR',
    hint: 'Point the camera at the invite QR on their screen.',
    onCode: (text) => {
      const scanned = classifyScan(text)
      if (scanned?.kind === 'join') { joinFromLink(scanned.code); return true }
      if (scanned?.kind === 'invite-key') return 'That’s someone’s key QR — ask them to show the invite QR from their circle instead.'
      return 'Not a flock invite — ask them to open their circle and tap Invite.'
    },
    onClosed: () => { /* the view beneath is already current */ },
  }))
}

/** The in-app scanner, key flavour: the inviter scans the guest's "Join
 *  remotely" key QR instead of typing an npub by hand. */
function openKeyScanner(): void {
  void import('./qrscan').then((m) => m.openQrScan({
    layer: overlayLayer,
    title: 'Scan their key QR',
    hint: 'Point the camera at the key QR on their screen.',
    onCode: (text) => {
      const scanned = classifyScan(text)
      if (scanned?.kind === 'invite-key') { inviteFromLink(scanned.npub); return true }
      if (scanned?.kind === 'join') return 'That’s a circle invite QR — you need THEIR key: ask them to tap “Join remotely”.'
      return 'Not a flock key — ask them to tap “Join remotely” and show the QR it makes.'
    },
    onClosed: () => { /* nothing to restore */ },
  }))
}

/** Join straight from a scanned/tapped link — the same path as a pasted code.
 *  A guest without a handle is asked for one FIRST (join-name screen): the
 *  moment they land in the circle is exactly when "who is this?" matters. */
function joinFromLink(code: string): void {
  try {
    const circle = store.decodeInvite(store.inviteCodeFrom(code))
    if (persisted.circles.some((c) => c.id === circle.id)) { switchCircle(circle.id); return }
    // ALWAYS confirm before joining — even for an already-onboarded user. A
    // tapped/scanned `#join=` link or QR must never silently enrol someone (and
    // publish their real pubkey) into a circle an attacker distributed; the
    // join-name screen is that explicit confirmation. (Previously returning users
    // — anyone with a handle — joined with no prompt at all.)
    pendingJoin = circle; render()
  } catch { toast('That join link is not valid — ask for a fresh one.') }
}

/** Stamp the joiner's own posture choices (device-local, never from the invite)
 *  onto a circle they're joining — see postureFields / onboardTracking. */
function applyJoinPosture(circle: store.Circle): void {
  circle.trackingDefault = onboardTracking
  circle.sharePrecision = onboardPrecision
}

function completeJoin(circle: store.Circle): void {
  persisted.identity ??= store.createIdentity()
  circle.members = [persisted.identity.pk]
  circle.joinedAt = nowSec() // the roster about to replay is not news — see JOIN_GRACE_SEC
  circle.pingConsent = false // remote exact location is a deliberate device-local opt-in
  applyJoinPosture(circle)
  upsertCircle(circle, true)
  announceJoin(circle)
  pendingJoin = null
  onboardStep = 'intro'
  adding = false
  tab = 'home'
  render()
  toast(persisted.myHandle
    ? `You've joined ${circle.name}`
    : `You've joined ${circle.name} — add your name under You so friends recognise you`)
}

/** The "what should they call you?" step for a link/QR guest. On a phone
 *  BROWSER this is also the rescue point: the camera opens join links here,
 *  not in the installed app (which keeps its own identity) — so offer the way
 *  across before they join in the wrong place. */
function joinNameView(c: store.Circle): string {
  const handoff = shouldOfferAppHandoff({ userAgent: navigator.userAgent, standalone: isStandaloneDisplay(), nativeShell: isNativeShell() })
  return `<main class="screen onboard fade-in">
    <img class="hero-logo" src="./icon.svg" alt="" />
    <h1>Joining ${esc(c.name)}</h1>
    ${handoff ? `<div class="note onboard-note" style="margin-bottom:14px">Already installed flock? This browser tab keeps its <strong>own separate identity</strong> — join inside the app instead: copy the invite, open flock, tap “Join a circle”, and paste it. (Or scan the QR again from inside the app.)</div>
    <div class="actions" style="margin-bottom:14px"><button class="btn" data-action="copy-join-invite">Copy the invite</button></div>` : ''}
    <p class="tagline">What should this circle call you? A first name or nickname is perfect.</p>
    <div class="actions">
      <div class="field"><label for="join-handle">Your name</label><input class="input" id="join-handle" maxlength="40" placeholder="Dave · Mum · a nickname" value="${esc(persisted.myHandle ?? '')}" /></div>
      <button class="btn primary" data-action="join-named">Join ${esc(c.name)}</button>
      <button class="btn ghost" data-action="join-skip">Join without a name</button>
    </div>
    <div class="note onboard-note">Shared only with this circle, encrypted — the servers in between never see it. Skip it and you appear as an anonymous member (you can set a name later under You).</div>
  </main><div class="toast" id="toast"></div>`
}

function wireJoinName(): void {
  root.querySelectorAll('[data-action]').forEach((node) => {
    node.addEventListener('click', () => {
      const c = pendingJoin
      if (!c) return
      const a = node.getAttribute('data-action')
      if (a === 'join-named') {
        const v = (document.getElementById('join-handle') as HTMLInputElement | null)?.value.trim().slice(0, 40)
        if (v) { persisted.myHandle = v; store.save(persisted) }
        completeJoin(c)
      } else if (a === 'join-skip') {
        completeJoin(c)
      } else if (a === 'copy-join-invite') {
        // The link form survives every messenger and pastes straight into the
        // app's Join screen (inviteCodeFrom strips it back to the code).
        void navigator.clipboard.writeText(store.inviteLink(c, shareOrigin()))
          .then(() => toast('Invite copied — open the flock app, tap “Join a circle”, and paste it'))
          .catch(() => toast('Could not copy — long-press the QR link instead'))
      }
    })
  })
}

/** Save my handle and re-announce it to every circle — the same encrypted
 *  "I'm here" a join sends, so members' rosters pick up the new name. */
function saveHandle(): void {
  const input = document.getElementById('my-handle') as HTMLInputElement | null
  const v = (input?.value ?? '').trim().slice(0, 40)
  persisted.myHandle = v || undefined
  store.save(persisted)
  for (const c of persisted.circles) announceJoin(c)
  toast(v ? `Your circles will now see you as "${v}"` : 'Name cleared — you appear as an anonymous member')
}

/** Tell the circle I exist (location-free, reveals nothing beyond what seed
 *  possession already implies). Joining is otherwise entirely local — without
 *  this, a QR/link joiner is invisible to every member until their first real
 *  signal: "my friend joined but I can't see him". Best-effort: membership is
 *  already saved locally, and they'd still appear on their first signal. */
function announceJoin(circle: store.Circle): void {
  const me = persisted.identity
  if (!me) return
  void buildJoinedSignal({ groupId: circle.id, seedHex: circle.seedHex, member: me.pk, handle: persisted.myHandle })
    .then((ev) => publishSignal(ev, circle))
    .catch(() => { /* offline — the relay-replayed wrap or first signal covers it */ })
}

// Render-on-state rebuilds the whole DOM, which used to silently discard whatever
// the user was mid-typing when an inbound signal landed (the audit's input-wipe
// bug: a buzz reason, a nickname, the relay list — gone, and the follow-up tap
// acted on the emptied field). Capture the focused field before the rebuild and
// restore value + caret + focus after. Deliberate clears are unaffected: tapping
// any button moves focus off the field, so nothing is captured.
function captureFocusedInput(): { id: string; value: string; start: number | null; end: number | null } | null {
  const el = document.activeElement
  const f = (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.id ? el : null
  if (!f) return null
  let start: number | null = null, end: number | null = null
  try { start = f.selectionStart; end = f.selectionEnd } catch { /* number inputs */ }
  return { id: f.id, value: f.value, start, end }
}

function restoreFocusedInput(keep: ReturnType<typeof captureFocusedInput>): void {
  if (!keep) return
  const el = document.getElementById(keep.id)
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return
  el.value = keep.value
  el.focus()
  try { if (keep.start !== null) el.setSelectionRange(keep.start, keep.end ?? keep.start) } catch { /* number inputs */ }
}

/** `animate` plays the fade-in on the screen — right for a deliberate navigation
 *  (tab switch, first mount), wrong for a background data refresh, where replaying
 *  it on every presence tick reads as a flash on the non-map tabs (see refresh). */
function render(opts?: { animate?: boolean }): void {
  const animate = opts?.animate ?? true
  // The map lives only on Home now (it IS Home) — tear it down everywhere else.
  // wireApp re-mounts it when we land back on Home.
  if (tab !== 'home') {
    mapInitToken++ // invalidate a lazy map mount that has not finished yet
    const mounted = mapView
    mapView = null
    rememberCamera(mounted) // reopen this view when we land back on Home
    mounted?.destroy()
    // Pins live only over the map — leaving Home cancels an in-flight placement
    // and closes the list sheet so neither lingers over another tab.
    if (placing) placing = false
    if (pinsOpen) { pinsOpen = false; mountPinsSheet() }
  }
  const keep = captureFocusedInput()
  if (!legalAccepted) {
    root.innerHTML = legalGateView()
    wireLegalGate()
    restoreFocusedInput(keep)
    return
  }
  if (persisted.identity) ensureInviteSub()
  if (pendingJoin) {
    root.innerHTML = joinNameView(pendingJoin)
    wireJoinName()
    restoreFocusedInput(keep)
    return
  }
  if (!persisted.identity || !activeCircle() || adding) {
    root.innerHTML = onboardingView()
    wireOnboard()
    restoreFocusedInput(keep)
    return
  }
  ensureMember(activeCircle() as store.Circle, persisted.identity.pk)
  ensureSubscriptions()
  ensureProfiles()
  startMonitor()
  const body = tab === 'home' ? homeView() : tab === 'chat' ? chatView() : tab === 'circle' ? circleView() : youView()
  const screenMod = tab === 'home' ? 'home-screen' : tab === 'chat' ? 'chat-screen' : ''
  root.innerHTML = `${findPingBanner()}<main class="screen ${animate ? 'fade-in ' : ''}${screenMod}">${body}</main>${navView()}<div class="toast" id="toast"></div>`
  patchBuzzBanner() // the buzz banner lives in its own layer — keep it in sync after a render
  wireApp()
  // The DM sheet + circle menu live in overlayLayer (outside root), so a render
  // no longer drops them — they persist untouched, with no re-mount and no
  // replayed entrance animation. Their content is refreshed in place at the
  // points that actually change it (updateDmThread on a new message, etc.).
  // The placement crosshair lives INSIDE the freshly-built .home-shell, so a full
  // render drops it — re-raise it if we're still aiming.
  if (placing && tab === 'home') mountPlacement()
  restoreFocusedInput(keep)
  // Being ON the Chat tab with the thread in view IS reading it (Signal-style).
  if (tab === 'chat' && !document.hidden && activeCircle()) markThreadRead(chatKeyOf((activeCircle() as store.Circle).id))
  scrollChatToEnd()
  // Native shell: keep the background-publish mirror in step with state. Diffed
  // inside the module — this is a cheap no-op unless something changed.
  if (isNativeShell()) {
    void import('../../native/publishMirror').then((m) =>
      m.syncNativePublishConfig(m.buildNativePublishConfig(persisted, sharing, baseSharePrecision(activeCircle()))),
    ).catch(() => { /* plugin unavailable */ })
  }
}

/** Pin the visible thread(s) to their newest message after a (re)render. */
function scrollChatToEnd(): void {
  for (const id of ['chat-thread', 'dm-thread']) {
    const el = document.getElementById(id)
    if (el) el.scrollTop = el.scrollHeight
  }
}

// ── Views: app ───────────────────────────────────────────────────────────────
function topbar(): string {
  return `<div class="topbar">
    <div class="brand"><img class="logo" src="./icon.svg" alt=""/><span class="name wordmark">flock</span></div>
  </div>
  ${circleSwitcher()}`
}

/** Compact remaining-lifetime label for a transient circle ('' for long-lived). */
function fmtTtl(expiresAt?: number): string {
  if (!expiresAt) return ''
  const left = expiresAt - nowSec()
  if (left <= 0) return 'ending'
  if (left < 3600) return `${Math.round(left / 60)}m`
  if (left < 86_400) return `${Math.round(left / 3600)}h`
  return `${Math.round(left / 86_400)}d`
}

/** Absolute wall-clock (HH:MM) for a unix-sec instant — "reverts at 23:41". */
function fmtClock(sec: number): string {
  return new Date(sec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Horizontal chip row to switch between circles + add a new one. */
function circleSwitcher(): string {
  if (persisted.circles.length < 1) return ''
  const active = activeCircle()?.id
  const chips = persisted.circles.map((c) => {
    const ttl = fmtTtl(c.expiresAt)
    return `<button class="circle-chip${c.id === active ? ' on' : ''}" data-action="switch-circle" data-id="${c.id}">${esc(c.name)}${ttl ? `<span class="ttl">${ttl}</span>` : ''}</button>`
  }).join('')
  return `<div class="circle-switch">${chips}<button class="circle-chip add" data-action="add-circle" aria-label="Add a circle">＋</button></div>`
}

/** The old status-orb copy, now a compact chip laid over the Home map — the map is
 *  the hero, but "am I sharing, and how closely?" must still read at a glance. */
function homeMapStatus(): { cls: string; label: string; sub: string } {
  const c = activeCircle() as store.Circle
  if (sharing && fix) {
    // Signet has no local key to hand the native watcher, and Tor routing has
    // no native Orbot/SOCKS path yet — either way sharing pauses the moment
    // flock is closed, so say so rather than silently degrading.
    const bgReason = persisted.authMethod === 'signet' ? 'Signet sign-in' : persisted.torRelay ? 'Tor routing' : null
    const bgNote = isNativeShell() && bgReason ? ` · pauses while flock is closed (${bgReason})` : ''
    return { cls: 'state-share', label: 'Sharing live', sub: `${precisionLabel(sharePrecisionOf(c))} · your circle can see you${bgNote}` }
  }
  if (sharing && !fix) return { cls: 'state-share', label: 'Locating…', sub: 'Getting a fix' }
  return { cls: 'state-safe', label: 'Private', sub: 'Location hidden until you share it' }
}

function homeMapStatusHtml(): string {
  const s = homeMapStatus()
  return `<span class="map-status ${s.cls}" id="home-map-status" title="${esc(s.sub)}">
    <span class="ms-dot"></span><span class="ms-text">${esc(s.label)}</span>
  </span>`
}

/** The precision slider — how closely this circle sees me. Lives on Home next to
 *  the share toggle because it IS the privacy control of the app. The slider shows
 *  my BASE setting; a live "find each other" boost is called out separately. */
function precisionCard(c: store.Circle): string {
  const p = baseSharePrecision(c)
  const boosted = festivalActive(c)
  return `<div class="card stack" style="margin-top:14px">
    <div class="row" style="justify-content:space-between">
      <strong>Location detail</strong>
      <span class="muted" id="precision-label">${esc(precisionLabel(p))}</span>
    </div>
    <input class="slider" id="share-precision" type="range" min="${PRECISION_MIN}" max="${PRECISION_MAX}" step="1" value="${p}" aria-label="How closely your circle sees you" />
    <div class="note" id="precision-note">${boosted
      ? `While “Find each other” is on you're shared at <strong>${esc(precisionLabel(FESTIVAL_PRECISION))}</strong>, above this. It reverts here when the timer ends.`
      : esc(precisionNote(p))}</div>
    ${hint('precision', 'Slide left to share only a rough area — as wide as a whole region — or right for your exact spot. It changes what your circle sees; nobody gets more than this. The Map shows what they see of you.')}
  </div>`
}

/** "Find each other" — a deliberate, temporary step-up to Exact spot (the finest
 *  detail flock offers) so a group in a crowd can walk right to each other. Opt-in
 *  per person, capped by the circle's own lifetime, auto-reverting; a no-report
 *  place still caps it (the boost raises the "coarse" input to decideEmission, it
 *  doesn't bypass the policy). */
function festivalCard(c: store.Circle): string {
  if (festivalActive(c)) {
    const until = c.festivalUntil as number
    return `<div class="section-title" style="margin-top:22px">Find each other</div>
    <div class="card stack festival-on">
      <div class="row" style="justify-content:space-between">
        <strong>📍 Finding each other</strong>
        <span class="muted">${esc(fmtTtl(until))} left</span>
      </div>
      <div class="note">Everyone in ${esc(c.name)} sees you to within <strong>${esc(precisionSize(FESTIVAL_PRECISION))}</strong> until <strong>${esc(fmtClock(until))}</strong> — then you drop back to your usual detail on your own.</div>
      <button class="btn small ghost" data-action="festival-stop">Stop now</button>
    </div>`
  }
  const chip = (h: number): string => `<button class="btn small" data-action="festival-start" data-hours="${h}">${h}h</button>`
  return `<div class="section-title" style="margin-top:22px">Find each other</div>
  <div class="card stack">
    <div class="note">In a crowd — a festival, a market — your usual detail is too coarse to meet up. Turn this on and everyone in the circle sees you to within <strong>${esc(precisionSize(FESTIVAL_PRECISION))}</strong> for a set time, then it reverts on its own. Each of you turns it on for yourself.</div>
    <div class="chip-row">${FESTIVAL_HOURS.map(chip).join('')}</div>
    ${hint('festival', 'A deliberate, temporary boost for meeting up in a crowd — your exact spot, the sharpest flock shares. It ends by itself (or when the circle does), and a place you\'ve marked private still stays private.')}
  </div>`
}

// One-tap quick actions, split by where they make sense: asking the WHOLE
// circle to check in or say they're on the way is a group thing; asking one
// specific person to come to you, say where they are, or call you is a
// person-to-person thing that reads oddly broadcast to everyone. "Come to me"
// is special in both: it also shares a one-shot exact spot, so it asks first
// (see doComeToMe / doDmComeToMe). "Check in" fans out to EVERY circle asking
// them all to show where they are (see doCheckIn) — group-only, deliberately.
// Flock carries this fixed provider-defined vocabulary, not user-authored chat.
const GROUP_QUICK_ACTIONS = GROUP_COORDINATION_ACTIONS
const DM_QUICK_ACTIONS = DIRECT_COORDINATION_ACTIONS

/** How much of a thread the UI renders (the store keeps CHAT_MAX_PER_THREAD). */
const CHAT_SHOWN = 50

// ── Chat history (threads live in persisted.chats / persisted.dms) ──────────
const chatKeyOf = (circleId: string): string => `c:${circleId}`
const dmKeyOf = (pk: string): string => `d:${pk}`

/** Append to a circle's group thread. False = a replay echo (nothing changed). */
function appendChat(circleId: string, m: store.ChatMessage): boolean {
  const next = store.withChatMessage(persisted.chats?.[circleId], m)
  if (!next) return false
  persisted.chats = { ...(persisted.chats ?? {}), [circleId]: next }
  store.save(persisted)
  return true
}

/** Append to a 1:1 thread. False = a replay echo. */
function appendDm(peer: string, m: store.ChatMessage): boolean {
  const next = store.withChatMessage(persisted.dms?.[peer], m)
  if (!next) return false
  persisted.dms = { ...(persisted.dms ?? {}), [peer]: next }
  store.save(persisted)
  return true
}

/** Render a provider-defined label locally; persisted history contains no prose. */
function chatMessageLabel(m: store.ChatMessage): string {
  if (m.action === 'shared_exact_location') {
    return m.from === persisted.identity?.pk ? '📍 Shared your exact location' : '📍 Shared their exact location'
  }
  return coordinationLabel(m.action)
}

function threadReadAt(key: string): number { return persisted.chatReadAt?.[key] ?? 0 }

function markThreadRead(key: string): void {
  const now = nowSec()
  if (threadReadAt(key) >= now) return
  persisted.chatReadAt = { ...(persisted.chatReadAt ?? {}), [key]: now }
  store.save(persisted)
}

/** Unread = newer than my last read and not mine. */
function unreadIn(list: store.ChatMessage[] | undefined, key: string): number {
  const me = persisted.identity?.pk
  const since = threadReadAt(key)
  return (list ?? []).reduce((n, m) => n + (m.at > since && m.from !== me ? 1 : 0), 0)
}

/** Unread group messages across every circle — the Home tab badge. */
function groupUnreadTotal(): number {
  return persisted.circles.reduce((n, c) => n + unreadIn(persisted.chats?.[c.id], chatKeyOf(c.id)), 0)
}

/** Unread private messages across every 1:1 thread — the You tab badge. */
function dmUnreadTotal(): number {
  return Object.entries(persisted.dms ?? {}).reduce((n, [pk, list]) => n + unreadIn(list, dmKeyOf(pk)), 0)
}

/** Home IS the map now — full screen, live, the whole point of the app.
 *  Everything else floats over it: the topbar/circle-switcher and any urgent
 *  alerts at the top, the people and the share toggle at the bottom. Routine
 *  settings (precision, find-each-other, invite) live on the Circle tab; the
 *  conversation lives on the Chat tab. Tap anyone below to zoom to them; tap
 *  their PIN on the map itself to message them privately. */
// ── Pins: a bottom-right button, a clean list sheet, and a drag-to-aim placer ──
// Fixed vocabulary only — every label is a glyph + provider-defined name, never
// free text, so the no-free-form property holds. The old two-chip-row panel that
// crowded the top overlay is gone; pins now live off the map's edge.

/** The floating pins button on Home — bottom-right, above the people strip, out
 *  of the crowded top stack. A count badge when the circle has any. */
function pinsFab(): string {
  const c = activeCircle()
  if (!c) return ''
  const n = cstate(c.id).pins.filter((p) => !p.removed).length
  return `<button class="pins-fab" data-action="open-pins" aria-label="Pins${n ? ` (${n})` : ''}">📌${n ? `<span class="fab-count">${n}</span>` : ''}</button>`
}

/** The pins list sheet: drop a new one, or navigate to / remove existing ones.
 *  A modal bottom sheet (compose-sheet idiom) mounted in overlayLayer so a
 *  background render never tears it. */
function pinsSheet(): string {
  const c = activeCircle()
  if (!c) return ''
  const me = persisted.identity?.pk
  const pins = cstate(c.id).pins.filter((p) => !p.removed)
  const list = pins.length
    ? pins.map((p) => `<div class="pin-row">
        <button class="btn pin-nav" data-action="nav-pin" data-id="${p.id}">🧭 <span>${esc(pinKindLabel(p.kind))}</span>${p.from === me ? '' : `<span class="pin-who">${esc(nameFor(p.from))}</span>`}</button>
        <button class="btn ghost pin-del" data-action="remove-pin" data-id="${p.id}" aria-label="Remove this pin">🗑</button>
      </div>`).join('')
    : '<div class="note pin-empty">No pins here yet. Drop one to mark a spot — your car, a meeting point, somewhere to steer clear of.</div>'
  return `<div class="compose-sheet" id="pins-sheet" role="dialog" aria-modal="true">
    <div class="compose-card pins-card">
      <div class="row" style="justify-content:space-between;align-items:center">
        <strong>📌 Pins in ${esc(c.name)}</strong>
        <button class="bz-x" data-action="pins-close" aria-label="Close">✕</button>
      </div>
      <button class="btn primary pin-drop-cta" data-action="pin-place-start">＋ Drop a pin</button>
      <div class="pin-list">${list}</div>
    </div>
  </div>`
}

/** Mount (or, when closed, remove) the pins list sheet in overlayLayer. Tapping
 *  the dimmed backdrop closes it, matching every other sheet. */
function mountPinsSheet(): void {
  document.getElementById('pins-sheet')?.remove()
  if (!pinsOpen || !activeCircle()) return
  const tmp = document.createElement('div')
  tmp.innerHTML = pinsSheet()
  const el = tmp.firstElementChild as HTMLElement | null
  if (!el) return
  overlayLayer.appendChild(el)
  el.addEventListener('click', (e) => { if (e.target === el) { pinsOpen = false; mountPinsSheet() } })
  wirePinActions(el)
}

/** The placement overlay: just the aim bar (kind + Cancel/Drop). The pin itself is
 *  a draggable maplibre marker on the map (see raiseDraftPin), so nothing here needs
 *  to sit over the map centre. Lives INSIDE .home-shell so the `.placing` fade can
 *  quiet the other overlays while you position the pin. */
function placementUi(): string {
  // A full-screen touch surface OVER the map catches the drag (id=pin-catch); the
  // aim bar sits above it. Both are inside #pin-place (which is pointer-events:none).
  // Zoom buttons sit AFTER the catcher so they stack above it and take their own
  // taps (pointer-events:auto), letting you frame the map while positioning a pin.
  return `<div id="pin-place">
    <div class="pin-catch" id="pin-catch" aria-hidden="true"></div>
    <div class="pin-zoom">
      <button class="pin-zoom-btn" data-action="pin-zoom-in" aria-label="Zoom in">＋</button>
      <button class="pin-zoom-btn" data-action="pin-zoom-out" aria-label="Zoom out">－</button>
    </div>
    <div class="pin-place-bar" id="pin-place-bar">${placementBarInner()}</div>
  </div>`
}

function placementBarInner(): string {
  // Remove-only prompt (long-press on someone ELSE's pin): name whose pin it is,
  // offer only Cancel / Remove — no kinds, no drop, the pin isn't going anywhere.
  if (removingPinId) {
    const c = activeCircle()
    const pin = c ? cstate(c.id).pins.find((p) => p.id === removingPinId) : null
    const whose = pin ? `${esc(nameFor(pin.from))}'s ${esc(pinKindLabel(pin.kind))} pin` : 'this pin'
    return `<div class="place-hint">Remove ${whose}?</div>
    <div class="place-actions">
      <button class="btn ghost" data-action="pin-cancel">Cancel</button>
      <button class="btn primary" data-action="pin-remove-editing">🗑 Remove pin</button>
    </div>`
  }
  // Icon-forward chips: the glyph is the choice, the label names it beneath. The
  // selected kind's icon is also what the draggable pin wears on the map, so the
  // picker and the map always agree on what you're about to drop.
  const chips = PIN_KIND_LIST.map((k) => `<button class="pin-kind${k === placingKind ? ' on' : ''}" data-action="pin-kind" data-kind="${k}" aria-label="${esc(PIN_KINDS[k].label)}" title="${esc(PIN_KINDS[k].label)}"><span class="pk-glyph">${PIN_KINDS[k].glyph}</span><span class="pk-label">${esc(PIN_KINDS[k].label)}</span></button>`).join('')
  const editing = editingPinId !== null
  return `<div class="place-hint">Pick an icon · hold the pin to lift it · drag or pinch the map to line up</div>
    <div class="pin-kind-row">${chips}</div>
    <div class="place-actions">
      <button class="btn ghost" data-action="pin-cancel">Cancel</button>
      ${editing ? '<button class="btn ghost pin-edit-del" data-action="pin-remove-editing" aria-label="Remove this pin">🗑</button>' : ''}
      <button class="btn primary" data-action="pin-drop">${editing ? 'Move pin here' : 'Drop pin here'}</button>
    </div>`
}

/** Mount (or remove) the placement overlay inside the live map's shell. A `placing`
 *  class on .home-shell fades the other overlays so aiming is a clean, focused act. */
function mountPlacement(): void {
  document.getElementById('pin-place')?.remove()
  const shell = document.querySelector('.home-shell')
  if (!placing || !shell || tab !== 'home') { shell?.classList.remove('placing'); return }
  shell.classList.add('placing')
  const tmp = document.createElement('div')
  tmp.innerHTML = placementUi()
  const el = tmp.firstElementChild as HTMLElement | null
  if (!el) return
  shell.appendChild(el)
  wirePinActions(el)
  const catcher = el.querySelector('#pin-catch') as HTMLElement | null
  if (catcher) wireDraftDrag(catcher)
}

/** Wire every [data-action] within a freshly-built pins element (sheet or bar). */
function wirePinActions(scope: HTMLElement): void {
  scope.querySelectorAll('[data-action]').forEach((node) => {
    node.addEventListener('click', () => handleAction(node.getAttribute('data-action') as string, node as HTMLElement))
  })
}

function homeView(): string {
  const c = activeCircle() as store.Circle
  return `
    <div class="home-shell">
      <div id="map" class="map-canvas home-map-full"></div>
      <div id="offline-oob" class="offline-oob" hidden></div>
      <div class="home-overlay home-overlay-top">
        ${topbar()}
        <div class="home-share-bar" id="home-share-bar">${homeShareBarInner()}</div>
        <div id="home-alerts">${geoIssueCard()}${batteryCard()}${rollCallCard()}${lostCard(c)}</div>
      </div>
      <div class="home-overlay home-overlay-bottom">
        <div class="home-fabs">${pinsFab()}</div>
        <div id="home-strip">${memberStrip()}</div>
      </div>
    </div>`
}

/** The circle's people at a glance, floating over the map. Tap someone to zoom
 *  the map to them; tap yourself to jump to your Circle row; the ＋ leads to
 *  inviting. Hold and drag an avatar to put people in the order you want —
 *  a plain tap zooms, only a deliberate hold starts reordering (see
 *  wireMemberStripDrag). A right-edge fade + chevron shows when there's more
 *  to scroll to. */
function memberStrip(): string {
  const me = persisted.identity?.pk ?? ''
  const c = activeCircle()
  const order = store.orderedMembers(members(), c?.memberOrder)
  const st = active()
  const items = order.map((pk) => {
    const b = st?.beacons.get(pk)
    const p = b ? classifyPresence([b], nowSec(), { staleAfterSeconds: 600 })[0] : null
    const dot = p ? (p.status === 'active' ? 'on' : 'idle') : ''
    const isMe = pk === me
    const label = isMe ? 'You' : nameFor(pk)
    return `<button class="strip-member" data-action="strip-member" data-pk="${pk}" aria-label="${esc(isMe ? 'You' : `Zoom to ${label}`)}">
      <span class="strip-avatar">${avatarHtml(pk, isMe)}${dot ? `<span class="presence-dot ${dot}"></span>` : ''}</span>
      <span class="strip-name">${esc(label.length > 9 ? `${label.slice(0, 8)}…` : label)}</span>
    </button>`
  }).join('')
  const overflow = order.length > 3 ? ' has-overflow' : ''
  return `<div class="member-strip-wrap${overflow}"><div class="member-strip" id="member-strip">${items}<button class="strip-member add" data-action="go-invite" aria-label="Invite someone">
    <span class="strip-avatar plus">＋</span><span class="strip-name">Invite</span>
  </button></div></div>`
}

/** The circle's running coordination log. Only provider-defined group actions
 *  can enter it; person-to-person actions live in the private sheet. */
function chatSection(c: store.Circle): string {
  const list = persisted.chats?.[c.id] ?? []
  const thread = list.slice(-CHAT_SHOWN).map((m, i, arr) => chatBubble(m, arr[i - 1])).join('')
    || `<div class="note chat-empty">No signals yet. Use one of the fixed actions below to coordinate with everyone in ${esc(c.name)}.</div>`
  const chip = (action: GroupCoordinationAction): string => action === 'check_in'
    ? `<button class="btn small" data-action="check-in">${esc(coordinationLabel(action))}</button>`
    : `<button class="btn small" data-action="group-signal" data-signal="${action}">${esc(coordinationLabel(action))}</button>`
  return `<div class="section-title" style="margin-top:22px">Signals · ${esc(c.name)}</div>
  <div class="card chat-card">
    <div class="chat-thread" id="chat-thread">${thread}</div>
    <div class="chip-row chat-presets">${GROUP_QUICK_ACTIONS.map(chip).join('')}</div>
    ${hint('chat', 'Signals go to everyone in this circle, encrypted end-to-end: the servers never see them. “Check in” also asks all your circles to show where they are. For a private action — including “Come to me” with a separately confirmed exact spot — tap one person above or on the map.')}
  </div>`
}

/** One fixed-action bubble. The sender's name heads a run of their messages
 *  (Signal style) — never on my own (right-aligned) bubbles. */
function chatBubble(m: store.ChatMessage, prev?: store.ChatMessage): string {
  const mine = m.from === persisted.identity?.pk
  const who = !mine && (!prev || prev.from !== m.from) ? `<span class="msg-who">${esc(nameFor(m.from))}</span>` : ''
  // A private "Come to me" location share — the marker text plus its precision,
  // and (received side only) a jump to see it on the map.
  const view = !mine && m.geohash
    ? `<button class="btn small ghost" data-action="see-shared-location" data-geohash="${esc(m.geohash)}" data-pk="${esc(m.from)}">See on map</button>`
    : ''
  const size = m.precision !== undefined ? ` · ${esc(precisionSize(m.precision))}` : ''
  return `<div class="msg${mine ? ' mine' : ''}">${who}<span class="msg-text">${esc(chatMessageLabel(m))}${size}</span>${view}<span class="msg-when">${esc(fmtChatTime(m.at))}</span></div>`
}

/** "14:02" today, "Wed 14:02" earlier — a running conversation's clock. */
function fmtChatTime(at: number): string {
  const d = new Date(at * 1000)
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

/** Sharing or stay-reachable is on but flock isn't battery-exempt: the one
 *  setting that makes locked-screen sharing AND message delivery actually hold.
 *  Actionable card, not a silent gap. */
function batteryCard(): string {
  if (!isNativeShell() || (!sharing && !stayReachableOn()) || batteryExempt !== false) return ''
  return `<div class="card stack geo-issue" style="margin-top:14px">
    <strong>Keep flock reachable with the screen off</strong>
    <div class="note">Android pauses flock's connection a few minutes after the phone locks — your circle would stop seeing you mid-walk, and buzzes and messages would stop arriving (and sending) until you reopen flock. Allow flock to ignore battery optimisation: it's the same setting Signal asks for, and the location toggle still rules what's shared.</div>
    <button class="btn small primary" data-action="battery-allow">Allow</button>
  </div>`
}

/** A pending roll-call: someone checked in and asked where everyone is. Only an
 *  explicit tap answers it — never automatic (FLOCK §6: an ask is not a demand). */
function rollCallCard(): string {
  if (!locAsk || nowSec() - locAsk.at > LOC_ASK_WINDOW_SEC) return ''
  const c = persisted.circles.find((x) => x.id === locAsk?.circleId)
  if (!c) return ''
  return `<div class="card stack geo-issue" style="margin-top:14px" role="alert">
    <strong>${esc(nameFor(locAsk.from))} asked where everyone is</strong>
    <div class="note">Share your location once with ${esc(c.name)}? They'd see you to within <strong>${esc(precisionSize(sharePrecisionOf(c)))}</strong>, your usual detail, one time. A place you've marked private stays private.</div>
    <div class="row" style="gap:10px">
      <button class="btn small primary" data-action="rollcall-share">Share once</button>
      <button class="btn small ghost" data-action="rollcall-dismiss">Not now</button>
    </div>
  </div>`
}

/** Shown on THIS phone when the circle has flagged it lost — written for
 *  whoever is holding it (an honest finder, or the owner clearing a mistake). */
function lostCard(c: store.Circle): string {
  const me = persisted.identity?.pk
  const rep = me ? memberLost(c.id, me) : null
  if (!me || !rep) return ''
  // Louder still while the circle is actively ringing it (a member just buzzed
  // it, and the alarm channel is sounding) — the finder's cue to look up.
  const rungBy = ringingBy(c.id)
  if (rungBy) {
    return `<div class="card stack geo-issue ringing" style="margin-top:14px" role="alert">
      <strong>📢 This phone is ringing</strong>
      <div class="note">${esc(nameFor(rungBy))} is ringing it to find its owner. Found this phone? Please help it home — its owner's friends can see roughly where it is.</div>
      <button class="btn primary" data-action="found-phone" data-pk="${me}">It's not lost — I've got it</button>
    </div>`
  }
  // Lost reports no longer carry a free-text note. Ignore any legacy `message`
  // an older client may still send, and always show the fixed prompt — the app
  // neither composes nor displays free-form text.
  const note = `${esc(nameFor(rep.by))} flagged it in ${esc(c.name)}. Found this phone? Please help it home, its owner's friends can see roughly where it is.`
  return `<div class="card stack geo-issue" style="margin-top:14px" role="alert">
    <strong>This phone was reported lost</strong>
    <div class="note">${note}</div>
    <button class="btn primary" data-action="found-phone" data-pk="${me}">It's not lost — I've got it</button>
  </div>`
}

/** Location trouble as an actionable, persistent card — a denied permission is a
 *  settings change only the user can make; a raw error toast is a dead end. */
function geoIssueCard(): string {
  if (geoIssue === 'denied') {
    return `<div class="card stack geo-issue" style="margin-top:14px">
      <strong>flock can't see your location</strong>
      <div class="note">Location is blocked for this browser, so sharing switched itself off. Allow it in your phone's settings (Settings → your browser → Location → “While using”), then try again.</div>
      <button class="btn small" data-action="geo-retry">Try again</button>
    </div>`
  }
  if (geoIssue === 'nofix') {
    return `<div class="card geo-issue" style="margin-top:14px">
      <strong>Looking for you…</strong>
      <div class="note">No GPS fix yet — still trying. Being near a window or outside helps.</div>
    </div>`
  }
  return ''
}

function circleMemberRow(pk: string, mePk: string): string {
  const st = active()
  const cid = activeCircle()?.id ?? ''
  const isMe = pk === mePk

  if (!isMe && editingPetname === pk) {
    return `<div class="member editing">
      ${avatarHtml(pk, isMe)}
      <input class="input" id="pet-${pk}" placeholder="Nickname (just for you)" value="${esc(persisted.petnames[pk] ?? '')}" autocapitalize="words" style="flex:1" />
      <button class="btn small primary" data-action="save-petname" data-pk="${pk}">Save</button>
      <button class="btn small ghost" data-action="cancel-petname" aria-label="Cancel">✕</button>
    </div>`
  }

  if (!isMe && lostConfirmPk === pk) {
    return `<div class="member editing">
      ${avatarHtml(pk, isMe)}
      <div class="meta"><div class="who">${esc(nameFor(pk))}</div><div class="when">Report their phone lost? Everyone sees it flagged, and the phone shows a message for whoever finds it. Nothing about their sharing changes.</div></div>
      <button class="btn small ghost" style="color:var(--alert);border-color:var(--alert-dim)" data-action="report-lost" data-pk="${pk}">Report lost</button>
      <button class="btn small ghost" data-action="cancel-lost" aria-label="Cancel">✕</button>
    </div>`
  }

  if (!isMe && removeConfirmPk === pk) {
    return `<div class="member editing">
      ${avatarHtml(pk, isMe)}
      <div class="meta"><div class="who">${esc(nameFor(pk))}</div><div class="when">Remove them? This resets the circle's security and cuts them off straight away. Everyone else gets a fresh key.</div></div>
      <button class="btn small ghost" style="color:var(--alert);border-color:var(--alert-dim)" data-action="remove-member" data-pk="${pk}">Remove</button>
      <button class="btn small ghost" data-action="cancel-remove" aria-label="Cancel">✕</button>
    </div>`
  }

  const lost = !!cid && !!memberLost(cid, pk)
  const beacon = st?.beacons.get(pk)
  const presence = beacon ? classifyPresence([beacon], nowSec(), { staleAfterSeconds: 600 })[0] : null
  // A check-in (or any message) only asks everyone ELSE to share — it isn't
  // itself a location update, so it never touches `beacon`. Reported live:
  // "he checked in at 23:49 but the roster still says last seen 23:03" — the
  // location claim was correct (nothing new to see), but the roster read as
  // if he'd gone quiet when he plainly hadn't. If we've heard from them more
  // recently than their last beacon, that takes priority for the PILL only —
  // "last seen" below stays location-specific, never overclaiming freshness.
  const activityAt = st?.lastActivity.get(pk)
  const activityIsFresher = activityAt !== undefined && activityAt > (beacon?.timestamp ?? 0)
  const pill = lost
    ? '<span class="pill alert">phone lost</span>'
    : activityIsFresher
      ? `<span class="pill${nowSec() - (activityAt as number) < 600 ? ' active' : ''}">active · ${fmtAgo(nowSec() - (activityAt as number))}</span>`
      : presence
        ? (presence.status === 'active'
          ? `<span class="pill active">out · ${fmtAgo(presence.ageSeconds)}</span>`
          : `<span class="pill stale">home · ${fmtAgo(presence.ageSeconds)}</span>`)
        : '<span class="pill">no activity</span>'

  // "Last seen" — the lost-phone breadcrumb: even after a phone stops beaconing
  // (battery dead, left in a taxi), everyone still holds where and when it last
  // spoke, at the detail its owner allowed. Absolute time on purpose: "23:41"
  // is what you tell the taxi firm, "2h ago" isn't.
  const seenAt = beacon ? new Date(beacon.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
  const sub = beacon
    ? `${isMe ? 'you · ' : ''}within ${precisionSize(beacon.precision).replace('~', '')} · last seen ${seenAt}`
    : isMe ? 'you' : 'in this circle'
  const isNew = (activeCircle()?.unseenMembers ?? []).includes(pk)

  // Lost phone is urgent, rare, and needs to stay immediately actionable — it
  // never hides behind the expand toggle, unlike the routine actions below.
  const ringBtn = lost && !isMe
    ? `<button class="btn small" data-action="make-it-ring" data-pk="${pk}" title="Ring it — sounds even on silent">🔔 Ring</button>`
    : ''
  const findBtn = lost && !isMe
    ? `<button class="btn small" data-action="find-exact" data-pk="${pk}" title="Ask for an exact location (only if its owner allowed it)">📍 Find</button>`
    : ''
  const lostRow = lost
    ? `<div class="member-actions">${ringBtn}${findBtn}<button class="btn small" data-action="found-phone" data-pk="${pk}">Found it</button></div>`
    : ''

  // Everything else (message/locate/petname/report-lost/remove) is routine
  // chrome, tucked behind a tap-to-expand — the row itself stays readable
  // (avatar, name, one pill) instead of five icon buttons crammed alongside.
  // My own row only ever has one possible action (jump to my own pin), so it
  // only gets a chevron at all when there's a beacon to jump to.
  const hasActions = isMe ? !!beacon : true
  const expanded = hasActions && expandedMemberPk === pk
  const chevron = hasActions
    ? `<button class="icon-btn chevron${expanded ? ' open' : ''}" data-action="toggle-member-actions" data-pk="${pk}" aria-label="${expanded ? 'Hide actions' : 'More actions'}" aria-expanded="${expanded}">⌄</button>`
    : ''
  const actions = expanded ? `<div class="member-actions">
    ${beacon ? `<button class="icon-btn" data-action="see-on-map" data-pk="${pk}" aria-label="See on the map">📍</button>` : ''}
    ${isMe ? '' : `<button class="icon-btn" data-action="msg-member" data-pk="${pk}" aria-label="Message ${esc(nameFor(pk))} privately">✉️</button>`}
    ${isMe || lost ? '' : `<button class="icon-btn" data-action="ask-lost" data-pk="${pk}" aria-label="Report their phone lost">📵</button>`}
    ${isMe ? '' : `<button class="icon-btn" data-action="edit-petname" data-pk="${pk}" aria-label="Set a nickname">✎</button>`}
    ${isMe ? '' : `<button class="icon-btn" data-action="ask-remove" data-pk="${pk}" aria-label="Remove ${esc(nameFor(pk))} from this circle">🚪</button>`}
  </div>` : ''

  // Radar is the headline way to reach someone — it earns a place ON the row
  // (not behind the chevron), whenever there's a disclosed location to go to.
  const radarBtn = !isMe && beacon
    ? `<button class="icon-btn radar-launch" data-action="radar-member" data-pk="${pk}" aria-label="Navigate to ${esc(nameFor(pk))} by radar" title="Navigate to them">🧭</button>`
    : ''
  return `<div class="member${isNew ? ' unseen' : ''}">
    <div class="member-row">
      ${avatarHtml(pk, isMe)}
      <div class="meta"><div class="who">${isMe ? 'You' : esc(nameFor(pk))}${isNew ? ' <span class="pill new">new</span>' : ''}</div><div class="when">${sub}</div></div>
      ${pill}${radarBtn}${chevron}
    </div>
    ${lostRow}${actions}
  </div>`
}

/** The two ways to add someone: in-person QR/code, and remote encrypted invite. */
function inviteSections(): string {
  return `
    <div class="section-title" style="margin-top:22px">Show a code (in person)</div>
    <div class="card stack">
      <div class="qr" id="qr"></div>
      ${showInviteLinkText && activeCircle() ? `<div class="invite-code">${esc(store.inviteLink(activeCircle() as store.Circle, shareOrigin()))}</div>` : ''}
      <button class="btn primary" data-action="copy-invite">${'share' in navigator ? 'Share invite link' : 'Copy invite link'}</button>
      <div class="note">Best from inside their flock app: <strong>Join a circle → Scan their invite QR</strong>. The phone camera works too but opens the browser version — fine for a first look, wrong if they've installed the app. Or copy the link and send it. It carries the secret, so treat it like a password.</div>
    </div>

    <div class="section-title" style="margin-top:22px">Say a code (down the phone)</div>
    <div class="card stack">
      ${spokenCode ? `
        <div class="wordcode">${spokenCode.map((w) => `<span class="wc-word">${esc(w)}</span>`).join('')}</div>
        <button class="btn small" data-action="copy-word-code">Copy the words</button>
        <button class="btn small ghost" data-action="new-word-code"${spokenCodeBusy ? ' disabled' : ''}>New code</button>
        <div class="note">Read these six words to them, or send them over Signal: they tap “Join with a code” and type them in. Works when a QR can’t be scanned. Good for 15 minutes, then make a new one.</div>
      ` : `
        <button class="btn primary" data-action="share-word-code"${spokenCodeBusy ? ' disabled' : ''}>${spokenCodeBusy ? 'Setting up…' : 'Make a spoken code'}</button>
        <div class="note">${WORD_INVITE.words} plain words you can read out or send over Signal — no scanning, no long link. The words aren’t the secret; they unlock a one-time invite parked on your private relay, and expire in 15 minutes.</div>
      `}
    </div>

    <div class="section-title" style="margin-top:22px">Send to their key (remote)</div>
    <div class="card stack">
      ${hint('invite-remote', "In person? Show them the QR above. Far away? Ask them to open flock, tap 'Join remotely', and send you the key it shows.")}
      <div class="field"><label for="invite-npub">Their invite key</label><input class="input" id="invite-npub" placeholder="npub1…" value="${esc(pendingInviteNpub ?? '')}" autocapitalize="off" autocorrect="off" spellcheck="false" /></div>
      <button class="btn small" data-action="scan-invite-key">📷 Scan their key QR</button>
      <button class="btn small primary" data-action="send-invite">Send encrypted invite</button>
      <div class="note">Encrypted just for them — safe to send through any chat. Ask them to tap “Join remotely” and send you the key it shows.</div>
    </div>`
}

function circleView(): string {
  const c = activeCircle() as store.Circle
  const me = persisted.identity as store.Identity
  const mem = members()
  const alone = mem.length <= 1
  const rows = mem.length
    ? mem.map((pk) => circleMemberRow(pk, me.pk)).join('')
    : '<div class="card muted">Just you so far.</div>'
  // Inviting is the whole point when you're on your own, so the panel opens
  // itself then; otherwise it's tucked behind the header's "Invite" button.
  const inviteOpen = alone || showInvite
  const inviteHeader = alone
    ? '' // an alone circle gets the louder invite-lead below instead of a toggle
    : `<button class="btn small primary" data-action="toggle-invite" aria-expanded="${showInvite}">${showInvite ? '✕ Close' : '＋ Invite'}</button>`
  const invitePanel = inviteOpen
    ? `${alone ? `<div class="card invite-lead"><div class="cta-emoji">👋</div><div class="cta-text"><strong>Add your people</strong><span>Share a code in person, or send an invite to someone's key.</span></div></div>` : ''}${inviteSections()}`
    : ''
  const unseen = c.unseenMembers ?? []
  const joinNotice = unseen.length
    ? `<div class="card new-member-notice" role="alert">
        <div><strong>〰️ ${unseen.length === 1 ? 'A new phone' : `${unseen.length} new phones`} joined ${esc(c.name)}</strong>
        <div class="note">Anyone holding the invite code can join. Tap ✎ on their row to give them a name you'll recognise. Not expecting anyone? Remove them under You → Circle security — that locks them out.</div></div>
        <button class="btn small ghost" data-action="ack-new-members">Got it</button>
      </div>`
    : ''
  return `
    ${topbar()}
    <div class="row circle-head" style="justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px">
      <h2 style="margin:0">${esc(c.name)}</h2>
      ${inviteHeader}
    </div>
    ${joinNotice}
    ${invitePanel}
    <div class="section-title"${inviteOpen ? ' style="margin-top:22px"' : ''}>Members</div>
    <div class="list">${rows}</div>

    ${precisionCard(c)}
    ${festivalCard(c)}

    <div class="section-title" style="margin-top:22px">If your phone gets lost</div>
    <div class="card stack">
      <div class="row" style="justify-content:space-between;gap:12px">
        <span>Let this circle find my phone</span>
        <button class="switch${c.pingConsent ? ' on' : ''}" data-action="toggle-ping-consent" role="switch" aria-checked="${!!c.pingConsent}" aria-label="Let this circle find my phone"><span class="knob"></span></button>
      </div>
      <div class="note">${hint('ping-consent', "If your phone is ever lost, members can ask it for its exact location to come and fetch it. It only answers when it's been marked lost, warns you first with a chance to say no, and never turns on ongoing sharing. Off by default; turn it on only for a circle you trust.")}</div>
    </div>`
}

function youView(): string {
  const me = persisted.identity as store.Identity
  const c = activeCircle() as store.Circle
  void refreshDndAccess() // native: reflect current DND-access grant (re-renders only if it changed)
  return `
    ${topbar()}
    <h2 style="margin-bottom:14px">You</h2>
    ${updateAvailable ? `
    <div class="card stack" style="margin-bottom:14px">
      <div><strong>A newer version of flock is ready</strong></div>
      <div class="note">Download it and install over the top — everything on this phone stays put.</div>
      <a class="btn small primary" href="https://flock.forgesworn.dev/get.html">Get the update</a>
    </div>` : ''}
    <div class="section-title">Identity</div>
    <div class="card stack">
      <div class="kv"><span class="k">Your invite key</span><span>${shortNpub(me.pk)}</span></div>
      <div class="kv"><span class="k">Sign-in</span><span>${persisted.authMethod === 'signet' ? 'External signer' : 'Quick start (this device only)'}</span></div>
      <div class="field"><label for="my-handle">Name your circles see</label><input class="input" id="my-handle" maxlength="40" placeholder="Dave, Mum, a nickname…" value="${esc(persisted.myHandle ?? '')}" /></div>
      <button class="btn small" data-action="save-handle">Save name</button>
      <div class="note">Optional, and a made-up name is fine. It travels encrypted — only your circle members can read it; the servers in between never see it. Without one you appear as "Member ${(() => { try { return npubEncode(me.pk).slice(-4) } catch { return me.pk.slice(0, 4) } })()}".</div>
      <button class="btn small ghost" data-action="copy-npub">Copy my invite key</button>
      <div class="note">${persisted.authMethod === 'signet'
        ? 'Your key lives in your signer (Signet, Amber, a bunker…) and never touches flock.'
        : persisted.lock
          ? 'Quick-start key, encrypted at rest by your App lock. Sign in with a signer to keep the key out of flock entirely.'
          : 'Quick-start key, stored in this browser only. Turn on the App lock (Advanced) to encrypt it at rest, or sign in with a signer.'}</div>
    </div>
    <div class="section-title" style="margin-top:18px">Private chats</div>
    ${privateChatsSection()}
    <button class="btn ghost" data-action="toggle-settings" style="margin-top:18px" aria-expanded="${showSettings}">${showSettings ? 'Hide settings' : 'Settings…'}</button>
    ${showSettings ? settingsSections(me, c) : ''}
    <div class="note" style="margin-top:16px;text-align:center">flock · your location, shared only when you choose · <a href="./legal.html" target="_blank" rel="noopener">Legal</a> · <a href="./report.html" target="_blank" rel="noopener">Report misuse</a></div>
    <div class="app-version">version ${esc(__FLOCK_BUILD__)} · ${esc(__FLOCK_BUILT_AT__)}</div>`
}

/** The 1:1 threads — most recent first, unread badged. PMs live here (Home is
 *  the circle's shared space; your private conversations are yours). */
function privateChatsSection(): string {
  const me = persisted.identity?.pk
  const entries = Object.entries(persisted.dms ?? {})
    .map(([pk, list]) => ({ pk, last: list[list.length - 1], unread: unreadIn(list, dmKeyOf(pk)) }))
    .filter((e) => e.last && e.pk !== me)
    .sort((a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0))
  if (!entries.length) {
    return '<div class="card muted">No private chats yet. Tap someone on the map or on Home to message them; only the two of you can read it.</div>'
  }
  const rows = entries.map(({ pk, last, unread }) => {
    const preview = (last?.from === me ? 'You: ' : '') + (last ? chatMessageLabel(last) : '')
    return `<div class="member dm-row" data-action="open-dm" data-pk="${pk}" role="button" tabindex="0">
      ${avatarHtml(pk, false)}
      <div class="meta"><div class="who">${esc(nameFor(pk))}</div><div class="when">${esc(preview.length > 44 ? `${preview.slice(0, 43)}…` : preview)}</div></div>
      <span class="muted" style="font-size:12px">${last ? esc(fmtAgo(nowSec() - last.at)) : ''}</span>
      ${unread ? `<span class="nav-badge inline">${unread > 9 ? '9+' : unread}</span>` : ''}
    </div>`
  }).join('')
  return `<div class="list">${rows}</div>`
}

/** Day-to-day preferences, folded out of the way — You leads with the person
 *  and their conversations; the dials appear on request. */
function settingsSections(me: store.Identity, c: store.Circle): string {
  return `
    ${isNativeShell() ? `<div class="section-title" style="margin-top:18px">Notifications</div>
    <div class="card stack">
      <div class="row" style="justify-content:space-between">
        <span>Stay reachable when closed</span>
        <button class="switch${stayReachableOn() ? ' on' : ''}" data-action="toggle-stay-reachable" role="switch" aria-checked="${stayReachableOn()}"><span class="knob"></span></button>
      </div>
      <div class="note">Keeps flock listening even when it's shut, so a message, buzz or safety alert reaches you on the lock screen — like Signal. It shows a quiet "staying reachable" notification while on and uses a little battery, and it's off whenever flock is hidden. If alerts stop arriving overnight, allow flock to ignore battery optimisation when asked.</div>
      <div class="row" style="justify-content:space-between;margin-top:6px">
        <span>Ring through Do Not Disturb</span>
        ${dndAccess ? '<span class="pill active">allowed</span>' : '<button class="btn small" data-action="open-dnd">Allow</button>'}
      </div>
      <div class="note">Lets a lost-phone alarm ("Make it ring") sound even in Do Not Disturb. Without it the alarm still plays through silent — just not full DND.</div>
    </div>
    <div class="section-title" style="margin-top:18px">Nearby (beta)</div>
    <div class="card stack">
      <div class="row" style="justify-content:space-between">
        <span>Find nearby over Bluetooth</span>
        <button class="switch${persisted.bleNearby ? ' on' : ''}" data-action="toggle-ble" role="switch" aria-checked="${!!persisted.bleNearby}"><span class="knob"></span></button>
      </div>
      <div class="note">When circle members are physically near you, exchange updates phone-to-phone over Bluetooth — no relay, no internet needed. Beta, Android only; the relay still carries everything as normal.</div>
    </div>` : ''}
    <div class="section-title" style="margin-top:18px">Tips &amp; help</div>
    <div class="card stack">
      <div class="row" style="justify-content:space-between">
        <span>Show helper tips</span>
        <button class="switch${(persisted.hints?.on ?? false) ? ' on' : ''}" data-action="toggle-hints" role="switch" aria-checked="${persisted.hints?.on ?? false}"><span class="knob"></span></button>
      </div>
      <div class="note">Small explanations you can turn on around the app if you want a hand learning it. Off by default — the screen should make sense on its own.</div>
      ${persisted.hints?.dismissed.length ? '<button class="btn small ghost" data-action="reset-hints">Bring all tips back</button>' : ''}
    </div>
    <div class="section-title" style="margin-top:18px">Distances</div>
    <div class="card stack">
      <div class="row" style="gap:10px">
        <button class="btn small ${distanceUnits() === 'metric' ? 'primary' : 'ghost'}" data-action="set-units" data-units="metric">Kilometres</button>
        <button class="btn small ${distanceUnits() === 'imperial' ? 'primary' : 'ghost'}" data-action="set-units" data-units="imperial">Miles</button>
      </div>
      <div class="note">How flock shows distances — like how closely you're sharing your location. Miles switches short distances to feet.</div>
    </div>
    <div class="section-title" style="margin-top:18px">Names &amp; photos</div>
    <div class="card stack">
      <div class="row" style="justify-content:space-between">
        <span>Show public profiles</span>
        <button class="switch${persisted.showProfiles ? ' on' : ''}" data-action="toggle-profiles" role="switch" aria-checked="${!!persisted.showProfiles}"><span class="knob"></span></button>
      </div>
      <div class="note">Off by default. When on, flock asks public relays for each person's name/photo one at a time (never your whole circle in one request), but a relay can still notice several of your requests arriving close together and infer they're linked. Your private nicknames always work and never leave this device.</div>
    </div>
    <div class="section-title" style="margin-top:18px">Backup</div>
    <div class="card stack">
      <div class="note">One encrypted code holds your key, circles, nicknames and private places. Restore it from the welcome screen on any device. The passphrase is the only way in — nobody can reset it.</div>
      <div class="field"><label for="backup-pass">Passphrase</label><input class="input" id="backup-pass" type="password" autocomplete="new-password" placeholder="Pick a strong passphrase" /></div>
      <div class="row" style="gap:10px">
        <button class="btn small" data-action="backup-copy">Copy backup code</button>
        <button class="btn small ghost" data-action="backup-download">Download file</button>
      </div>
    </div>
    <button class="btn ghost" data-action="toggle-advanced" style="margin-top:18px" aria-expanded="${showAdvanced}">${showAdvanced ? 'Hide advanced settings' : 'Advanced settings…'}</button>
    ${showAdvanced ? advancedSections(me, c) : ''}`
}

/** The sharp tools, folded away by default: servers, security, disband, reset.
 *  A practised user opens this once; a new user never trips over it. */
function advancedSections(me: store.Identity, c: store.Circle): string {
  return `
    <div class="section-title" style="margin-top:18px">Delivery servers</div>
    <div class="card stack">
      ${hint('relays', "flock sends your encrypted alerts through these servers. More than one means an alert can't be lost if one is down.")}
      <div class="field"><label for="relay">Server addresses (one per line)</label><textarea class="input" id="relay" rows="3" autocapitalize="off" autocorrect="off" spellcheck="false">${esc(persisted.relayUrls.join('\n'))}</textarea></div>
      <div class="note">Alerts go to every server here, so one being down can't swallow an SOS. Add a backup you trust — even encrypted, a public server still sees the timing of your traffic.</div>
      <button class="btn small" data-action="save-relay">Save servers</button>
      <div class="row" style="justify-content:space-between;margin-top:14px">
        <span>Route through Tor when available</span>
        <button class="switch${persisted.torRelay ? ' on' : ''}" data-action="toggle-tor" role="switch" aria-checked="${!!persisted.torRelay}"><span class="knob"></span></button>
      </div>
      <div class="note">Off by default. Hides your IP from the relay by routing through Tor (Orbot) instead, but Tor is known to be unreliable on mobile networks, so treat this as experimental and turn it off if alerts start failing.
        ${isNativeShell()
          ? ' Needs Orbot installed and running; flock never falls back to a plain connection silently: if the Tor route isn\'t ready, sending fails loudly instead.'
          : ' Needs the flock app (not this browser) plus Orbot; the web version has no way to reach it.'}</div>
    </div>
    <div class="section-title" style="margin-top:18px">Circle security</div>
    <div class="card stack">
      <button class="btn small" data-action="reseed">Reset this circle's security</button>
      <div class="note">Creates a fresh secret and hands it privately to the members you keep. Do this if an invite may have leaked.</div>
      ${members().filter((pk) => pk !== me.pk).map((pk) => removeConfirmPk === pk
        ? `<div class="row">${avatarHtml(pk, false, true)}<span class="who" style="font-size:14px">${esc(nameFor(pk))}</span></div>
           <div class="note" style="color:var(--alert)">Removes ${esc(nameFor(pk))} and resets the circle's security — they're cut off straight away.</div>
           <div class="row" style="gap:10px">
             <button class="btn small ghost" style="color:var(--alert);border-color:var(--alert-dim)" data-action="remove-member" data-pk="${pk}">Remove</button>
             <button class="btn small ghost" data-action="cancel-remove">Cancel</button>
           </div>`
        : `<div class="row">${avatarHtml(pk, false, true)}<span class="who" style="font-size:14px">${esc(nameFor(pk))}</span><button class="btn small ghost" style="margin-left:auto" data-action="ask-remove" data-pk="${pk}">Remove</button></div>`).join('') || '<div class="note">No other members yet.</div>'}
    </div>
    <div class="section-title" style="margin-top:18px">This circle</div>
    <div class="card stack">
      <div class="kv"><span class="k">Name</span><span>${esc(c.name)}</span></div>
      <div class="kv"><span class="k">Lifetime</span><span>${c.expiresAt ? `temporary · ends in ${fmtTtl(c.expiresAt)}` : 'ongoing'}</span></div>
      <button class="btn ghost" data-action="leave">Leave this circle</button>
      <div class="note">Leaving removes it from this device only. Your other circles and your key stay put.</div>
      ${disbandConfirm
        ? `<div class="note" style="color:var(--alert)">This ends “${esc(c.name)}” for <strong>everyone</strong> and wipes its key — it can't be undone.</div>
           <div class="row" style="gap:10px">
             <button class="btn small ghost" style="color:var(--alert);border-color:var(--alert-dim)" data-action="disband">Disband for everyone</button>
             <button class="btn small ghost" data-action="cancel-disband">Cancel</button>
           </div>`
        : '<button class="btn small ghost" style="color:var(--alert)" data-action="ask-disband">Disband for everyone…</button>'}
    </div>
    <div class="section-title" style="margin-top:18px">App lock</div>
    <div class="card stack">
      ${!persisted.lock
        ? `${hint('applock', 'With the lock on, everything flock keeps on this phone is encrypted — someone with the phone (or a copy of it) gets nothing without your PIN.')}
           <div class="field"><label for="lock-pin">PIN</label><input class="input" id="lock-pin" type="password" autocomplete="new-password" placeholder="At least ${MIN_LOCK_PIN} characters" /></div>
           <div class="field"><label for="lock-pin2">Same PIN again</label><input class="input" id="lock-pin2" type="password" autocomplete="new-password" /></div>
           <button class="btn small" data-action="lock-enable">Turn on the lock</button>
           <div class="note">You'll be asked for it after 15 minutes away. If you forget it, only a backup (the card above) gets you back in — make one first.</div>`
        : store.restArmed()
          ? `<div class="note">✓ Locked at rest. flock asks for your PIN after 15 minutes away; everything stored on this phone stays encrypted.</div>
             <button class="btn small ghost" data-action="lock-off">Turn off</button>`
          : `<div class="note" style="color:var(--warn, #d9a05b)">The lock is set up but storage is currently unlocked — that happens after bringing flock back from hiding. Re-enter a PIN to lock it again.</div>
             <div class="field"><label for="lock-repin">PIN</label><input class="input" id="lock-repin" type="password" autocomplete="new-password" /></div>
             <div class="row" style="gap:10px">
               <button class="btn small" data-action="lock-reconfirm">Re-lock now</button>
               <button class="btn small ghost" data-action="lock-off">Turn off</button>
             </div>`}
    </div>
    <div class="section-title" style="margin-top:18px">If you're forced to unlock</div>
    <div class="card stack">
      ${persisted.decoy
        ? `<div class="note">✓ Hiding is on. Hold the <strong>flock</strong> name at the top of any screen for a second — everything disappears and the app looks brand new.</div>
           <div class="note">To come back: <strong>Restore from backup</strong> on the welcome screen → type anything as the code, your unlock phrase as the passphrase.</div>
           <div class="row" style="gap:10px">
             <button class="btn small" data-action="decoy-hide">Hide flock now</button>
             <button class="btn small ghost" data-action="decoy-off">Turn off</button>
           </div>`
        : `${hint('decoy', 'If someone makes you open flock, hiding makes it look brand new — circles, places and alerts all out of sight until you bring them back with your phrase.')}
           <div class="field"><label for="decoy-pass">Unlock phrase</label><input class="input" id="decoy-pass" type="password" autocomplete="new-password" placeholder="Pick a phrase only you know" /></div>
           <div class="field"><label for="decoy-pass2">Same phrase again</label><input class="input" id="decoy-pass2" type="password" autocomplete="new-password" /></div>
           <button class="btn small" data-action="decoy-enable">Turn on hiding</button>
           <div class="note">If you forget the phrase while hidden, only a backup (the card above) can bring things back — make one first.</div>`}
    </div>
    <div class="card stack" style="margin-top:14px">
      ${resetConfirm
        ? `<div class="note" style="color:var(--alert)">This wipes your key and every circle from this device. Without a backup (the card above) there is <strong>no way back</strong>.</div>
           <div class="row" style="gap:10px">
             <button class="btn small ghost" style="color:var(--alert);border-color:var(--alert-dim)" data-action="reset-device">Wipe this device</button>
             <button class="btn small ghost" data-action="cancel-reset">Cancel</button>
           </div>`
        : `<button class="btn small ghost" data-action="ask-reset">Sign out &amp; reset this device…</button>
           <div class="note">Wipes your key and every circle from this browser.</div>`}
    </div>
  `
}

function navView(): string {
  const item = (id: string, label: string, icon: string, unread = 0, dot = false): string =>
    `<button data-action="tab" data-tab="${id}" aria-current="${tab === id}">${icon}<span>${label}</span>${unread ? `<span class="nav-badge">${unread > 9 ? '9+' : unread}</span>` : dot ? '<span class="nav-dot" aria-label="Update available"></span>' : ''}</button>`
  const youUnread = dmUnreadTotal()
  // An available update is a nudge, not urgent — a small dot on You (where the
  // download lives), never a big card muscling in on Home. Yields to a real
  // unread count instead of stacking two badges on one icon.
  return `<nav class="nav">${item('home', 'Home', ICON.home)}${item('chat', 'Chat', ICON.chat, groupUnreadTotal())}${item('circle', 'Circle', ICON.circle)}${item('you', 'You', ICON.you, youUnread, !youUnread && updateAvailable)}</nav>`
}

// ── Map screen ───────────────────────────────────────────────────────────────
/** The circle chat, full screen — one running Signal-style thread. Was the
 *  Map tab's nav slot; the map moved to Home (it IS Home now), so this became
 *  free for the conversation instead of living squeezed under the map. */
function chatView(): string {
  const c = activeCircle() as store.Circle
  return `
    ${topbar()}
    ${chatSection(c)}`
}

// ── Views: onboarding ────────────────────────────────────────────────────────
/** The location-posture + detail pickers shown when creating OR joining a circle
 *  — a per-circle, device-local default each member picks for themselves. */
function postureFields(): string {
  const track = (v: 'always' | 'private', label: string): string =>
    `<button class="btn small${onboardTracking === v ? ' primary' : ''}" data-action="ob-track" data-track="${v}">${esc(label)}</button>`
  const prec = (v: number, label: string): string =>
    `<button class="btn small${onboardPrecision === v ? ' primary' : ''}" data-action="ob-prec" data-prec="${v}">${esc(label)}</button>`
  return `
      <div class="field" style="text-align:left;margin-bottom:6px"><label>Location sharing</label></div>
      <div class="chip-row" role="group" aria-label="Location sharing" style="margin-bottom:6px;justify-content:center">${track('private', 'Private')}${track('always', 'Always share')}</div>
      <div class="note" style="margin-bottom:14px">${onboardTracking === 'private'
        ? 'Hidden by default — your location goes out only when you check in or answer a request.'
        : 'Shared continuously with this circle whenever sharing is on.'}</div>
      <div class="field" style="text-align:left;margin-bottom:6px"><label>Detail when you share</label></div>
      <div class="chip-row" role="group" aria-label="Detail" style="margin-bottom:18px;justify-content:center">${prec(6, 'Area')}${prec(7, 'Street')}${prec(9, 'Exact')}</div>`
}

function onboardingView(): string {
  let inner: string
  if (onboardStep === 'create') {
    const ttlChip = (mode: string, label: string): string =>
      `<button class="btn small${ttlMode === mode ? ' primary' : ''}" data-action="ob-ttl" data-ttl="${mode}">${label}</button>`
    inner = `
      <h1>New circle</h1>
      <p class="tagline">Give it a name and choose how long it lasts.</p>
      <div class="field" style="text-align:left;margin-bottom:14px"><label for="cname">Name</label><input class="input" id="cname" placeholder="Mallorca trip · Flatmates · Sat night" /></div>
      <div class="field" style="text-align:left;margin-bottom:6px"><label>How long</label></div>
      <div class="chip-row" role="group" aria-label="Lifetime" style="margin-bottom:10px;justify-content:center">
        ${ttlChip('ongoing', 'Ongoing')}${ttlChip('today', 'Today')}${ttlChip('custom', 'Custom')}
      </div>
      <div id="ob-ttl-custom" class="row" style="gap:8px;justify-content:center;margin-bottom:18px"${ttlMode === 'custom' ? '' : ' hidden'}>
        <input class="input" id="ttl-num" type="number" min="1" max="60" value="3" style="max-width:84px" />
        <select class="input" id="ttl-unit" style="max-width:120px"><option value="hours">hours</option><option value="days" selected>days</option></select>
      </div>
      ${postureFields()}
      <div class="actions">
        <button class="btn primary" data-action="do-create">Create circle</button>
        <button class="btn ghost" data-action="back">Back</button>
      </div>`
  } else if (onboardStep === 'join') {
    inner = `
      <h1>Join a circle</h1>
      <p class="tagline">With them now? Scan the QR they're showing. Otherwise type the six words someone read you — just the first few letters of each finds it — or paste an invite code, or join remotely by sharing your key.</p>
      ${postureFields()}
      <div class="actions" style="margin-bottom:18px">
        <button class="btn primary" data-action="scan-join">📷 Scan their invite QR</button>
      </div>
      <div class="field" style="text-align:left;margin-bottom:4px"><label for="jwords">Spoken words</label><input class="input" id="jwords" placeholder="six words, in order" autocapitalize="off" autocorrect="off" spellcheck="false" /></div>
      <div id="jwords-suggest" class="word-suggest"></div>
      <div class="actions" style="margin-bottom:18px">
        <button class="btn" data-action="join-words"${spokenCodeBusy ? ' disabled' : ''}>${spokenCodeBusy ? 'Finding invite…' : 'Join with words'}</button>
      </div>
      <div class="field" style="text-align:left;margin-bottom:16px"><label for="jcode">Or paste an invite code</label><textarea class="input" id="jcode" rows="3" placeholder="Paste code…"></textarea></div>
      <div class="actions">
        <button class="btn" data-action="do-join">Join with code</button>
        <button class="btn" data-action="join-remote">Join remotely (share my key)</button>
        <button class="btn ghost" data-action="back">Back</button>
      </div>`
  } else if (onboardStep === 'restore') {
    inner = `
      <h1>Restore from backup</h1>
      <p class="tagline">Paste your backup code and unlock it with its passphrase — your key and circles come back exactly as they were.</p>
      <div class="field" style="text-align:left;margin-bottom:12px"><label for="restore-code">Backup code</label><textarea class="input" id="restore-code" rows="4" placeholder="Paste backup code…"></textarea></div>
      <div class="field" style="text-align:left;margin-bottom:16px"><label for="restore-pass">Passphrase</label><input class="input" id="restore-pass" type="password" autocomplete="current-password" /></div>
      <div class="actions">
        <button class="btn primary" data-action="do-restore">Restore</button>
        <button class="btn ghost" data-action="back">Back</button>
      </div>`
  } else if (onboardStep === 'await') {
    const np = persisted.identity ? fullNpub(persisted.identity.pk) : ''
    inner = `
      <h1>Join remotely</h1>
      <p class="tagline">Share your key with whoever's inviting you. You'll join automatically when they send the invite.</p>
      <div class="qr" id="qr-npub"></div>
      <div class="invite-code" id="my-npub">${esc(np)}</div>
      <div class="actions">
        <button class="btn primary" data-action="copy-npub">Copy my key</button>
        <button class="btn ghost" data-action="back">Cancel</button>
      </div>
      <div class="note" style="margin-top:12px">⟳ Waiting for a secure invite…</div>
      ${awaitSince && Date.now() - awaitSince > AWAIT_GUIDE_MS
        ? '<div class="note" style="margin-top:8px">Still waiting — check the inviter has your key and has tapped “Send encrypted invite”. It can take a minute on a slow connection. Or cancel and ask them for an invite code instead.</div>'
        : ''}`
  } else if (adding) {
    inner = `
      <h1>Add a circle</h1>
      <p class="tagline">Create another circle or join one — you can be in many at once: friends, a trip, a night out.</p>
      <div class="actions">
        <button class="btn primary" data-action="create">Create a circle</button>
        <button class="btn" data-action="join">Join with a code</button>
        <button class="btn ghost" data-action="join-remote">Join remotely (share my key)</button>
        <button class="btn ghost" data-action="cancel-add">Cancel</button>
      </div>`
  } else {
    const signedInSignet = persisted.authMethod === 'signet' && persisted.identity
    const signetRow = signedInSignet
      ? '<div class="note" style="margin-top:16px">✓ Signed in with your signer — your key stays there, never in flock</div>'
      : `<button class="btn ghost" data-action="signet" style="margin-top:10px">Sign in with a signer</button>
         ${hint('signer', 'Use Signet, Amber (Android/GrapheneOS), nsec.app, or any Nostr signing app — your key stays in it, flock never holds it. The strongest option for real use.')}`
    // The APK download must be unmissable for the people who can use it (Android
    // browsers) and quiet for everyone else (iPhone/desktop can't install it).
    const getApp = isNativeShell()
      ? ''
      : /android/i.test(navigator.userAgent)
        ? `<a class="btn get" href="./get.html">⬇&nbsp; Get the Android app</a>
           ${hint('get-app', "The app can keep sharing in the background, even with the phone in a pocket. This website only works while it's open.")}`
        : '<div class="note onboard-note">On Android or GrapheneOS? <a href="./get.html">Get the app</a>. It can keep sharing in the background. This website only works while open.</div>'
    inner = `
      <img class="hero-logo" src="./icon.svg" alt="" />
      <h1>Stay close,<br/>stay private.</h1>
      <p class="tagline">Share where you are with the people you choose — as roughly or as exactly as you like. Nobody else can see a thing.</p>
      <div class="actions">
        <button class="btn primary" data-action="create">Create a circle</button>
        <button class="btn ghost" data-action="join">Join with a code</button>
        <button class="btn ghost" data-action="restore">Restore from backup</button>
        ${getApp}
        ${signetRow}
      </div>
      <div class="note onboard-note">No account, no sign-up. flock makes an anonymous key that lives only on this phone.</div>
      <div class="app-version">version ${esc(__FLOCK_BUILD__)} · ${esc(__FLOCK_BUILT_AT__)}</div>`
  }
  return `<main class="screen onboard fade-in">${inner}</main><div class="toast" id="toast"></div>`
}

// ── Wiring ───────────────────────────────────────────────────────────────────
function legalGateView(): string {
  return `<main class="screen onboard legal-gate fade-in">
    <img class="hero-logo" src="./icon.svg" alt="" />
    <div class="eyebrow">Adults only</div>
    <h1>Before you enter</h1>
    <p class="tagline">flock is a personal, non-commercial experiment for adults choosing to share with other adults. Do not install it on, hand it to, or use it to track a child.</p>
    <div class="legal-checks">
      <label class="legal-check"><input id="legal-adult" type="checkbox" /><span>I am 18 or older</span></label>
      <label class="legal-check"><input id="legal-consent" type="checkbox" /><span>I will only use flock with consenting adults</span></label>
    </div>
    <p class="legal-gate-note">By entering, you agree to the <a href="./terms.html" target="_blank" rel="noopener">Terms</a> and confirm you have read the <a href="./privacy.html" target="_blank" rel="noopener">Privacy Policy</a> and <a href="./legal.html" target="_blank" rel="noopener">safety notice</a>.</p>
    <button class="btn primary" data-action="accept-legal" disabled>Enter flock</button>
    <p class="legal-gate-error" id="legal-gate-error" role="status" hidden>flock cannot record your choice in this browser. Enable local storage before continuing.</p>
  </main>`
}

function wireLegalGate(): void {
  const adult = document.getElementById('legal-adult') as HTMLInputElement | null
  const consent = document.getElementById('legal-consent') as HTMLInputElement | null
  const enter = root.querySelector<HTMLButtonElement>('[data-action="accept-legal"]')
  const error = document.getElementById('legal-gate-error')
  if (!adult || !consent || !enter) return

  const sync = (): void => { enter.disabled = !(adult.checked && consent.checked) }
  adult.addEventListener('change', sync)
  consent.addEventListener('change', sync)
  enter.addEventListener('click', () => {
    if (!adult.checked || !consent.checked) return
    try {
      recordLegalAcceptance()
      legalAccepted = true
      bootUnlocked()
    } catch {
      if (error) error.hidden = false
      enter.disabled = true
    }
  })
}

/** Type-ahead under the "spoken words" join field: as you type the word
 *  currently in progress (the last space-separated token), show up to 6
 *  matches starting with those letters — tapping one completes it and moves
 *  on to the next word. You only need to recognise a word, not spell it
 *  correctly from memory. */
function wireWordSuggest(): void {
  const input = document.getElementById('jwords') as HTMLInputElement | null
  const box = document.getElementById('jwords-suggest')
  if (!input || !box) return
  const render = (): void => {
    const value = input.value
    const current = value.split(/\s+/).pop() ?? ''
    // Wait for at least 4 letters before ever completing or suggesting: every
    // collision in this wordlist shares exactly a 4-letter prefix (never
    // fewer), so completing any earlier — e.g. "err" is already unique to
    // "error" — would fill in the rest before someone who types a consistent
    // 4 letters out of habit reaches their 4th keystroke, landing it after
    // the auto-inserted space and corrupting the field.
    if (current.length < 4) { box.innerHTML = ''; return }
    const matches = suggestWords(current)
    // Unambiguous (exactly one word starts with this, and there's more of it
    // left to type) — complete it the instant it's determined, no tap needed.
    // Fewer taps means fewer chances to grab the wrong one. A word that's
    // ALSO a prefix of another (e.g. "code"/"codex") still matches >1 here,
    // so it's never silently auto-picked.
    if (matches.length === 1 && matches[0].length > current.length) {
      const prefix = value.slice(0, value.length - current.length)
      input.value = `${prefix}${matches[0]} `
      box.innerHTML = ''
      return
    }
    // Chips only ever appear now for a genuine collision (two-plus words
    // share this prefix) — this wordlist isn't fully BIP39-unique at 4
    // letters, so that does happen. Flagged, not just listed, since picking
    // wrong here silently derives the wrong code with no other symptom.
    box.innerHTML = matches.length > 1
      ? `<div class="suggest-pick-note">Which one?</div><div class="suggest-chips">${matches.map((w) => `<button type="button" class="suggest-chip" data-word="${esc(w)}">${esc(w)}</button>`).join('')}</div>`
      : ''
    box.querySelectorAll<HTMLElement>('.suggest-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const word = chip.dataset.word ?? ''
        const prefix = value.slice(0, value.length - current.length)
        input.value = `${prefix}${word} `
        input.focus()
        render()
      })
    })
  }
  input.addEventListener('input', render)
}

function wireOnboard(): void {
  if (onboardStep === 'await') {
    const qrEl = document.getElementById('qr-npub')
    if (qrEl && persisted.identity) {
      try {
        const qr = qrcode(0, 'L')
        // A link, never bare text (same lesson as the join QR): the inviter's camera
        // opens flock with this key already filled into the send-invite form.
        qr.addData(`${shareOrigin()}/#invite=${fullNpub(persisted.identity.pk)}`)
        qr.make()
        qrEl.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true })
      } catch { qrEl.remove() }
    }
  }
  if (onboardStep === 'join') wireWordSuggest()
  root.querySelectorAll('[data-action]').forEach((node) => {
    node.addEventListener('click', () => {
      const a = node.getAttribute('data-action')
      if (a === 'create') { onboardStep = 'create'; rerenderOnboard() }
      else if (a === 'join') { onboardStep = 'join'; rerenderOnboard() }
      else if (a === 'restore') { onboardStep = 'restore'; rerenderOnboard() }
      else if (a === 'do-restore') void doRestore()
      else if (a === 'back') { onboardStep = 'intro'; rerenderOnboard() }
      else if (a === 'ob-ttl') {
        // Update in place too, for the same reason as ob-mode.
        ttlMode = (node as HTMLElement).dataset.ttl as 'ongoing' | 'today' | 'custom'
        root.querySelectorAll<HTMLElement>('[data-action="ob-ttl"]').forEach((b) => b.classList.toggle('primary', b.dataset.ttl === ttlMode))
        const cust = document.getElementById('ob-ttl-custom')
        if (cust) (cust as HTMLElement).hidden = ttlMode !== 'custom'
      }
      else if (a === 'ob-track') { onboardTracking = (node as HTMLElement).dataset.track === 'always' ? 'always' : 'private'; render() }
      else if (a === 'ob-prec') { onboardPrecision = Number((node as HTMLElement).dataset.prec) || 6; render() }
      else if (a === 'cancel-add') { adding = false; onboardStep = 'intro'; render() }
      else if (a === 'do-create') doCreate()
      else if (a === 'do-join') doJoin()
      else if (a === 'scan-join') openJoinScanner()
      else if (a === 'join-words') void joinWithWords()
      else if (a === 'join-remote') doJoinRemote()
      else if (a === 'copy-npub') copyNpub()
      else if (a === 'signet') void doSignetLogin()
    })
  })
}
function rerenderOnboard(): void { const keep = captureFocusedInput(); root.innerHTML = onboardingView(); wireOnboard(); restoreFocusedInput(keep) }

function wireApp(): void {
  const qrEl = document.getElementById('qr')
  const ac = activeCircle()
  if (qrEl && ac) {
    try {
      // Level 'L' (7% EC): scanning a clean screen has no damage to correct for,
      // so the lowest EC gives the sparsest code — fewer, bigger modules that a
      // phone camera resolves far more easily than the denser 'M'.
      const qr = qrcode(0, 'L')
      // A LINK, never bare text: camera apps open links, but bare text they offer
      // to web-search — which would hand the seed to a search engine (see inviteLink).
      qr.addData(store.inviteLink(ac, shareOrigin()))
      qr.make()
      // margin = 4 modules (16px at cellSize 4): the quiet zone the spec needs to
      // detect the finder pattern, baked into the SVG so it scales with the code.
      qrEl.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true })
    } catch { qrEl.remove() }
  }
  root.querySelectorAll('[data-action]').forEach((node) => {
    const action = node.getAttribute('data-action') as string
    node.addEventListener('click', () => handleAction(action, node as HTMLElement))
  })
  wirePrecisionSlider()
  const strip = document.getElementById('home-strip')
  if (strip) wireMemberStrip(strip)
  const brand = root.querySelector<HTMLElement>('.topbar .brand')
  if (brand) wireHideHold(brand)
  root.querySelectorAll<HTMLElement>('.circle-chip:not(.add)').forEach((chip) => {
    const id = chip.getAttribute('data-id')
    if (id) wireChipHold(chip, id)
  })
  if (tab === 'home') void initMap()
}

/** The "location detail" slider (lives on Circle). `input` patches the labels
 *  in place (a full render mid-drag would tear the control out from under the
 *  thumb); `change` commits: persist, re-tier sampling, and re-emit promptly
 *  so the circle sees the new detail level straight away.
 *  Two guards against "it changed by itself":
 *  - while a finger is on the thumb, background refreshes are DEFERRED
 *    (sliderDragging → refreshDeferred), so the control is never torn mid-drag,
 *    wherever it currently lives;
 *  - a `change` from a slider no longer in the DOM (a rebuild raced the release)
 *    is ignored — a detached thumb must never commit a stale value. */
let sliderDragging = false
let refreshDeferred = false
// An IME composition in progress anywhere (predictive text on a real Android
// keyboard) — deferred in refresh() alongside sliderDragging; see there for
// why. Attached once, globally: composition events bubble, so every text
// field (chat/dm/jwords/handle/…) is covered without per-field wiring.
let composing = false
document.addEventListener('compositionstart', () => { composing = true })
document.addEventListener('compositionend', () => {
  composing = false
  if (refreshDeferred) { refreshDeferred = false; refresh() }
})
function wirePrecisionSlider(): void {
  const slider = document.getElementById('share-precision') as HTMLInputElement | null
  if (!slider) return
  const dragEnd = (): void => {
    if (!sliderDragging) return
    sliderDragging = false
    if (refreshDeferred) { refreshDeferred = false; refresh() }
  }
  slider.addEventListener('pointerdown', () => { sliderDragging = true })
  slider.addEventListener('pointerup', dragEnd)
  slider.addEventListener('pointercancel', dragEnd)
  slider.addEventListener('blur', dragEnd)
  slider.addEventListener('input', () => {
    const p = Number(slider.value)
    const l = document.getElementById('precision-label')
    if (l) l.textContent = precisionLabel(p)
    const n = document.getElementById('precision-note')
    if (n) n.textContent = precisionNote(p)
  })
  slider.addEventListener('change', () => {
    dragEnd()
    if (!slider.isConnected) return // detached by a rebuild — its value is stale
    commitSharePrecision(Number(slider.value))
  })
}

function commitSharePrecision(value: number): void {
  const c = activeCircle()
  if (!c) return
  const p = Math.min(PRECISION_MAX, Math.max(PRECISION_MIN, Math.round(value)))
  if (p === baseSharePrecision(c)) return // compare to the base, not a festival boost
  patchActive({ sharePrecision: p })
  // The gate keys on the last-sent cell: drop it so the next beacon isn't held
  // back by the min-interval floor — a changed slider should show up promptly.
  beaconCadence.delete(c.id)
  syncWatch() // crossing the street/neighbourhood boundary re-tiers GPS vs low-power
  if (sharing) void autoEmit()
  else refresh()
}

// ── Find each other (festival mode) ──────────────────────────────────────────
/** Raise MY detail to Exact spot for this circle for a set window, capped by
 *  the circle's own lifetime. Starts sharing if it wasn't (the whole point is to be
 *  found), and re-emits at once so the circle sees the step-up promptly. */
function startFestival(hours: number): void {
  const c = activeCircle()
  if (!c) return
  const cap = c.expiresAt ?? Number.MAX_SAFE_INTEGER
  const until = Math.min(nowSec() + Math.round(hours * 3600), cap)
  if (until <= nowSec()) { toast('This circle is about to end'); return }
  patchActive({ festivalUntil: until })
  festivalWasActive = true
  beaconCadence.delete(c.id) // the step-up should show up now, not on the next cadence tick
  bleMeshDesiredLast = meshDesired(); void syncBle() // "find each other" flips BLE-nearby into crowd-mesh mode (if opted in)
  if (!sharing) { startSharing(); return } // startSharing emits at the new (festival) precision
  syncWatch() // exact-spot → high-accuracy GPS sampling tier
  void autoEmit()
  toast(`Find each other on — the circle sees you closely until ${fmtClock(until)}`)
  refresh()
}

/** End the boost early and drop back to the slider's detail immediately. */
function stopFestival(): void {
  const c = activeCircle()
  if (!c) return
  patchActive({ festivalUntil: undefined })
  festivalWasActive = false
  beaconCadence.delete(c.id)
  bleMeshDesiredLast = meshDesired(); void syncBle() // back to discreet mode (or off) now the crowd boost has ended
  syncWatch()
  if (sharing) void autoEmit()
  toast('Find each other off — back to your usual detail')
  refresh()
}

// ── Map controller ───────────────────────────────────────────────────────────
/** Frame a geohash cell (its whole disclosed square, not a point — a Region
 *  cell needs a very different zoom from a street one) and hand the camera
 *  over to the user. Shared by "see on map", the member strip's zoom-on-tap,
 *  and a PM location share's "See on map" jump. */
function frameCell(geohash: string): void {
  if (!mapView) return
  const bb = bounds(geohash)
  mapView.autoFit([{ lat: bb.minLat, lon: bb.minLon }, { lat: bb.maxLat, lon: bb.maxLon }])
  mapView.suppressAutoFit()
}

/** Zoom the (already-mounted) map to one member's cell — the strip's tap
 *  target. A no-op if they have no live beacon yet (nothing to frame) or the
 *  map isn't mounted (e.g. called while switching tabs — initMap's own
 *  focusMemberPk handles that mount-time case instead). */
function focusOnMember(pk: string): void {
  const b = active()?.beacons.get(pk)
  if (b) frameCell(b.geohash)
}

/** Radar mode: person-to-person navigation to one circle member. Strictly a
 *  CONSUMER of what's already disclosed — the target feed is the same cached
 *  beacon the map draws (their chosen precision, unchanged), nothing is
 *  published, and no precision/cadence is raised for anyone. My own position
 *  is sampled locally for my side of the bearing only. Foreground only (the
 *  locked-phone guide mode is a separate native slice). */
function openRadarFor(pk: string): void {
  const id = persisted.identity
  if (!id || !pk || pk === id.pk) return
  // The DM sheet can open radar for a peer who isn't in the ACTIVE circle —
  // prefer the focused circle, else any shared circle holding a beacon of
  // theirs. (Still only ever *their* disclosed beacons — just found wherever
  // they actually disclosed one.)
  const shared = [activeCircle(), ...persisted.circles]
    .filter((x): x is store.Circle => !!x && (x.members ?? []).includes(pk))
  const c = shared.find((x) => cstate(x.id).beacons.get(pk)) ?? shared[0]
  if (!c) return
  const circleId = c.id
  openRadar({
    layer: overlayLayer,
    targetKey: { circleId, pk },
    targetName: () => nameFor(pk),
    getTarget: () => {
      const b = cstate(circleId).beacons.get(pk)
      if (!b) return null
      const d = decode(b.geohash)
      // The cell's disclosed radius is the honesty band — a coarse share reads
      // as a rough area on the scope, never as a precise pointer (FLOCK §6).
      return { lat: d.lat, lon: d.lon, uncertaintyMetres: precisionToRadius(b.precision), timestamp: b.timestamp }
    },
    getMyFix: () => (fix ? { lat: fix.lat, lon: fix.lon, at: fix.at } : null),
    // A dedicated high-accuracy watch for MY side of the bearing while the
    // scope is up — purely local (only onFix-while-sharing ever publishes;
    // this callback just refreshes the local fix), torn down with the radar.
    // Deliberate footprint: navigating is exactly the moment to spend GPS.
    startLocalFix: () => svc.watchLocation((f) => { fix = f }, () => { /* radar shows no-fix */ }, { highAccuracy: true }),
    fmtDistance,
    onClosed: () => { /* the overlay removes itself; nothing to restore */ },
  })
}

/** Open radar navigation to a dropped PIN — a fixed lat/lon target instead of a
 *  member's beacon. Reuses the whole radar: on-screen scope AND, on Android, the
 *  locked-screen haptic/sound guide (walk to your car with the phone in your
 *  pocket). getTarget returns an ever-advancing timestamp so the JS scope never
 *  ages a stationary pin to "stale"; the native guide gets the same via its
 *  evergreen-waypoint flag (see startRadarGuide / RadarGuideService). */
function openRadarForPin(pin: Pin): void {
  const d = decode(pin.geohash)
  openRadar({
    layer: overlayLayer,
    // Sentinel key: a pin never receives beacon interrupts (it doesn't move).
    targetKey: { circleId: activeCircle()?.id ?? '', pk: `pin:${pin.id}` },
    targetName: () => pinKindLabel(pin.kind),
    getTarget: () => ({ lat: d.lat, lon: d.lon, uncertaintyMetres: 0, timestamp: nowSec() }),
    getMyFix: () => (fix ? { lat: fix.lat, lon: fix.lon, at: fix.at } : null),
    startLocalFix: () => svc.watchLocation((f) => { fix = f }, () => { /* radar shows no-fix */ }, { highAccuracy: true }),
    fmtDistance,
    onClosed: () => { /* overlay self-removes */ },
  }, { evergreen: true })
}

/** A tapped pin: navigate to it (radar). */
function navigateToPin(pinId: string): void {
  const c = activeCircle()
  if (!c) return
  const pin = cstate(c.id).pins.find((p) => p.id === pinId && !p.removed)
  if (pin) openRadarForPin(pin)
}

/** Snapshot the live map's camera before we tear it down, so a return to Home
 *  reopens the same view (see `lastCamera`). No-op if the map isn't mounted. */
function rememberCamera(view: MapView | null): void {
  if (!view) return
  const c = view.map.getCenter()
  lastCamera = { lng: c.lng, lat: c.lat, zoom: view.map.getZoom() }
}

async function initMap(camera?: { lng: number; lat: number; zoom: number }): Promise<void> {
  const token = ++mapInitToken
  const mounted = mapView
  mapView = null
  rememberCamera(mounted) // preserve the view across a same-tab re-init too
  mounted?.destroy()
  const container = document.getElementById('map')
  if (!container) return
  const { MapView } = await import('./map') // lazy — keeps maplibre out of the main bundle
  if (token !== mapInitToken || !container.isConnected || document.getElementById('map') !== container) return
  // Open where we last were: a live fix wins; otherwise reopen the restored
  // camera / last view so we never fall back to the London default and animate
  // away from it (the reported "starts in London, zooms to me" on a tab-return).
  const reopen = camera ?? lastCamera
  const seedCentre = fix ?? (reopen ? { lat: reopen.lat, lon: reopen.lng } : undefined)
  const next = await MapView.create(container, seedCentre, { circleId: activeCircle()?.id })
  if (token !== mapInitToken || !container.isConnected || document.getElementById('map') !== container) {
    next.destroy()
    return
  }
  mapView = next
  // Tap a member's pin → their private thread (skip my own pin — that's just me).
  mapView.onMemberClick((pk) => { if (pk && pk !== persisted.identity?.pk) openDmThread(pk) })
  mapView.onPinClick((pinId) => navigateToPin(pinId))
  mapView.onPinLongPress((pinId) => editPin(pinId)) // press-and-hold a dropped pin → move it
  // A full re-init mid-placement (rare — an external render) builds a fresh map;
  // put the pin back where it was (raiseDraftPin re-wires the finger-follow too).
  if (placing && placingPos) raiseDraftPin(placingPos.lat, placingPos.lon)
  if (import.meta.env.DEV) (window as unknown as { flockMapView?: unknown }).flockMapView = mapView // e2e seam (dev only)
  // Restore the prior zoom before data draws (create only takes a centre), so a
  // soft reopen returns at the same scale. A hard `camera` restore (below) also
  // pins the centre and stops auto-framing; a soft reopen leaves member auto-fit free.
  if (!camera && lastCamera) mapView.map.jumpTo({ center: [lastCamera.lng, lastCamera.lat], zoom: lastCamera.zoom })
  updateMapData()
  requestAnimationFrame(() => mapView?.map.resize())
  if (camera) { mapView.map.jumpTo({ center: [camera.lng, camera.lat], zoom: camera.zoom }); mapView.suppressAutoFit() } // a re-init keeps the person's view
  // "See on map": frame the chosen member's whole disclosed cell (a Region cell
  // needs a very different zoom from a street one), then hand the camera over.
  if (focusMemberPk) { focusOnMember(focusMemberPk); focusMemberPk = null }
  // A PM "Come to me" location share, tapped from the DM thread — frame its
  // cell the same way, but it's a one-off (not a live circle beacon), so
  // there's nothing to look up beyond the geohash itself.
  if (focusGeohash) { frameCell(focusGeohash); focusGeohash = null }
  if (offlineMapEnabled()) void refreshOfflineState()
  if (!fix && !camera && !lastCamera) void centreOnCurrentPosition() // first mount, no view to restore → actively locate for the map
}

// Centre the map on the user's current position without starting a share. Purely
// local (nothing is broadcast); silently does nothing if permission is denied.
// With member pins on show, autoFit owns the framing — don't yank to just me.
async function centreOnCurrentPosition(): Promise<void> {
  const f = await svc.currentPosition()
  if (!f) return
  fix = f // remembered locally so the "what they'd see" preview can draw pre-share
  if (mapView && memberPoints().length === 0) mapView.flyTo({ lat: f.lat, lon: f.lon }, { instant: true })
  updateMapData() // the preview ring can draw now a fix exists
}

// ── Offline map ("save this area") ───────────────────────────────────────────
// Off by default until the extract service (server/extract.mjs) is deployed to the
// host; enable with VITE_OFFLINE_MAP=1 or localStorage 'flock.offlinemap'='1'.
function offlineMapEnabled(): boolean {
  // Default ON (audit Slice 10): saving your area once makes the map zero-network —
  // nobody (host or CDN) sees when or where you look. '0' opts out; raster tiles
  // remain the automatic fallback wherever no area is saved.
  if (import.meta.env.VITE_OFFLINE_MAP === '1') return true
  try { return localStorage.getItem('flock.offlinemap') !== '0' } catch { return true }
}

async function refreshOfflineState(): Promise<void> {
  const id = activeCircle()?.id
  const oa = await import('./offlineArea')
  offlineBBox = id ? await oa.savedAreaBBox(id) : null
  updateMapData() // re-evaluate the out-of-area chip against the loaded bounds
}

function memberPoints(): MapPoint[] {
  const me = persisted.identity?.pk
  const cid = activeCircle()?.id
  const st = active()
  if (!st || !cid) return []
  return classifyPresence([...st.beacons.values()], nowSec(), { staleAfterSeconds: 600 }).map((e) => {
    const d = decode(e.geohash)
    const precision = st.beacons.get(e.member)?.precision
    return {
      member: e.member,
      lat: d.lat,
      lon: d.lon,
      label: e.member === me ? 'You' : pinLabel(e.member),
      // A lost phone's pin reads as an alert — the taxi trail everyone watches.
      status: memberLost(cid, e.member) ? 'alert' as const : e.status,
      // Show the disclosed area at its true precision, so a coarse share reads as
      // "roughly here" rather than a deceptively exact pin. The cell rectangle is
      // the honest shape: the member is guaranteed inside the SQUARE the geohash
      // names, and its centre is the grid's, never their position.
      ...(precision ? { radiusMetres: precisionToRadius(precision), cell: bounds(e.geohash) } : {}),
    }
  })
}
/** The active circle's dropped pins as map markers (glyph+name labels). */
function pinPoints(): DroppedPinPoint[] {
  const c = activeCircle()
  if (!c) return []
  const me = persisted.identity?.pk
  return cstate(c.id).pins
    .filter((p) => !p.removed) // tombstones are data, not places
    .filter((p) => p.id !== editingPinId) // the pin being moved shows as the draggable draft instead
    .map((p) => {
      const d = decode(p.geohash)
      const mine = p.from === me
      return { id: p.id, lat: d.lat, lon: d.lon, label: PIN_KINDS[p.kind].label, glyph: PIN_KINDS[p.kind].glyph, mine, who: mine ? undefined : nameFor(p.from) }
    })
}

function updateMapData(): void {
  const pts = memberPoints()
  mapView?.setMembers(pts)
  mapView?.setPins(pinPoints())
  // "See what they see" preview: while NOT sharing, ghost the cell the circle
  // WOULD get at the current slider setting (dashed — clearly not a live pin).
  // While sharing, my real pin/square is already exactly what everyone else sees.
  const c = activeCircle()
  if (!sharing && fix && c) {
    // Others get the CELL, not my raw fix — the square is the whole disclosure.
    const bb = bounds(encode(fix.lat, fix.lon, sharePrecisionOf(c)))
    mapView?.setPreview({ kind: 'polygon', vertices: [
      { lat: bb.minLat, lon: bb.minLon }, { lat: bb.minLat, lon: bb.maxLon },
      { lat: bb.maxLat, lon: bb.maxLon }, { lat: bb.maxLat, lon: bb.minLon },
    ] })
  } else {
    mapView?.setPreview(null)
  }
  // Frame everyone: every shown pin plus my own position, so a circle spread
  // across town is visible at a glance instead of everyone-but-me off-screen.
  // autoFit stands down permanently on the first real gesture.
  const fitPts: { lat: number; lon: number }[] = pts.map((p) => ({ lat: p.lat, lon: p.lon }))
  if (fix) fitPts.push({ lat: fix.lat, lon: fix.lon })
  mapView?.autoFit(fitPts)
  // Out-of-area chip: in offline mode, flag any shown pin beyond the saved map's
  // bounds. We never live-fetch to cover it — leaking a viewport mid-event is wrong.
  const el = document.getElementById('offline-oob')
  if (!el) return
  const bbox = offlineBBox
  const outside = bbox ? pts.filter((p) => !bboxContains(bbox, p.lat, p.lon)) : []
  el.hidden = outside.length === 0
  if (outside.length) el.textContent = `⚠ ${outside.length} ${outside.length === 1 ? 'pin' : 'pins'} outside your saved map`
}

/** Re-render without tearing down a live map. */
function refresh(): void {
  // Never rebuild while an onboarding / add-circle form is on screen — a background
  // refresh would discard a half-typed circle name (the inputs are uncontrolled).
  if (adding || !persisted.identity || !activeCircle()) return
  // Deferred while a finger is on the precision slider (a rebuild mid-drag
  // tears the control out from under the thumb) OR the keyboard has an active
  // IME composition (predictive text/autocomplete) — replacing the focused
  // textarea's DOM node out from under a real Android keyboard mid-composition
  // is what produced "on" + space → "onon": the IME's pending composition gets
  // committed a second time into the freshly-restored field on top of the
  // value captureFocusedInput/restoreFocusedInput already put back. Both
  // resolve via dragEnd/compositionend re-running the deferred refresh once
  // the interaction actually finishes.
  if (sliderDragging || composing) { refreshDeferred = true; return }
  // A reseed (security reset, member removal, monthly rotation) changes which
  // inbox each circle listens on. The full render() path always re-syncs
  // subscriptions, but the in-place branches below did NOT — so sitting on
  // Home (the default, most-common tab) silently kept the OLD subscription
  // alive until a tab switch or restart forced a full render. Idempotent diff
  // against the current subs Map, so calling it every tick is cheap.
  ensureSubscriptions()
  // Home's live map must never be torn down on a background tick — patch its
  // data and floating overlays in place instead. Every other tab is cheap
  // enough (and has no live map/canvas) to just fully re-render.
  if (tab === 'home' && mapView) { updateMapData(); refreshHomeOverlays(); patchBuzzBanner(); patchNavBadges() }
  else render({ animate: false }) // a background refresh must not replay the fade-in (it reads as a flash)
}

/** Keep the nav's unread badges honest during in-place refreshes (a DM landing
 *  while the map is up must still light You) without a full rebuild. */
function patchNavBadges(): void {
  const nav = document.querySelector('.nav')
  if (!nav) return
  const set = (tabId: string, n: number, dot = false): void => {
    const btn = nav.querySelector(`[data-tab="${tabId}"]`)
    if (!btn) return
    btn.querySelector('.nav-dot')?.remove()
    const existing = btn.querySelector('.nav-badge')
    if (!n) {
      existing?.remove()
      if (dot) btn.appendChild(Object.assign(document.createElement('span'), { className: 'nav-dot' }))
      return
    }
    const label = n > 9 ? '9+' : String(n)
    if (existing) { existing.textContent = label; return }
    const el = document.createElement('span')
    el.className = 'nav-badge'
    el.textContent = label
    btn.appendChild(el)
  }
  const youUnread = dmUnreadTotal()
  set('chat', groupUnreadTotal())
  set('you', youUnread, !youUnread && updateAvailable)
}

/** The share toggle + status chip — its own function so both the initial
 *  render and the in-place refresh build identical markup. A compact single
 *  row (icon button, not a full-width one) — Home's hero is the map, not this. */
function homeShareBarInner(): string {
  return `<div class="home-share-row">
      <button class="share-toggle${sharing ? ' on' : ''}" data-action="toggle-share" aria-label="${sharing ? 'Go private' : 'Share location'}" aria-pressed="${sharing}">${ICON.pin}<span class="st-label">${sharing ? 'Go private' : 'Share'}</span></button>
      ${homeMapStatusHtml()}
    </div>
    ${hint('home-watch', "You deliberately started sharing with this circle. On Android it can continue while the phone is locked. Tap Go private to stop; nothing is shared while you're private. You choose how closely under Circle. Tap anyone below to zoom to them, or their pin to message them privately.")}`
}

/** Patch Home's floating overlays in place (alerts, member strip, share bar),
 *  leaving the live map canvas untouched. Home has no text input any more (the
 *  precision slider and chat composer both moved off it), so unlike the old
 *  panel there's no focus/half-typed-value to preserve here. */
function refreshHomeOverlays(): void {
  const c = activeCircle() as store.Circle
  const alerts = document.getElementById('home-alerts')
  if (alerts) alerts.innerHTML = `${geoIssueCard()}${batteryCard()}${rollCallCard()}${lostCard(c)}`
  const strip = document.getElementById('home-strip')
  if (strip) { strip.innerHTML = memberStrip(); wireMemberStrip(strip) }
  const fabs = document.querySelector('.home-fabs')
  if (fabs) fabs.innerHTML = pinsFab() // keep the pins count badge honest as pins land/leave
  const shareBar = document.getElementById('home-share-bar')
  if (shareBar) shareBar.innerHTML = homeShareBarInner()
  ;[alerts, shareBar, fabs].forEach((el) => el?.querySelectorAll('[data-action]').forEach((node) => {
    const action = node.getAttribute('data-action') as string
    node.addEventListener('click', () => handleAction(action, node as HTMLElement))
  }))
}

/** Sync the buzz banner to `activeBuzz` in its own layer, idempotently. If the
 *  banner already matches (same buzzSig) it is left untouched, so a background
 *  refresh tick never replays the entrance animation or re-rings the bell. A
 *  changed buzz updates the text + count IN PLACE (a calm bump), reusing the same
 *  icon element so the ring doesn't restart. A brand-new banner animates once. */
function patchBuzzBanner(): void {
  const existing = bannerLayer.querySelector('.buzz-banner') as HTMLElement | null
  if (!activeBuzz) { existing?.remove(); return }
  const sig = buzzSig()
  if (existing) {
    if (existing.dataset.sig === sig) return
    existing.dataset.sig = sig
    existing.className = buzzClass() // colour may flip (group ↔ private)
    const txt = existing.querySelector('.bz-text')
    if (txt) txt.innerHTML = buzzTextHtml()
    existing.classList.remove('bz-bump'); void existing.offsetWidth; existing.classList.add('bz-bump')
    return
  }
  const tmp = document.createElement('div')
  tmp.innerHTML = buzzBanner()
  const el = tmp.firstElementChild as HTMLElement | null
  if (!el) return
  el.dataset.sig = sig
  el.addEventListener('click', dismissBuzz)
  bannerLayer.prepend(el)
}

// ── Signer (LocalSigner or SignetSigner) ─────────────────────────────────────
let _signer: FlockSigner | null = null
let _signerFor = ''
let signetSigner: FlockSigner | null = null // live Signet signer (from login/restore)
function getSigner(): FlockSigner | null {
  if (persisted.authMethod === 'signet') return signetSigner
  const id = persisted.identity
  if (!id?.skHex) { _signer = null; _signerFor = ''; return null }
  if (_signer && _signerFor === id.skHex) return _signer
  _signer = makeLocalSigner(id.skHex)
  _signerFor = id.skHex
  return _signer
}

async function doSignetLogin(): Promise<void> {
  try {
    // The picker offers Signet, a browser extension (NIP-07), Amber, and any
    // NIP-46 bunker / NostrConnect — every one keeps the key in the signer.
    // nsec-paste is deliberately excluded (see signin.ts).
    const { login } = await import('signet-login')
    const session = await login(buildSignInOptions('flock', [...PRIVATE_RELAYS]))
    if (!session) { toast('Sign-in cancelled'); return }
    // Gift-wrap seals are nip44-encrypted, so a signer without NIP-44 can't
    // drive flock at all — reject it here rather than fail on the first signal.
    if (!session.signer.capabilities.hasNip44) { toast("That signer can't encrypt (needs NIP-44) — try another"); return }
    signetSigner = makeSignetSigner(session.signer)
    persisted.identity = { pk: session.pubkey }
    persisted.authMethod = 'signet'
    store.save(persisted)
    onboardStep = 'intro'
    toast(`Signed in${session.displayName ? ` as ${session.displayName}` : ''}`)
    render()
  } catch { toast('Sign-in failed') }
}

/** On reload, rehydrate the remote signer from its stored session — including
 *  reconnecting a NIP-46 bunker over flock's own no-log relay. */
async function restoreSignet(): Promise<void> {
  if (persisted.authMethod !== 'signet' || signetSigner) return
  try {
    const { restoreSession } = await import('signet-login')
    const session = await restoreSession({ defaultRelay: PRIVATE_RELAYS[0] })
    if (session) { signetSigner = makeSignetSigner(session.signer); render() }
  } catch { /* leave unsigned; user can re-auth */ }
}

/** Publish a flock signal as a gift-wrap to the circle's shared inbox (relay sees only kind:1059). */
async function publishSignal(unsigned: { kind: number; content: string; tags: string[][]; created_at?: number }, circle: store.Circle | null = activeCircle()): Promise<void> {
  const signer = getSigner()
  if (!circle || !signer) return
  const inbox = deriveInbox(circle.seedHex)
  const wrap = await giftWrap(signer, inbox.pk, unsigned)
  // Off-relay hop FIRST, so a relay outage (or airplane mode) never suppresses BLE
  // delivery — working when the relay can't is the whole point of BLE-nearby.
  // Best-effort + never throws. In discreet mode BLE is scoped to the ACTIVE circle
  // (room = its advertId), so only its wraps go out; in crowd mesh the common
  // meshUuid carries EVERY circle, so any circle's wrap floods (only members decrypt).
  if (bleActive && (bleMode === 'mesh' || circle.id === activeCircle()?.id)) {
    try { const ble = await import('../../native/ble'); await ble.broadcastBle(JSON.stringify(wrap)) } catch { /* best-effort */ }
  }
  const relays = activeRelaysOrToast()
  if (!relays) return // Tor is on but not ready — already toasted; never fall back to clearnet
  await svc.publishSigned(relays, wrap as never)
}

// ── Members, invites & reseed ────────────────────────────────────────────────
function members(): string[] { return activeCircle()?.members ?? [] }

function ensureMember(circle: store.Circle, pk: string, expected = false): void {
  // Re-read the live roster rather than trusting the captured `circle`: two
  // first-contact signals arriving together each `await` decryption, and a stale
  // members snapshot would let the later write clobber the earlier one — silently
  // dropping a member (who would then be skipped by reseeds and lists).
  const current = persisted.circles.find((c) => c.id === circle.id)
  if (!current) return
  const patch = store.withNewMember(current, pk, nowSec(), { expected: expected || pk === persisted.identity?.pk })
  if (!patch) return
  patchCircleById(circle.id, patch)
  // Seed possession = membership, so a leaked invite code grants a SILENT member.
  // Surface every unexpected roster addition until it's acknowledged (FLOCK §6).
  if (patch.unseenMembers) toast(`〰️ A new phone joined ${current.name}`)
}

function ensureInviteSub(): void {
  const id = persisted.identity
  if (!id) { stopInviteSub?.(); stopInviteSub = null; inviteSubKey = ''; return }
  // Runs on every render — quiet on a Tor-not-ready failure (the toggle flip
  // and the foreground refresh already own telling the user once).
  const relays = activeRelaysQuiet()
  if (!relays) { stopInviteSub?.(); stopInviteSub = null; inviteSubKey = ''; return }
  const key = `${id.pk}@${relays.join(',')}`
  if (key === inviteSubKey && stopInviteSub) return
  stopInviteSub?.()
  inviteSubKey = key
  // Listen on our derived personal-inbox tag, not our npub — the relay never sees a real key.
  stopInviteSub = svc.subscribeGiftWraps(relays, personalInboxTag(id.pk), (e) => { void onInviteWrap(e) })
}

async function onInviteWrap(e: { pubkey: string; content: string; tags: string[][] }): Promise<void> {
  const signer = getSigner()
  if (!signer) return
  const payload = await readInvite(signer, e)
  if (!payload) {
    // Not an invite/reseed — the same personal inbox also carries private DMs
    // and a PM "Come to me" exact-location share.
    const dm = await readDmWrap(signer, e)
    if (dm) { onIncomingDm(dm); return }
    const loc = await readPrivateLocationWrap(signer, e)
    if (loc) onIncomingLocationShare(loc)
    return
  }
  if (payload.t === 'invite') {
    if (persisted.circles.some((c) => c.id === payload.id)) return // already a member
    // Seed the roster with the inviter (payload.from) as well as myself, so a
    // message from them the moment I join isn't dropped as an unknown sender
    // (onIncomingDm gates on membership). They invited me — they're expected.
    const roster = payload.from && payload.from !== signer.pubkey ? [signer.pubkey, payload.from] : [signer.pubkey]
    const joined: store.Circle = {
      id: payload.id, seedHex: payload.s, name: payload.n, mode: payload.m,
      members: roster, joinedAt: nowSec(), reseededAt: nowSec(), pingConsent: false,
      ...(payload.x ? { expiresAt: payload.x } : {}),
    }
    upsertCircle(joined, true)
    announceJoin(joined) // the inviter expected me, but the REST of the circle didn't
    onboardStep = 'intro'
    adding = false
    tab = 'home'
    toast(`You've joined ${payload.n}`)
    render()
  } else if (payload.t === 'reseed') {
    const existing = persisted.circles.find((c) => c.id === payload.id)
    if (!existing) return
    if (existing.seedHex === payload.s) return // a refresh echo of the seed we already hold — nothing to do
    patchCircleById(existing.id, { seedHex: payload.s, reseededAt: nowSec() })
    cstate(existing.id).beacons.clear()
    cstate(existing.id).lost.clear()
    beaconCadence.delete(existing.id) // new key → re-emit promptly, don't inherit the old cell's heartbeat
    coverCadence.delete(existing.id)
    dropPresence(existing.id) // old-key pins are meaningless under the new seed
    toast("This circle's security was reset")
    refresh()
  }
}

async function sendInvite(): Promise<void> {
  const c = activeCircle()
  const signer = getSigner()
  if (!c || !signer) return
  const raw = (document.getElementById('invite-npub') as HTMLInputElement | null)?.value?.trim()
  if (!raw) { toast('Paste their invite key first'); return }
  let pk: string
  try { pk = raw.startsWith('npub') ? store.npubToHex(raw) : raw } catch { toast("That doesn't look like an invite key — ask them to copy it again"); return }
  if (!/^[0-9a-f]{64}$/.test(pk)) { toast("That doesn't look like an invite key"); return }
  if (pk === signer.pubkey) { toast("That's your own key"); return }
  try {
    const wrap = await buildInviteWrap(signer, pk, { t: 'invite', id: c.id, s: c.seedHex, n: c.name, m: c.mode, ...(c.expiresAt ? { x: c.expiresAt } : {}) })
    await svc.publishSigned(activeRelays(), wrap as never)
    ensureMember(c, pk, true) // I sent this invite — their arrival is not news to me
    pendingInviteNpub = null
    toast('Secure invite sent')
    render()
  } catch { toast('Could not send invite') }
}

async function reseedCircle(removePk?: string, circle: store.Circle | null = activeCircle(), silent = false): Promise<void> {
  const c = circle
  const signer = getSigner()
  if (!c || !signer) return
  persisted.circleRootHex ??= store.newSeed()
  const epoch = (c.epoch ?? 0) + 1
  const seed = deriveCircleSeed(persisted.circleRootHex, c.id, epoch)
  const recipients = (c.members ?? []).filter((pk) => pk !== signer.pubkey && pk !== removePk)
  try {
    if (recipients.length) {
      const wraps = await buildReseedWraps(signer, recipients, { t: 'reseed', id: c.id, s: seed, n: c.name, m: c.mode, ...(c.expiresAt ? { x: c.expiresAt } : {}) })
      for (const w of wraps) await svc.publishSigned(activeRelays(), w as never)
    }
    patchCircleById(c.id, { seedHex: seed, epoch, reseededAt: nowSec(), seedRefreshedAt: nowSec(), members: (c.members ?? []).filter((pk) => pk !== removePk) })
    cstate(c.id).beacons.clear()
    cstate(c.id).lost.clear()
    beaconCadence.delete(c.id) // new key → re-emit promptly, don't inherit the old cell's heartbeat
    coverCadence.delete(c.id)
    dropPresence(c.id) // old-key pins are meaningless under the new seed
    if (!silent) toast(removePk ? 'Member removed — circle security reset' : 'Circle security reset')
    render()
  } catch { if (!silent) toast("Couldn't reset security — try again") }
}

// ── Automatic seed rotation (rotation.ts) ────────────────────────────────────
// An ongoing circle's mailbox (the seed-derived inbox) is its only wire-visible
// pseudonym; rotating it monthly bounds how long a hostile relay can cluster
// traffic against it. Between rotations, the first-ranked member re-wraps the
// current seed weekly so a member offline through a rotation (reseed wraps
// expire — NIP-40) is never locked out. Silent: routine hygiene, not news.
async function maybeRotateSeeds(): Promise<void> {
  const me = persisted.identity?.pk
  const signer = getSigner()
  if (!me || !signer) return
  const now = nowSec()
  for (const c of [...persisted.circles]) {
    if (rotationDue(c, me, now)) {
      await reseedCircle(undefined, c, true)
    } else if (refreshDue(c, me, c.seedRefreshedAt, now)) {
      try {
        const recipients = (c.members ?? []).filter((pk) => pk !== me)
        if (recipients.length) {
          const wraps = await buildReseedWraps(signer, recipients, { t: 'reseed', id: c.id, s: c.seedHex, n: c.name, m: c.mode })
          for (const w of wraps) await svc.publishSigned(activeRelays(), w as never)
        }
        patchCircleById(c.id, { seedRefreshedAt: now })
      } catch { /* transient — the next hourly check retries */ }
    }
  }
}

function isEditing(): boolean {
  const el = document.activeElement
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
}

// Track the active circle's boost so we can re-tier + re-emit the moment its window
// closes — otherwise GPS would keep sampling at the festival (high) tier and the
// last fine beacon would linger on the circle's maps until an unrelated fix.
let festivalWasActive = false
// Whether BLE crowd-mesh was wanted at the last reconcile — so we flip modes only
// on a real transition, never restart the radio on every monitor tick.
let bleMeshDesiredLast = false
/** BLE should be in crowd-mesh mode when opted in and ANY circle is in "find each
 *  other" — even a non-active one, since the common meshUuid spans all circles. */
function meshDesired(): boolean {
  return isNativeShell() && !!persisted.bleNearby && persisted.circles.some((x) => festivalActive(x))
}
function reconcileFestival(): void {
  const now = festivalActive(activeCircle())
  if (festivalWasActive && !now) {
    syncWatch() // exact-spot → drop back to the slider's low-power tier
    if (sharing) void autoEmit() // re-emit coarse so the circle stops seeing me finely
  }
  festivalWasActive = now
  // Follow crowd-mesh on/off when a festival window opens or closes on its own
  // (this includes a non-active circle's, which the check above ignores).
  const md = meshDesired()
  if (md !== bleMeshDesiredLast) { bleMeshDesiredLast = md; void syncBle() }
}

function startMonitor(): void {
  if (monitorTimer) return
  monitorTimer = window.setInterval(() => {
    const expired = sweepExpired()
    if (expired && !adding) { toast('A temporary circle ended'); render(); return }
    reconcileFestival()
    if (!isEditing()) refresh()
  }, 30_000)
}

// ── Fixed group signals ──────────────────────────────────────────────────────
/** Send a provider-defined group action to everyone in the active circle, and
 *  record my own side of the thread (recipients append on decrypt; my echo is
 *  skipped there). The action label appearing in the thread IS the feedback. */
async function sendGroupSignal(action: GroupCoordinationAction): Promise<void> {
  const c = activeCircle()
  const id = persisted.identity
  if (!c || !id) return
  const at = nowSec()
  // Optimistic echo: my own action lands in the thread IMMEDIATELY, decoupled
  // from the network. A slow/stale relay or a stalled BLE hop must never make my
  // tap look like it did nothing (the whole reported bug). The send follows; a
  // genuine failure only toasts — the receiver skips my own echo on replay.
  appendChat(c.id, { from: id.pk, action, at })
  refresh()
  try {
    const tmpl = await buildBuzzSignal({ groupId: c.id, seedHex: c.seedHex, from: id.pk, action, timestamp: at })
    await publishSignal(tmpl, c)
  } catch { toast('Signal failed. Check your connection.') }
}

/** "Check in" — tell EVERY circle I'm OK, and ask them all to show where they
 *  are (a roll-call). Receivers answer on their own terms: an explicit tap, at
 *  their own detail, through the normal policy pipeline (see rollCallCard). */
async function doCheckIn(): Promise<void> {
  const id = persisted.identity
  if (!id) return
  const at = nowSec()
  // Optimistic echo first (see sendGroupSignal): record the check-in in every
  // circle's thread and paint it before the network fan-out, so the tap always
  // registers even on a slow or offline connection.
  for (const c of persisted.circles) appendChat(c.id, { from: id.pk, action: 'check_in', at })
  refresh()
  let sent = 0
  for (const c of persisted.circles) {
    try {
      const tmpl = await buildBuzzSignal({ groupId: c.id, seedHex: c.seedHex, from: id.pk, action: 'check_in', timestamp: at })
      await publishSignal(tmpl, c)
      sent++
    } catch { /* keep going — other circles may still be reachable */ }
  }
  // My own answer to my own roll-call: freshen my pin if I'm already sharing.
  const ac = activeCircle()
  if (sharing && ac) { beaconCadence.delete(ac.id); void autoEmit() }
  toast(sent === 0
    ? "Checked in locally — but couldn't reach the network. Check your connection."
    : sent === 1 ? 'Checked in. Asked everyone to show where they are.'
    : `Checked in with ${sent} circles. Asked everyone to show where they are.`)
  refresh()
}

/** Answer a roll-call: ONE beacon to that circle at my usual detail, through
 *  the same disclosure pipeline as everything else (a private place still caps
 *  or withholds it). Only ever called from an explicit tap. */
async function doRollCallShare(): Promise<void> {
  const ask = locAsk
  locAsk = null
  const c = ask ? persisted.circles.find((x) => x.id === ask.circleId) : null
  const id = persisted.identity
  if (!ask || !c || !id) { refresh(); return }
  const fresh = await svc.currentPosition({ enableHighAccuracy: sharePrecisionOf(c) >= 7, maximumAge: 15_000, timeoutMs: 8000 })
  if (fresh) fix = fresh
  const use = fresh ?? fix
  if (!use) { toast("Couldn't get a fix. Try again by a window."); refresh(); return }
  const plan = decideEmission({
    mode: 'nightout',
    position: { lat: use.lat, lon: use.lon },
    trigger: 'none',
    offGrid: false,
    noReportZones: persisted.noReportZones,
    accuracyMetres: use.accuracy,
  }, { coarse: sharePrecisionOf(c) })
  const type = signalTypeForReason(plan.reason)
  if (!type || type === 'help' || plan.action === 'withhold') {
    toast('Your spot stays private here') // a no-report place wins, quietly
    refresh()
    return
  }
  try {
    const geohash = encode(use.lat, use.lon, plan.precision)
    await publishSignal(await buildLocationSignal({ groupId: c.id, seedHex: c.seedHex, signalType: type, geohash, precision: plan.precision }), c)
    saveBeacon(c.id, { member: id.pk, geohash, precision: plan.precision, timestamp: nowSec() })
    toast(`Shared once with ${c.name}, to within ${precisionSize(plan.precision)}`)
  } catch { toast("Couldn't send. Check your connection.") }
  refresh()
}

/** Ring a lost phone: a targeted buzz the recipient plays as a loud alarm even on
 *  silent (it escalates on receipt because it's flagged lost — see app/src/ring.ts).
 *  No protocol change; on the wire it's an ordinary targeted buzz. */
async function ringPhone(pk: string): Promise<void> {
  const c = activeCircle()
  const id = persisted.identity
  if (!c || !id || !pk) return
  try {
    await publishSignal(await buildBuzzSignal({ groupId: c.id, seedHex: c.seedHex, from: id.pk, action: 'ring_lost_phone', target: pk }), c)
    toast(`Ringing ${nameFor(pk)}'s phone — it'll sound even on silent`)
  } catch { toast("Couldn't ring it — check your connection") }
}

/** Ask a lost phone for a ONE-SHOT exact fix ("find my phone"). Only answers if
 *  the owner pre-authorised this circle AND the phone is flagged lost — see
 *  app/src/findping.ts and docs/plans/2026-07-04-remote-exact-ping.md. */
async function askFindPing(pk: string): Promise<void> {
  const c = activeCircle()
  const id = persisted.identity
  if (!c || !id || !pk) return
  try {
    await publishSignal(await buildFindPingSignal({ groupId: c.id, seedHex: c.seedHex, from: id.pk, target: pk }), c)
    toast(`Asked ${nameFor(pk)}'s phone for an exact location — if it's on and set to allow it, its pin will update`)
  } catch { toast("Couldn't send the request — check your connection") }
}

// ── Remote exact ping — receiving end (the cancel window + one-shot answer) ────
/** Open the cancel window on THIS phone for a qualifying find-ping. The owner can
 *  veto within FIND_PING_CANCEL_SECONDS; otherwise the gates are re-checked and a
 *  single exact beacon is sent. */
function startFindPingCountdown(circleId: string, from: string): void {
  if (findPingPending && findPingPending.circleId === circleId) return // one already counting down
  findPingPending = { circleId, from, deadline: nowSec() + FIND_PING_CANCEL_SECONDS }
  const c = persisted.circles.find((x) => x.id === circleId)
  notifyIfHidden(`${nameFor(from)} is asking this phone for its exact location to find it`, { kind: 'alert', title: c?.name ?? 'flock', group: `findping:${circleId}` })
  try { navigator.vibrate?.([300, 120, 300]) } catch { /* no haptics */ }
  if (findPingTimer) clearTimeout(findPingTimer)
  findPingTimer = window.setTimeout(() => { void resolveFindPing() }, FIND_PING_CANCEL_SECONDS * 1000)
  render()
}

async function resolveFindPing(): Promise<void> {
  const p = findPingPending
  findPingPending = null
  findPingTimer = 0
  if (!p) return
  const c = persisted.circles.find((x) => x.id === p.circleId)
  const me = persisted.identity
  // Re-check the gates at fire time — the owner may have cleared the lost flag or
  // revoked consent during the window. Silent if any gate now fails.
  if (c && me && c.pingConsent && memberLost(c.id, me.pk)?.lost) {
    const r = await sendExactBeacon(c)
    if (r === 'sent') pingAnsweredAt.set(c.id, nowSec())
  }
  render()
}

function cancelFindPing(): void {
  findPingPending = null
  if (findPingTimer) { clearTimeout(findPingTimer); findPingTimer = 0 }
  toast('Kept your exact location private')
  render()
}

/** Mark (or clear) a member's phone as lost, to the whole circle. Anyone may do
 *  either — the owner doesn't have their phone, so gating on them is useless.
 *  Latest report wins on every device (see the lost signal's inner timestamp).
 *  `message` is the reporter's own note ("left in the blue Uber") shown on the
 *  lost phone's own card instead of the generic text — only meaningful when
 *  marking lost, never on a clear. */
async function sendLostReport(pk: string, lost: boolean): Promise<void> {
  const c = activeCircle()
  const id = persisted.identity
  if (!c || !id || !pk) return
  try {
    // No free-text note: a lost report carries only the fixed flag, never prose.
    const report: LostReport = { member: pk, by: id.pk, lost, timestamp: nowSec() }
    await publishSignal(await buildLostSignal({ groupId: c.id, seedHex: c.seedHex, ...report }), c)
    cstate(c.id).lost.set(pk, report)
    if (!lost && pk === id.pk && beingRung?.circleId === c.id) beingRung = null // "I've got it" stops the ring card
    lostConfirmPk = null
    toast(lost
      ? `${nameFor(pk)}'s phone is flagged as lost — keep an eye on its last seen`
      : pk === id.pk ? "Cleared — your circle knows it's not lost" : `✓ ${nameFor(pk)}'s phone is marked found`)
  } catch { toast("Couldn't send — check your connection") }
  refresh()
}

function buzzClass(): string {
  return `buzz-banner${activeBuzz?.mine ? ' for-me' : ''}${activeBuzz?.private ? ' private' : ''}`
}
/** The banner's text: sender · reason · circle, plus a "+N" pill when buzzes have
 *  stacked. A private DM reads as "just you", never a circle-wide bell. */
function buzzTextHtml(): string {
  if (!activeBuzz) return ''
  const who = activeBuzz.from === persisted.identity?.pk ? 'You' : nameFor(activeBuzz.from)
  const where = activeBuzz.circle ? ` · ${esc(activeBuzz.circle)}` : ''
  const tail = activeBuzz.private ? ' · just you' : ''
  const more = buzzCount > 1 ? ` <span class="bz-count">+${buzzCount - 1}</span>` : ''
  return `<strong>${esc(who)}</strong> · ${esc(activeBuzz.reason)}${where}${tail}${more}`
}
/** Identity of the currently-shown banner — patchBuzzBanner leaves the DOM alone
 *  when this is unchanged, so a background refresh never restarts the animation. */
function buzzSig(): string {
  return activeBuzz ? `${activeBuzz.from}|${activeBuzz.reason}|${activeBuzz.circle ?? ''}|${activeBuzz.private ? 1 : 0}|${activeBuzz.mine ? 1 : 0}|${buzzCount}` : ''
}
function buzzBanner(): string {
  if (!activeBuzz) return ''
  const icon = activeBuzz.private ? '🔒' : '🔔'
  return `<div class="${buzzClass()}" data-action="dismiss-buzz" role="alert">
    <span class="bz-icon">${icon}</span>
    <span class="bz-text">${buzzTextHtml()}</span>
    <span class="bz-x">✕</span>
  </div>`
}

/** Raise an incoming buzz/DM. Coalesces with the banner already on screen (a
 *  running count) instead of replacing it, and (re)arms the auto-dismiss. Group
 *  buzzes and private DMs never share a count — different colour and urgency. */
function raiseBuzz(b: NonNullable<typeof activeBuzz>): void {
  buzzCount = activeBuzz && !!activeBuzz.private === !!b.private ? buzzCount + 1 : 1
  activeBuzz = b
  if (buzzTimer) clearTimeout(buzzTimer)
  buzzTimer = window.setTimeout(dismissBuzz, BUZZ_LINGER_MS)
  patchBuzzBanner()
}
function dismissBuzz(): void {
  if (buzzTimer) { clearTimeout(buzzTimer); buzzTimer = 0 }
  activeBuzz = null
  buzzCount = 0
  patchBuzzBanner()
}

/** The cancel window for a remote "find my phone" request: the owner's veto
 *  before this phone answers with an exact fix. Shown globally (any tab) — if
 *  you're holding your phone and didn't lose it, this is your chance to say no. */
function findPingBanner(): string {
  if (!findPingPending) return ''
  const from = nameFor(findPingPending.from)
  return `<div class="findping-banner" role="alert">
    <span class="bz-icon">📍</span>
    <span class="bz-text"><strong>${esc(from)}</strong> is asking this phone for its exact location to find it. It'll share in a moment — tap Cancel to keep it private.</span>
    <button class="btn small" data-action="cancel-findping">Cancel</button>
  </div>`
}

/** Per-circle standing consent: may this circle ask my phone for an exact fix if
 *  it's lost? Off by default; device-local (never synced). */
function togglePingConsent(): void {
  const c = activeCircle()
  if (!c) return
  const on = !c.pingConsent
  patchActive({ pingConsent: on })
  toast(on
    ? 'On — if your phone is lost, this circle can ask it for an exact location'
    : 'Off — this circle can no longer ask your phone for an exact location')
  render()
}

// ── Private coordination actions ─────────────────────────────────────────────
/** Send one provider-defined private action to ONE member — gift-wrapped to
 *  their personal inbox, never the shared circle inbox, so only they can read
 *  it. The fixed action label rides as the wrap's `text` (covey-kit's DM API);
 *  current clients validate and re-derive the action on receipt. */
async function sendDm(pk: string, action: DirectCoordinationAction): Promise<void> {
  const c = activeCircle()
  const signer = getSigner()
  const id = persisted.identity
  if (!c || !signer || !id) return
  if (pk === id.pk) { toast("That's you"); return }
  // Optimistic echo (see sendGroupSignal): my side of the thread updates now,
  // not after the network round-trip.
  appendDm(pk, { from: id.pk, action, at: nowSec() })
  if (dmPeer === pk) updateDmThread()
  try {
    const wrap = await buildDmWrap(signer, pk, { circleId: c.id, text: coordinationLabel(action) })
    await svc.publishSigned(activeRelays(), wrap as never)
  } catch { toast('Signal failed — check your connection') }
}

/** Open a private 1:1 thread with one member. Mounted as an overlay so it never
 *  tears down a live map underneath. Opening it IS reading it. */
function openDmThread(pk: string): void {
  if (!pk || pk === persisted.identity?.pk) return
  dmPeer = pk
  markThreadRead(dmKeyOf(pk))
  mountDmSheet()
}
function closeDmThread(): void {
  dmPeer = null
  document.getElementById('dm-sheet')?.remove()
  refresh() // the You list + nav badge may have just changed (thread read)
}

/** Long-press a circle chip → an action sheet for that circle. What it offers
 *  depends on whether this device created the circle (`joinedAt` unset → the
 *  owner, who can close it for everyone) or joined it (a member, who can only
 *  leave their own copy). Mounted as an overlay so a re-render doesn't tear it. */
function openCircleMenu(id: string): void {
  if (!persisted.circles.some((c) => c.id === id)) return
  circleMenu = id
  chipHeldGuard = true
  window.setTimeout(() => { chipHeldGuard = false }, 700)
  mountCircleMenu()
}
function closeCircleMenu(): void {
  circleMenu = null
  document.getElementById('circle-menu')?.remove()
}
function circleMenuSheet(): string {
  if (!circleMenu) return ''
  const c = persisted.circles.find((x) => x.id === circleMenu)
  if (!c) return ''
  const owner = c.joinedAt === undefined // we created it — no join stamp
  const action = owner
    ? `<button class="btn small ghost" style="color:var(--alert);border-color:var(--alert-dim)" data-action="menu-close">Close group for everyone</button>
       <div class="note">Ends “${esc(c.name)}” for everyone and wipes its key — this can't be undone.</div>`
    : `<button class="btn small ghost" style="color:var(--alert);border-color:var(--alert-dim)" data-action="menu-leave">Leave group</button>
       <div class="note">Removes “${esc(c.name)}” from this phone only. Your other groups and your key stay put; you can rejoin with a new invite.</div>`
  return `<div class="compose-sheet" id="circle-menu" role="dialog" aria-modal="true">
    <div class="compose-card">
      <div class="row" style="justify-content:space-between;align-items:flex-start">
        <strong>${esc(c.name)}</strong>
        <button class="bz-x" data-action="menu-cancel" aria-label="Close">✕</button>
      </div>
      <div class="note">${owner ? 'You created this group.' : 'You’re a member of this group.'}</div>
      ${action}
      <button class="btn small ghost" data-action="menu-cancel">Cancel</button>
    </div>
  </div>`
}
function mountCircleMenu(): void {
  document.getElementById('circle-menu')?.remove()
  if (!circleMenu) return
  const tmp = document.createElement('div')
  tmp.innerHTML = circleMenuSheet()
  const el = tmp.firstElementChild as HTMLElement | null
  if (!el) return
  overlayLayer.appendChild(el)
  el.querySelectorAll('[data-action]').forEach((node) => {
    const a = node.getAttribute('data-action') as string
    node.addEventListener('click', () => handleAction(a, node as HTMLElement))
  })
  el.addEventListener('click', (e) => { if (e.target === el) closeCircleMenu() }) // tap the dim backdrop to dismiss
}
/** The private 1:1 signal sheet. "Come to me" also shares an exact spot with
 *  this person, so it keeps a separate explicit confirmation. */
function dmSheet(): string {
  if (!dmPeer) return ''
  const list = persisted.dms?.[dmPeer] ?? []
  const thread = list.slice(-CHAT_SHOWN).map((m, i, arr) => chatBubble(m, arr[i - 1])).join('')
    || `<div class="note chat-empty">No private signals yet. Choose a fixed action below; only ${esc(nameFor(dmPeer))} can read it.</div>`
  const chip = (action: DirectCoordinationAction): string => action === 'come_to_me'
    ? `<button class="btn small${dmComeToMeArmed ? ' primary' : ''}" data-action="dm-come-to-me">${esc(coordinationLabel(action))}</button>`
    : `<button class="btn small" data-action="dm-signal" data-signal="${action}">${esc(coordinationLabel(action))}</button>`
  // "Find them": radar straight from the person's signals (which is also what a
  // map-pin tap opens) — shown whenever they have a disclosed location in any
  // shared circle. Same consumer-only rules as everywhere else.
  const findCircle = persisted.circles.find((x) => (x.members ?? []).includes(dmPeer as string) && cstate(x.id).beacons.get(dmPeer as string))
  const findBtn = findCircle
    ? `<button class="btn small radar-chip" data-action="radar-member" data-pk="${esc(dmPeer)}">🧭 Find them</button>`
    : ''
  const confirm = dmComeToMeArmed
    ? `<div class="note">Send this and share your <strong>exact spot</strong> with ${esc(nameFor(dmPeer))} alone, just this once? Nobody else in the circle sees it.</div>
       <div class="row" style="gap:10px">
         <button class="btn small primary" data-action="dm-come-to-me-confirm">Yes, come to me</button>
         <button class="btn small ghost" data-action="dm-come-to-me-cancel">Cancel</button>
       </div>`
    : ''
  return `<div class="compose-sheet" id="dm-sheet" role="dialog" aria-modal="true">
    <div class="compose-card dm-card">
      <div class="row" style="justify-content:space-between;align-items:flex-start">
        <strong>🔒 ${esc(nameFor(dmPeer))} · private</strong>
        <button class="bz-x" data-action="dm-close" aria-label="Close">✕</button>
      </div>
      <div class="chat-thread dm-thread" id="dm-thread">${thread}</div>
      <div class="chip-row chat-presets">${findBtn}${DM_QUICK_ACTIONS.map(chip).join('')}</div>
      ${confirm}
      <div class="note">Private: encrypted so only they can read it. It stays out of the circle signal log.</div>
    </div>
  </div>`
}
function mountDmSheet(): void {
  document.getElementById('dm-sheet')?.remove()
  if (!dmPeer) return
  const tmp = document.createElement('div')
  tmp.innerHTML = dmSheet()
  const el = tmp.firstElementChild as HTMLElement | null
  if (!el) return
  overlayLayer.appendChild(el)
  el.querySelectorAll('[data-action]').forEach((node) => {
    const action = node.getAttribute('data-action') as string
    node.addEventListener('click', () => handleAction(action, node as HTMLElement))
  })
  scrollChatToEnd()
}
/** Refresh ONLY the open thread's signals in place — no teardown, so the sheet
 *  never replays its entrance animation. Falls back to a full mount if the sheet
 *  isn't up yet (e.g. it was closed). */
function updateDmThread(): void {
  if (!dmPeer) return
  const threadEl = document.getElementById('dm-thread')
  if (!threadEl) { mountDmSheet(); return }
  const list = persisted.dms?.[dmPeer] ?? []
  threadEl.innerHTML = list.slice(-CHAT_SHOWN).map((m, i, arr) => chatBubble(m, arr[i - 1])).join('')
    || `<div class="note chat-empty">No private signals yet. Choose a fixed action below; only ${esc(nameFor(dmPeer))} can read it.</div>`
  scrollChatToEnd()
}
/** Send a fixed private action and refresh its log in place. */
function dmSendAction(action: DirectCoordinationAction): void {
  const pk = dmPeer
  if (!pk) return
  void sendDm(pk, action).then(() => { if (dmPeer === pk) updateDmThread() })
}

/** A private coordination action just arrived on my personal inbox. Surface it as
 *  the top banner (locked, "just you"), notify and buzz — but only from a member of
 *  a circle I'm actually in, so a stranger who scraped my npub can't spam or spoof a
 *  circle name at me. The wire carries only a fixed label (covey-kit's DM `text`);
 *  translate it back to a provider action and DROP anything that isn't one, so a
 *  free-text message from an old or modified client never renders. */
function onIncomingDm(dm: DirectMessage): void {
  const me = persisted.identity
  if (me && dm.from === me.pk) return // my own action echoed back — never notify myself
  const c = persisted.circles.find((x) => x.id === dm.circleId)
  if (!c || !(c.members ?? []).includes(dm.from)) return // not a fellow circle member — drop
  const action = coordinationActionFromLabel(dm.text)
  if (!isDirectCoordinationAction(action)) return // not a provider-defined private action — drop
  const label = coordinationLabel(action)
  const isNew = appendDm(dm.from, { from: dm.from, action, at: dm.at })
  // A relay replaying history (re-subscribe after a reconnect) repopulates the
  // thread silently — only a genuinely new, recent signal rings.
  if (!isNew || nowSec() - dm.at > MSG_FRESH_SEC) { refresh(); return }
  if (dmPeer === dm.from && !document.hidden) {
    // Their thread is open in front of me — refresh in place without flicker.
    markThreadRead(dmKeyOf(dm.from))
    updateDmThread()
    refresh()
    return
  }
  raiseBuzz({ from: dm.from, reason: label, mine: true, circle: c.name, private: true })
  // Private 1:1 → its own conversation notification, headed by the sender and
  // updated in place per person (Signal-style), distinct from a circle thread.
  notifyIfHidden(label, { kind: 'dm', title: nameFor(dm.from), group: `dm:${dm.from}`, sender: nameFor(dm.from) })
  try { navigator.vibrate?.([300, 120, 300]) } catch { /* no haptics */ }
  refresh()
}

/** A PM "Come to me" exact-location share just arrived on my personal inbox —
 *  gift-wrapped to me alone, so nobody else in the circle ever saw it. Lands in
 *  the same 1:1 thread as a DM (a special bubble with a "See on map" jump), same
 *  members-gate (drop a stranger's), same fresh-only ring as any other message. */
function onIncomingLocationShare(loc: PrivateLocationShare): void {
  const me = persisted.identity
  if (me && loc.from === me.pk) return
  const c = persisted.circles.find((x) => (x.members ?? []).includes(loc.from))
  if (!c) return // not a fellow circle member — drop (stranger spam / scraped npub)
  // Put it on the map. A private exact share is a location I now hold for them, so
  // render it as their pin — exactly as the circle-wide come-to-me answer does
  // (sendExactBeacon → saveBeacon). Without this the "See on map" jump lands on
  // empty terrain: the whole point of sharing an exact spot is that it's visible.
  // On-device only (the wrap was addressed to me alone); their own next ambient
  // beacon supersedes it by recency, so it can't outlive their real position.
  saveBeacon(c.id, { member: loc.from, geohash: loc.geohash, precision: loc.precision, timestamp: loc.at })
  const label = '📍 Shared their exact location'
  const isNew = appendDm(loc.from, { from: loc.from, action: 'shared_exact_location', at: loc.at, geohash: loc.geohash, precision: loc.precision })
  if (!isNew || nowSec() - loc.at > MSG_FRESH_SEC) { refresh(); return }
  if (dmPeer === loc.from && !document.hidden) {
    markThreadRead(dmKeyOf(loc.from))
    updateDmThread() // in place — no teardown, no flicker
    refresh()
    return
  }
  raiseBuzz({ from: loc.from, reason: label, mine: true, circle: c.name, private: true })
  notifyIfHidden(label, { kind: 'dm', title: nameFor(loc.from), group: `dm:${loc.from}`, sender: nameFor(loc.from) })
  try { navigator.vibrate?.([300, 120, 300]) } catch { /* no haptics */ }
  refresh()
}

// ── One-shot exact share to the WHOLE circle (remote find-my-phone answer) ───
// It deliberately discloses more than the slider allows, once. On the wire it
// is an ordinary beacon — indistinguishable from any other (FLOCK §6 invariant
// 1). A PM's "Come to me" is a DIFFERENT, private mechanism (doDmComeToMe,
// below) that shares to just one person via their personal inbox — this one
// broadcasts to the circle's shared inbox instead.
type ExactResult = 'sent' | 'withheld' | 'nofix' | 'error'
/** Send ONE exact-precision beacon (geohash-9), one-shot: cadence and the slider
 *  are untouched, so the ambient share carries on and its next beacon reverts
 *  this pin. Runs the disclosure decision with an explicit pickup trigger, so a
 *  private (no-report) place still caps or withholds the pin — an exact fix must
 *  never leak a refuge. Used by the remote find-my-phone answer. */
async function sendExactBeacon(c: store.Circle): Promise<ExactResult> {
  const id = persisted.identity
  if (!id) return 'error'
  // Freshest possible spot: a one-shot GPS fix on a short deadline, falling back
  // to the last watched fix — a coarse ambient share may run on low-power
  // location, and an exact ask is exactly when accuracy matters.
  const fresh = await svc.currentPosition({ enableHighAccuracy: true, maximumAge: 5000, timeoutMs: 2500 })
  if (fresh) fix = fresh
  const use = fresh ?? fix
  if (!use) return 'nofix'
  const plan = decideEmission({
    mode: 'nightout',
    position: { lat: use.lat, lon: use.lon },
    trigger: 'pickup',
    offGrid: false,
    noReportZones: persisted.noReportZones,
    accuracyMetres: use.accuracy,
  }, { coarse: sharePrecisionOf(c), full: COME_TO_ME_PRECISION })
  if (plan.action === 'withhold') return 'withheld'
  try {
    const geohash = encode(use.lat, use.lon, plan.precision)
    const template = await buildLocationSignal({ groupId: c.id, seedHex: c.seedHex, signalType: 'beacon', geohash, precision: plan.precision })
    await publishSignal(template, c)
    saveBeacon(c.id, { member: id.pk, geohash, precision: plan.precision, timestamp: nowSec() })
    return 'sent'
  } catch { return 'error' }
}

/** PM "Come to me": message just this one person AND share your exact spot
 *  with them ALONE — gift-wrapped to their personal inbox (buildPrivateLocationWrap),
 *  never the circle's shared inbox, so nobody else in the circle ever sees it.
 *  Still runs the full disclosure policy (a no-report place still caps or
 *  withholds it) — a private ask doesn't bypass that. */
async function doDmComeToMe(pk: string): Promise<void> {
  const signer = getSigner()
  const id = persisted.identity
  const c = activeCircle()
  if (!signer || !id || !pk || !c) return
  await sendDm(pk, 'come_to_me')
  const fresh = await svc.currentPosition({ enableHighAccuracy: true, maximumAge: 5000, timeoutMs: 2500 })
  if (fresh) fix = fresh
  const use = fresh ?? fix
  const done = (msg: string): void => { toast(msg); mountDmSheet() }
  if (!use) { done("Sent. Couldn't attach your spot."); return }
  const plan = decideEmission({
    mode: 'nightout',
    position: { lat: use.lat, lon: use.lon },
    trigger: 'pickup',
    offGrid: false,
    noReportZones: persisted.noReportZones,
    accuracyMetres: use.accuracy,
  }, { coarse: sharePrecisionOf(c), full: COME_TO_ME_PRECISION })
  if (plan.action === 'withhold') { done('Sent. Your spot stays private here.'); return }
  try {
    const geohash = encode(use.lat, use.lon, plan.precision)
    const wrap = await buildPrivateLocationWrap(signer, pk, { geohash, precision: plan.precision })
    await svc.publishSigned(activeRelays(), wrap as never)
    appendDm(pk, { from: id.pk, action: 'shared_exact_location', at: nowSec(), geohash, precision: plan.precision })
    done('Sent, your exact spot is on its way')
  } catch { done("Sent. Couldn't attach your spot.") }
}


function handleAction(action: string, node: HTMLElement): void {
  switch (action) {
    case 'tab': {
      const prev = tab
      tab = node.dataset.tab as typeof tab
      // Opening Chat is exactly when you're waiting on a reply — heal the pool if
      // it's gone stale (no-op on a live one, so no reconnect churn on every open).
      if (tab === 'chat' && prev !== 'chat') recoverIfStale()
      render()
      break
    }
    case 'switch-circle': if (chipHeldGuard) { chipHeldGuard = false; break } switchCircle(node.dataset.id as string); break
    case 'add-circle': adding = true; onboardStep = 'intro'; render(); break
    case 'go-invite': tab = 'circle'; showInvite = true; render(); break
    case 'toggle-invite': showInvite = !showInvite; spokenCode = null; render(); break
    case 'toggle-share': if (sharing) stopSharing(); else startSharing(); break
    case 'geo-retry': geoIssue = null; sharing = false; startSharing(); break
    case 'festival-start': startFestival(Number(node.dataset.hours ?? '3')); break
    case 'festival-stop': stopFestival(); break
    case 'msg-member': openDmThread(node.dataset.pk ?? ''); break
    case 'radar-member': openRadarFor(node.dataset.pk ?? ''); break
    case 'strip-member': {
      if (stripDragGuard) { stripDragGuard = false; break } // just finished a reorder drag — not a tap
      const pk = node.dataset.pk ?? ''
      if (pk === persisted.identity?.pk) { tab = 'circle'; render() } else focusOnMember(pk)
      break
    }
    case 'group-signal': {
      const signal = node.dataset.signal
      if (isGroupCoordinationAction(signal)) void sendGroupSignal(signal)
      break
    }
    case 'check-in': void doCheckIn(); break
    case 'open-pins': pinsOpen = true; mountPinsSheet(); break
    case 'pins-close': pinsOpen = false; mountPinsSheet(); break
    case 'pin-place-start': void enterPlacement(); break
    case 'pin-kind': { const k = node.dataset.kind; if (isPinKind(k)) setPlacingKind(k); break }
    case 'pin-cancel': exitPlacement(); break
    case 'pin-drop': void confirmPlacement(); break
    case 'pin-zoom-in': mapView?.zoomIn(); break
    case 'pin-zoom-out': mapView?.zoomOut(); break
    case 'pin-remove-editing': { // delete the pin being moved, straight from the map
      const ec = activeCircle()
      const targetId = editingPinId ?? removingPinId
      const ep = ec && targetId ? cstate(ec.id).pins.find((x) => x.id === targetId) : null
      if (ec && ep) { void removePin(ec.id, ep); toast(`Removed ${pinKindLabel(ep.kind)}`) }
      exitPlacement()
      break
    }
    case 'nav-pin': pinsOpen = false; mountPinsSheet(); navigateToPin(node.dataset.id ?? ''); break
    case 'remove-pin': {
      const rc = activeCircle()
      const rp = rc && cstate(rc.id).pins.find((x) => x.id === node.dataset.id)
      if (rc && rp) { void removePin(rc.id, rp); mountPinsSheet() } // the tombstone landed synchronously — repaint the list
      break
    }
    case 'open-dm': openDmThread(node.dataset.pk ?? ''); break
    case 'dm-close': closeDmThread(); break
    case 'battery-allow': batteryAsked = true; void import('../../native/stayReachable').then((m) => m.requestBatteryExemption()).catch(() => { /* older shell */ }); break
    case 'rollcall-share': void doRollCallShare(); break
    case 'rollcall-dismiss': locAsk = null; refresh(); break
    case 'toggle-settings': showSettings = !showSettings; render(); break
    case 'see-on-map': focusMemberPk = node.dataset.pk ?? null; tab = 'home'; render(); break
    case 'see-shared-location': {
      focusGeohash = node.dataset.geohash ?? null
      dmPeer = null
      document.getElementById('dm-sheet')?.remove()
      // Jump to the circle this person is in so their saved exact pin is on the
      // active map (switchCircle renders + goes Home; initMap then frames the
      // cell via focusGeohash). Same circle → just re-render Home.
      const pk = node.dataset.pk ?? ''
      const sc = persisted.circles.find((x) => (x.members ?? []).includes(pk))
      if (sc && sc.id !== persisted.activeCircleId) { switchCircle(sc.id); break }
      tab = 'home'
      render()
      break
    }
    case 'ask-lost': lostConfirmPk = node.dataset.pk ?? null; render(); break
    case 'cancel-lost': lostConfirmPk = null; render(); break
    case 'report-lost': void sendLostReport(node.dataset.pk ?? '', true); break
    case 'found-phone': void sendLostReport(node.dataset.pk ?? '', false); break
    case 'make-it-ring': void ringPhone(node.dataset.pk ?? ''); break
    case 'find-exact': void askFindPing(node.dataset.pk ?? ''); break
    case 'cancel-findping': cancelFindPing(); break
    case 'toggle-ping-consent': togglePingConsent(); break
    case 'dm-signal': {
      const signal = node.dataset.signal
      if (isDirectCoordinationAction(signal)) dmSendAction(signal)
      break
    }
    case 'dm-come-to-me': dmComeToMeArmed = !dmComeToMeArmed; mountDmSheet(); break
    case 'dm-come-to-me-cancel': dmComeToMeArmed = false; mountDmSheet(); break
    case 'dm-come-to-me-confirm': dmComeToMeArmed = false; void doDmComeToMe(dmPeer ?? ''); break
    case 'copy-invite': void copyInvite(); break
    case 'share-word-code': case 'new-word-code': void shareWordCode(); break
    case 'copy-word-code': void copyWordCode(); break
    case 'save-handle': saveHandle(); break
    case 'copy-npub': copyNpub(); break
    case 'scan-invite-key': openKeyScanner(); break
    case 'send-invite': void sendInvite(); break
    case 'reseed': void reseedCircle(); break
    case 'ask-remove': removeConfirmPk = node.dataset.pk ?? null; render(); break
    case 'cancel-remove': removeConfirmPk = null; render(); break
    case 'ack-new-members': patchActive({ unseenMembers: [] }); render(); break
    case 'dismiss-hint':
      persisted.hints = store.withHintDismissed(persisted.hints, node.dataset.hint ?? '')
      store.save(persisted); render(); break
    case 'toggle-hints': {
      const h = persisted.hints ?? { on: false, dismissed: [] }
      persisted.hints = { ...h, on: !h.on }
      store.save(persisted); render(); break
    }
    case 'toggle-advanced': showAdvanced = !showAdvanced; render(); break
    case 'toggle-stay-reachable': void toggleStayReachable(); break
    case 'open-dnd': openDnd(); break
    case 'toggle-ble': void toggleBle(); break
    case 'reset-hints':
      persisted.hints = { on: true, dismissed: [] }
      store.save(persisted); toast('Tips are back on'); render(); break
    case 'remove-member': removeConfirmPk = null; void reseedCircle(node.dataset.pk); break
    case 'dismiss-buzz': dismissBuzz(); break
    case 'toggle-member-actions': {
      const pk = node.dataset.pk ?? null
      expandedMemberPk = expandedMemberPk === pk ? null : pk
      render()
      break
    }
    case 'edit-petname': editingPetname = node.dataset.pk ?? null; render(); break
    case 'save-petname': savePetname(node.dataset.pk as string); break
    case 'cancel-petname': editingPetname = null; render(); break
    case 'toggle-profiles': toggleProfiles(); break
    case 'toggle-tor': void toggleTorRelay(); break
    case 'set-units': {
      const u = node.dataset.units === 'imperial' ? 'imperial' : 'metric'
      if (persisted.units !== u) { persisted.units = u; store.save(persisted) }
      render(); break
    }
    case 'save-relay': saveRelay(); break
    case 'leave': leave(); break
    case 'ask-disband': disbandConfirm = true; render(); break
    case 'cancel-disband': disbandConfirm = false; render(); break
    case 'disband': void disbandCircle(); break
    case 'menu-cancel': closeCircleMenu(); break
    case 'menu-leave': { const id = circleMenu ?? undefined; closeCircleMenu(); leave(id); break }
    case 'menu-close': { const id = circleMenu ?? undefined; closeCircleMenu(); void disbandCircle(id); break }
    case 'ask-reset': resetConfirm = true; render(); break
    case 'cancel-reset': resetConfirm = false; render(); break
    case 'reset-device': resetDevice(); break
    case 'backup-copy': void doBackup('copy'); break
    case 'backup-download': void doBackup('download'); break
    case 'decoy-enable': void enableDecoy(); break
    case 'decoy-hide': void hideNow(); break
    case 'decoy-off': delete persisted.decoy; store.save(persisted); toast('Hiding is off'); render(); break
    case 'lock-enable': void enableLock(); break
    case 'lock-off': void disableLock(); break
    case 'lock-reconfirm': void reconfirmLock(); break
    default: break
  }
}

// ── Actions ──────────────────────────────────────────────────────────────────
function doCreate(): void {
  const name = (document.getElementById('cname') as HTMLInputElement | null)?.value ?? ''
  persisted.identity ??= store.createIdentity()
  persisted.circleRootHex ??= store.newSeed()
  let expiresAt: number | undefined
  if (ttlMode === 'today') {
    expiresAt = nowSec() + todayWindowSec()
  } else if (ttlMode === 'custom') {
    const n = Number((document.getElementById('ttl-num') as HTMLInputElement | null)?.value) || 0
    const unit = (document.getElementById('ttl-unit') as HTMLSelectElement | null)?.value
    const sec = unit === 'hours' ? n * 3600 : n * 86_400
    expiresAt = sec > 0 ? nowSec() + sec : undefined
  }
  upsertCircle(store.createCircle(name, 'nightout', persisted.identity.pk, persisted.circleRootHex, expiresAt, { trackingDefault: onboardTracking, sharePrecision: onboardPrecision }), true)
  onboardStep = 'intro'
  adding = false
  ttlMode = 'ongoing'
  tab = 'circle' // land where inviting people is front-and-centre
  render()
}

/** Remote join: create an identity, show my npub, and wait for a gift-wrapped invite. */
function doJoinRemote(): void {
  persisted.identity ??= store.createIdentity()
  store.save(persisted)
  awaitSince = Date.now()
  onboardStep = 'await'
  render()
  // Re-render once the "still waiting" guidance becomes due — no dead-end spinner.
  window.setTimeout(() => { if (onboardStep === 'await') render() }, AWAIT_GUIDE_MS + 500)
}

function doJoin(): void {
  const code = (document.getElementById('jcode') as HTMLTextAreaElement | null)?.value ?? ''
  if (!code.trim()) { toast('Paste the invite code first — the one they shared or under their QR.'); return }
  try {
    const circle = store.decodeInvite(store.inviteCodeFrom(code))
    persisted.identity ??= store.createIdentity()
    if (persisted.circles.some((c) => c.id === circle.id)) { switchCircle(circle.id); adding = false; return }
    circle.members = [persisted.identity.pk]
    circle.joinedAt = nowSec() // the roster about to replay is not news — see JOIN_GRACE_SEC
    circle.pingConsent = false // remote exact location is opt-in
    applyJoinPosture(circle)
    upsertCircle(circle, true)
    onboardStep = 'intro'
    adding = false
    tab = 'home'
    render()
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Invalid invite code.')
  }
}

/** Generate a 6-word invite code and show the words to read aloud / send over
 *  Signal. For when a QR can't be scanned (e.g. an iPhone PWA opens the link
 *  in Safari).
 *
 *  Audit F4 hardening: the code itself never protects the real circle seed.
 *  It parks a fresh, one-time REFERENCE keypair on the private relays (low
 *  security — only the code's own entropy guards it); the real invite travels
 *  separately, gift-wrapped (NIP-59, full 256-bit ECDH) to that reference's
 *  pubkey via the same channel a QR/link invite already uses. Even a
 *  successful offline brute-force of the six words yields only a disposable
 *  handle, never the seed directly. */
async function shareWordCode(): Promise<void> {
  const c = activeCircle()
  const signer = getSigner()
  if (!c || !signer || spokenCodeBusy) return
  spokenCodeBusy = true; render()
  try {
    const words = newWordCode()
    const codeSeed = await deriveWordCodeSeed(words)
    const refSk = generateSecretKey()
    const refPk = getPublicKey(refSk)
    const parkSk = wordInviteParkKey(codeSeed) // deterministic — the joiner reconstructs it for delete-on-fetch
    const refSigned = finalizeEvent(await buildWordInviteRef(codeSeed, bytesToHex(refSk), nowSec()), parkSk)
    const payload = { t: 'invite' as const, id: c.id, s: c.seedHex, n: c.name, m: c.mode, ...(c.expiresAt ? { x: c.expiresAt } : {}) }
    const inviteWrap = await buildInviteWrap(signer, refPk, payload)
    await svc.publishSigned(activeRelays(), refSigned as never)
    await svc.publishSigned(activeRelays(), inviteWrap as never)
    spokenCode = words
  } catch {
    toast("Couldn't reach a relay to set up the code — check your connection and try again.")
  } finally {
    spokenCodeBusy = false; render()
  }
}

/** Join by typing a 6-word code: derive its seed, fetch the parked reference,
 *  then fetch + decrypt the real invite it points to — the same landing as a
 *  scanned link. Deletes the parked reference once the real invite is safely
 *  in hand (delete-on-fetch, audit F4) — best-effort, never blocks the join. */
async function joinWithWords(): Promise<void> {
  const raw = (document.getElementById('jwords') as HTMLInputElement | null)?.value ?? ''
  let words: string[]
  try { words = normaliseWordCode(raw) } catch (err) { toast(err instanceof Error ? err.message : 'Check the words.'); return }
  if (words.length !== WORD_INVITE.words) { toast(`Enter all ${WORD_INVITE.words} words, in order.`); return }
  spokenCodeBusy = true; render()
  // The busy render rebuilds the form, and only a FOCUSED input survives a
  // render — focus just moved to the button, so put the words back: on a
  // failure the user corrects them, never re-types six words into a field
  // that silently emptied itself.
  const jw = document.getElementById('jwords') as HTMLInputElement | null
  if (jw) jw.value = raw
  try {
    const codeSeed = await deriveWordCodeSeed(words)
    const refEvent = await svc.fetchWordInvite(activeRelays(), WORD_INVITE.kind, wordInviteTag(codeSeed))
    if (!refEvent) { toast('No invite found for those words. They expire after 15 minutes, so ask for a fresh code.'); return }
    const ref = await readWordInviteRef(codeSeed, refEvent)
    const refSk = store.fromHex(ref.ref)
    const refPk = getPublicKey(refSk)
    const inviteWrap = await svc.fetchGiftWrap(activeRelays(), personalInboxTag(refPk))
    if (!inviteWrap) { toast("The invite is still on its way. Wait a moment and try the same words again."); return }
    const p = await readInviteViaRef(refSk, inviteWrap)
    if (!p) throw new Error('invalid invite')
    const circle: store.Circle = { id: p.id, seedHex: p.s, name: p.n || 'Circle', mode: p.m === 'nightout' ? 'nightout' : 'family', ...(typeof p.x === 'number' ? { expiresAt: p.x } : {}) }
    persisted.identity ??= store.createIdentity()
    // Delete-on-fetch: remove the low-entropy-protected reference now it has
    // served its one purpose, closing the window an eventual brute-force of
    // the code could otherwise exploit. Best-effort — a relay that ignores
    // NIP-09 just leaves it to its own 15-minute expiry regardless.
    try {
      const parkSk = wordInviteParkKey(codeSeed)
      const del = finalizeEvent(buildWordInviteDeletion(refEvent.id, nowSec()), parkSk)
      await svc.publishSigned(activeRelays(), del as never)
    } catch { /* hygiene only — never blocks the join */ }
    if (persisted.circles.some((x) => x.id === circle.id)) { switchCircle(circle.id); adding = false; onboardStep = 'intro'; tab = 'home'; render(); return }
    if (!persisted.myHandle) { pendingJoin = circle; render(); return }
    completeJoin(circle)
  } catch {
    toast("Those words didn't unlock an invite — double-check them, or ask for a fresh code.")
  } finally {
    spokenCodeBusy = false
    // Re-enable the button IN PLACE. A failure used to leave "Finding invite…"
    // stuck disabled — every retry silently did nothing (the field report was
    // "the words never work"). Not a full re-render: only a FOCUSED input
    // survives one, and focus is on the button, so re-rendering would wipe the
    // six typed words. On success the screen has moved on and this is a no-op.
    const btn = document.querySelector('[data-action="join-words"]') as HTMLButtonElement | null
    if (btn) { btn.disabled = false; btn.textContent = 'Join with words' }
  }
}

// The location watch should run only when it can actually do something: we're
// sharing and the app is in the foreground. Anything else is GPS burned for
// nothing — a hidden PWA can't sample reliably regardless. (Minimal-footprint
// north star — Phase H.)
function shouldSample(): boolean {
  return sharing && !hidden
}

// Hardware cost tracks disclosure: a coarse share (city…neighbourhood) is ample
// on low-power network/cell location — and coarser hardware is a privacy win
// too. Street-level and finer needs GPS, or the "exact" pin would quietly be a
// network guess. (Minimal-footprint north star — Phase H.)
function desiredHighAccuracy(): boolean {
  return sharePrecisionOf(activeCircle()) >= 7
}
let watchHighAccuracy = true // accuracy tier the running watch was armed at

function resetSampleCadence(): void { lastSampleFix = null; stationaryStreak = 0 }

// ── Battery-aware conservation (Phase H) ─────────────────────────────────────
// A dying phone is itself a safety risk — flock draining the last of it is worse
// than slower sampling. When the battery is low AND discharging, the poll widens
// (cadence `conserve`). Where the Battery Status API doesn't exist (iOS/Firefox)
// we simply never conserve.
const CONSERVE_BELOW = 0.2
let batteryLow = false
let batteryCharging = true
function watchBattery(): void {
  type BatteryManager = { level: number; charging: boolean; addEventListener: (t: string, f: () => void) => void }
  const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManager> }
  nav.getBattery?.().then((b) => {
    const update = (): void => { batteryLow = b.level <= CONSERVE_BELOW; batteryCharging = b.charging }
    update()
    b.addEventListener('levelchange', update)
    b.addEventListener('chargingchange', update)
  }).catch(() => { /* no API → never conserve */ })
}

function conserveNow(): boolean {
  return batteryLow && !batteryCharging
}

/** Next night-out poll delay (ms): tight while moving, backing off when stationary. */
function sampleDelayMs(f: svc.Fix): number {
  const prev = lastSampleFix
  const moved = !prev || hasMoved(
    haversineMetres({ lat: prev.lat, lon: prev.lon }, { lat: f.lat, lon: f.lon }),
    prev.accuracy, f.accuracy, SAMPLE_MOVE_FLOOR,
  )
  stationaryStreak = moved ? 0 : stationaryStreak + 1
  lastSampleFix = f
  return nextPollDelaySeconds(stationaryStreak, SAMPLE_POLL_BOUNDS, { conserve: conserveNow() }) * 1000
}

/** Start or stop location sampling to match shouldSample(), re-arming if the
 *  accuracy tier changed (the slider crossing the street/neighbourhood line, or
 *  switching circles). Fine precisions run a continuous GPS watch; coarse ones
 *  run an adaptive low-power poll that eases off when stationary (battery). The
 *  single place sampling is turned on or off. */
function syncWatch(): void {
  const want = shouldSample()
  const hi = desiredHighAccuracy()
  if (want && (!stopWatch || hi !== watchHighAccuracy)) {
    stopWatch?.()
    watchHighAccuracy = hi
    resetSampleCadence()
    const onErr = (msg: string, kind: svc.GeoErrorKind): void => {
      if (kind === 'denied') {
        // In the native shell the WebView's navigator.geolocation reports
        // 'denied' the instant sharing arms — BEFORE the runtime-location dialog
        // (raised by the background watcher) has been answered. Treating that as
        // terminal is the permission race: a fresh sharing tap would immediately
        // self-revert and sit Private behind the "can't see your
        // location" card even once the user grants permission. The AUTHORITATIVE
        // denial in the shell is the background watcher's NOT_AUTHORIZED
        // (startBgWatch's onDenied), which reverts sharing only on a genuine
        // refusal. So here: tear the dead foreground watch down so a later
        // syncWatch (dialog dismissed → visibilitychange) re-arms it, but leave
        // `sharing` on and show no card.
        if (isNativeShell()) {
          stopWatch?.()
          stopWatch = null
          return
        }
        // PWA: geolocation permission is the only permission, so a denial is
        // authoritative — keep the toggle honest (sharing reverts) and explain
        // HOW on a persistent card, not a toast.
        geoIssue = 'denied'
        sharing = false
        syncWatch()
      } else if (kind === 'unsupported') {
        toast(msg)
        sharing = false
        syncWatch()
      } else {
        geoIssue = 'nofix' // transient — the watch keeps trying; clears on the next fix
      }
      render()
    }
    stopWatch = hi
      ? svc.watchLocation(onFix, onErr, { highAccuracy: true })
      : svc.pollLocation(onFix, onErr, { highAccuracy: false, nextDelayMs: sampleDelayMs })
  } else if (!want && stopWatch) {
    stopWatch()
    stopWatch = null
  }
}

function startSharing(): void {
  if (sharing) return
  sharing = true
  render() // reflect "Locating…" straight away; arming continues async below
  void armSharing()
}

/** Arm the location sources behind `sharing`. In the native shell this first
 *  settles location permission ONCE and awaits it, so the foreground watch and
 *  the background watcher never race a runtime permission request — the collision
 *  that made a fresh sharing tap immediately self-revert to Private
 *  behind the "can't see your location" card (both requesters fired at once, the
 *  loser got an instant NOT_AUTHORIZED). With permission settled first, both fix
 *  sources start cleanly; a genuine refusal reverts sharing and shows the card. */
async function armSharing(): Promise<void> {
  if (isNativeShell()) {
    const granted = await (await import('../../native/background')).ensureLocationPermission().catch(() => true)
    if (!sharing) return // user hit "Go private" while the permission dialog was up
    if (!granted) {
      geoIssue = 'denied'
      sharing = false
      render()
      return
    }
  }
  syncWatch()
  void startBgWatch()
  // Locked-screen sharing needs the Doze exemption — ask now (once), and keep
  // the batteryCard honest either way. See refreshBatteryExempt for why.
  void ensureBatteryExemptForSharing()
  render()
}

function stopSharing(): void {
  sharing = false
  geoIssue = null
  dropMyPresence() // my pin must not keep claiming "sharing" after the toggle is off
  syncWatch()
  void stopBgWatch()
  render()
}

// ── Native shell: background watch (native/background.ts) ───────────────────
// The PWA can only sample in the foreground; inside the Capacitor shell the
// sharing toggle extends to a background watcher (foreground service — the OS
// shows a persistent notification while it runs). Fixes enter through the SAME
// onFix pipeline as foreground fixes, so the precision slider, no-report zones
// and cadence gating apply identically (FLOCK.md §6). Tied strictly to
// `sharing`: stop-sharing, reset and hide tear it down — nothing may run (or
// show a notification) on a fresh, reset or decoy install.
let bgWatchId: string | null = null
let bgWatchStarting = false

async function startBgWatch(): Promise<void> {
  if (!isNativeShell() || bgWatchId || bgWatchStarting) return
  if (!persisted.identity || !persisted.circles.length) return
  bgWatchStarting = true
  try {
    const bg = await import('../../native/background')
    bgWatchId = await bg.startBackgroundWatch(
      (f) => onFix(f),
      () => {
        // Background permission revoked — keep the toggle honest, same as a
        // foreground 'denied': revert sharing and show the actionable card.
        geoIssue = 'denied'
        sharing = false
        void stopBgWatch()
        syncWatch()
        render()
      },
    )
  } catch { /* plugin unavailable — foreground-only sharing still works */ }
  finally { bgWatchStarting = false }
}

async function stopBgWatch(): Promise<void> {
  const id = bgWatchId
  bgWatchId = null
  if (!id) return
  try {
    const bg = await import('../../native/background')
    await bg.stopBackgroundWatch(id)
  } catch { /* watcher already gone */ }
}

// ── Native shell: "stay reachable" (native/stayReachable.ts) ────────────────
// A location-free foreground service that keeps flock's process — and thus its
// already-always-on relay subscription — alive while the app is closed, so an
// incoming DM/buzz/alert lands as a notification on a locked screen (Signal
// parity). ON BY DEFAULT once a real identity exists — locked-screen messages
// are the whole point of a safety app, and without the service Android pauses
// the connection when the phone locks (missed signals; sends fail until a
// reload). A user can still turn it off. NEVER runs without a real identity (a
// decoy/hidden or reset install has none), so its ongoing notification can't
// become a "fresh install" tell.
/** Whether the stay-reachable service should run: on by default once there's a
 *  real identity, unless the user has explicitly turned it off. Unset (a new
 *  install) counts as on; a decoy / no-identity install is always off. */
function stayReachableOn(): boolean {
  return (persisted.stayReachable ?? true) && !!persisted.identity
}
async function syncStayReachable(): Promise<void> {
  if (!isNativeShell()) return
  const want = stayReachableOn()
  try {
    const m = await import('../../native/stayReachable')
    if (want) await m.startStayReachable()
    else await m.stopStayReachable()
  } catch { /* plugin unavailable — foreground-only receipt still works */ }
}

async function stopStayReachable(): Promise<void> {
  if (!isNativeShell()) return
  try { await (await import('../../native/stayReachable')).stopStayReachable() }
  catch { /* already gone */ }
}

// ── Native shell: Doze battery exemption (the locked-screen fix) ─────────────
// Sharing from a pocket only works if Android doesn't suspend the WebView's
// relay connection when the screen locks. The foreground service keeps FIXES
// flowing, but without the battery exemption Doze cuts the NETWORK minutes
// after lock — beacons build and fail, and the circle silently stops seeing
// you. So the exemption is requested when sharing starts, and its absence is
// surfaced as an actionable card (batteryCard) rather than a silent gap.
async function refreshBatteryExempt(): Promise<void> {
  if (!isNativeShell()) return
  try {
    const m = await import('../../native/stayReachable')
    const v = await m.isBatteryExempt()
    if (v !== batteryExempt) { batteryExempt = v; refresh() }
  } catch { /* older shell — leave null, no card */ }
}

/** On starting to share (native): ask for the exemption once per session if it's
 *  missing. The card remains as the persistent, non-nagging path afterwards. */
async function ensureBatteryExemptForSharing(): Promise<void> {
  if (!isNativeShell()) return
  try {
    const m = await import('../../native/stayReachable')
    batteryExempt = await m.isBatteryExempt()
    if (!batteryExempt && !batteryAsked) {
      batteryAsked = true
      await m.requestBatteryExemption()
    }
  } catch { /* older shell */ }
  refresh()
}

/** Everything that should happen the moment flock comes to the foreground. */
function onForeground(): void {
  void drainNativeJournal() // adopt any beacons the native watcher sent while backgrounded
  void checkForUpdate()
  void refreshBatteryExempt()
  void refreshDndAccess()
  // Orbot may have been started/stopped while flock was backgrounded.
  void syncTor().then(() => render())
  // A long background spell can leave a relay subscription quietly dead — the
  // socket-level reconnect (SimplePool's enableReconnect/enablePing) doesn't
  // always mean the REQ itself survived a background WebView's suspended
  // timers. ensureSubscriptions() is normally idempotent (skips a circle it
  // already believes it's subscribed to), so it can't tell "stale" from
  // "healthy" — force a full teardown + rebuild the moment the user actually
  // looks at the app again, when staleness would otherwise show up as
  // "messages just don't arrive" until the next full app restart.
  resubscribe()
  // A WebGL context is a prime target for the OS to reclaim GPU memory from a
  // backgrounded WebView — reported live as "the map is black" after locking
  // the phone for a few minutes then waking it, fixed only by switching tabs
  // away from Home and back (which tears the map down and remounts it fresh).
  // Do that automatically on resume instead of leaving it on the user to
  // rediscover — same destroy+reinit, camera preserved.
  if (tab === 'home' && mapView) {
    const c = mapView.map.getCenter()
    const camera = { lng: c.lng, lat: c.lat, zoom: mapView.map.getZoom() }
    void initMap(camera)
  }
  // The app being open IS the read — clear delivered message notifications,
  // exactly as Signal does. Foreground-service notifications are immune.
  void import('../../native/notify').then((n) => n.clearDelivered()).catch(() => { /* shell only */ })
}

/** Flip the "stay reachable when closed" toggle: persist, start/stop the
 *  service, and — on enable — ask for the Doze battery exemption without which
 *  an aggressive OEM freezes the service overnight (parity would silently lapse). */
async function toggleStayReachable(): Promise<void> {
  persisted.stayReachable = !stayReachableOn()
  store.save(persisted)
  render()
  await syncStayReachable()
  if (persisted.stayReachable) {
    try {
      const m = await import('../../native/stayReachable')
      if (!(await m.isBatteryExempt())) await m.requestBatteryExemption()
    } catch { /* plugin unavailable */ }
    toast('Staying reachable — messages arrive even when flock is closed')
  } else {
    toast('Stay-reachable off — messages arrive when flock is open')
  }
}

/** Flip BLE-nearby: persist, then bring the transport up/down. Starting it prompts
 *  for Bluetooth permission (the plugin asks). Off-relay + additive — the relay
 *  path is unaffected either way. */
async function toggleBle(): Promise<void> {
  persisted.bleNearby = !persisted.bleNearby
  store.save(persisted)
  render()
  await syncBle()
  toast(persisted.bleNearby
    ? 'Bluetooth nearby on — finding co-located circle members off-relay'
    : 'Bluetooth nearby off')
}

// onResume and visibilitychange can both fire onForeground for one real resume
// (the documented double-fire near checkForUpdate) — guard against two
// overlapping drains positionally ack'ing entries appended between them,
// which would silently drop a journal entry.
let drainingJournal = false

/** Drain the native publish journal: adopt background beacons into my own pin
 *  history and cadence so reopening the app never double-sends or lies about
 *  "last shared". The fix-log entries are the split measurement (design doc
 *  verification §3) — surfaced via console for field debugging. */
async function drainNativeJournal(): Promise<void> {
  if (drainingJournal) return
  drainingJournal = true
  try {
    if (!isNativeShell()) return
    const m = await import('../../native/publishMirror')
    const entries = await m.readNativeJournal()
    if (!entries.length) return
    const id = persisted.identity
    for (const e of entries) {
      if (e.t !== 'pub' || !id || !e.c || !e.g || e.p === undefined) continue
      const cached = cstate(e.c).beacons.get(id.pk)
      if (!cached || e.at > cached.timestamp) saveBeacon(e.c, { member: id.pk, geohash: e.g, precision: e.p, timestamp: e.at })
      const prev = beaconCadence.get(e.c)
      if (!prev || e.at > prev.lastSentAt) beaconCadence.set(e.c, { lastGeohash: e.g, lastSentAt: e.at })
    }
    await m.ackNativeJournal(entries.length)
    refresh()
  } catch { /* plugin unavailable */ } finally { drainingJournal = false }
}

function onFix(f: svc.Fix): void {
  fix = f
  geoIssue = null // any successful fix clears the location-trouble card
  // Foreground-only publishing. While the app is hidden the native background
  // pipeline (FlockLocationService → FlockPublisher, itself guarded on
  // !isAppForegrounded) is the SOLE publisher; if JS also emitted here — from a
  // still-alive WebView fed by the background-geolocation watcher — the relay
  // would carry ~2× the beacons for one walk (measured on stock Android, whose
  // WebView isn't suspended as promptly as GrapheneOS's). JS owns the
  // foreground, native owns the background; the resume-time journal drain
  // adopts whatever native published while we were away.
  if (hidden) return
  if (sharing) void autoEmit()
  else refresh()
}

// Automatic, movement-driven emission for the active circle — a beacon at the
// slider's precision. It is both rate-limited AND movement-gated (see cadence.ts)
// — an identical geohash cell is never re-sent, so standing still doesn't spam
// relays; only a slow heartbeat keeps a stationary member reading as "active".
async function autoEmit(): Promise<void> {
  const c = activeCircle()
  const id = persisted.identity
  if (!c || !id || !fix) { refresh(); return }
  // Private posture (chosen at create/join): never a continuous beacon. Location
  // still goes out on an explicit event — a check-in answer, a "come to me", a
  // breach — through their own paths; the ambient share is simply off here.
  if ((c.trackingDefault ?? 'always') === 'private') { refresh(); return }
  const f = fix
  // Mode is pinned to the share-live path regardless of the circle's stored mode
  // (legacy 'family' circles behave the same) — the slider drives the precision,
  // and no-report zones still cap or withhold inside a private place.
  const plan = decideEmission({
    mode: 'nightout',
    position: { lat: f.lat, lon: f.lon },
    trigger: 'none',
    offGrid: false,
    noReportZones: persisted.noReportZones,
    accuracyMetres: f.accuracy,
  }, { coarse: sharePrecisionOf(c) })
  const type = signalTypeForReason(plan.reason)
  // The guard narrows `type` to a LocationSignalType for buildLocationSignal.
  if (!type || type === 'help' || plan.action === 'withhold') { refresh(); return }
  const geohash = encode(f.lat, f.lon, plan.precision)
  const prev = beaconCadence.get(c.id) ?? { lastGeohash: null, lastSentAt: 0 }
  const now = nowSec()
  // Timing hygiene (audit F1): re-roll the cadence each tick so the interval
  // itself isn't perfectly periodic on the wire.
  if (!shouldEmitBeacon(geohash, prev, now, {
    minIntervalSeconds: jitteredSeconds(COARSE_MIN_INTERVAL, CADENCE_JITTER_FRACTION, Math.random()),
    heartbeatSeconds: jitteredSeconds(COARSE_HEARTBEAT, CADENCE_JITTER_FRACTION, Math.random()),
  })) {
    // The real gate just said no (standing still, inside the heartbeat window) —
    // consider a low-rate decoy instead, narrowing the moving-vs-still cadence
    // gap without disclosing anything (best-effort; never blocks the UI).
    if (shouldEmitCover(coverCadence.get(c.id) ?? 0, now, { intervalSeconds: COVER_INTERVAL_SECONDS, jitterFraction: CADENCE_JITTER_FRACTION }, Math.random())) {
      coverCadence.set(c.id, now)
      const filler = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('')
      try {
        const cover = await buildLocationSignal({ groupId: c.id, seedHex: c.seedHex, signalType: 'cover', geohash: filler, precision: plan.precision })
        await publishSignal(cover, c)
      } catch { /* best-effort — a missed decoy is not a missed alert */ }
    }
    refresh()
    return
  }
  try {
    const template = await buildLocationSignal({ groupId: c.id, seedHex: c.seedHex, signalType: type, geohash, precision: plan.precision })
    await publishSignal(template, c)
    // Only record the send (local pin + cadence) once a relay has accepted it, so a
    // transient failure is retried on the next fix rather than silently swallowed.
    saveBeacon(c.id, { member: id.pk, geohash, precision: plan.precision, timestamp: now })
    beaconCadence.set(c.id, { lastGeohash: geohash, lastSentAt: now })
    coverCadence.set(c.id, now) // a real send counts as this cycle's cover too — no doubling up
  } catch { /* no relay accepted — leave cadence untouched so the next fix retries */ }
  refresh()
}

async function copyInvite(): Promise<void> {
  const c = activeCircle()
  if (!c) return
  const link = store.inviteLink(c, shareOrigin())
  // The OS share sheet keeps the secret off the clipboard entirely (clipboards
  // cloud-sync and every app can read them). Clipboard is the desktop fallback;
  // selectable text is the last resort.
  if (navigator.share) {
    try { await navigator.share({ title: `Join ${c.name} on flock`, url: link }); return }
    catch (e) {
      if ((e as Error).name === 'AbortError') return // user closed the sheet — not an error
    }
  }
  navigator.clipboard?.writeText(link).then(
    () => toast('Invite link copied — send it only through a chat you trust'),
    () => { showInviteLinkText = true; render(); toast("Couldn't copy — here's the link to select") },
  )
}

/** Copy the four spoken words (space-separated) so they can be pasted into Signal. */
function copyWordCode(): void {
  if (!spokenCode) return
  const text = spokenCode.join(' ')
  navigator.clipboard?.writeText(text).then(
    () => toast('Words copied — send them only through a chat you trust'),
    () => toast(`Couldn't copy — the words are: ${text}`),
  )
}

function copyNpub(): void {
  const id = persisted.identity
  if (!id) return
  let npub = id.pk
  try { npub = npubEncode(id.pk) } catch { /* keep hex */ }
  navigator.clipboard?.writeText(npub).then(() => toast('Invite key copied'), () => toast('Copy failed'))
}

// ── Profiles & petnames ───────────────────────────────────────────────────────
function savePetname(pk: string): void {
  const v = (document.getElementById(`pet-${pk}`) as HTMLInputElement | null)?.value?.trim() ?? ''
  if (v) persisted.petnames = { ...persisted.petnames, [pk]: v }
  else { const next = { ...persisted.petnames }; delete next[pk]; persisted.petnames = next }
  store.save(persisted)
  editingPetname = null
  toast(v ? 'Nickname saved' : 'Nickname cleared')
  render()
}

function toggleProfiles(): void {
  persisted.showProfiles = !persisted.showProfiles
  store.save(persisted)
  if (persisted.showProfiles) ensureProfiles()
  toast(persisted.showProfiles ? 'Showing public names & photos' : 'Public profiles off')
  render()
}

/** When opted-in, fetch public kind:0 profiles for everyone across our circles. */
function ensureProfiles(): void {
  if (!persisted.showProfiles) return
  const pks = new Set<string>()
  for (const c of persisted.circles) for (const pk of c.members ?? []) pks.add(pk)
  fetchProfiles([...pks], () => { if (!isEditing()) refresh() })
}

function saveRelay(): void {
  const el = document.getElementById('relay') as HTMLTextAreaElement | HTMLInputElement | null
  const relays = parseRelayList(el?.value ?? '')
  if (!relays.length) { toast('Enter at least one ws:// or wss:// relay'); return }
  persisted.relayUrls = relays
  store.save(persisted)
  ensureInviteSub()
  ensureSubscriptions()
  // F5: a relay outside our vetted no-log set used to save silently — an
  // unvetted server still sees opaque wraps' timing + your IP, so say so.
  const unknown = unknownRelays(relays)
  toast(unknown.length
    ? `Saved. ${unknown.length} of ${relays.length} ${unknown.length === 1 ? "isn't" : "aren't"} on our vetted no-log list. Only add a server you trust not to log.`
    : (relays.length > 1 ? `Saved ${relays.length} relays` : 'Relay saved'))
}

/** Leave a circle (local removal). Defaults to the active one; the chip menu
 *  passes an id so you can leave a circle that isn't in focus. Identity and
 *  other circles stay. */
function leave(id?: string): void {
  const c = id ? persisted.circles.find((x) => x.id === id) : activeCircle()
  if (!c) return
  const wasActive = c.id === persisted.activeCircleId
  if (wasActive) closeRadar() // its target left with the circle
  removeCircle(c.id)
  disbandConfirm = false
  resetConfirm = false
  removeConfirmPk = null
  if (wasActive) tab = 'home'
  toast(`Left ${c.name}`)
  render()
}

/** Disband a circle for *everyone* — broadcast a tombstone, then wipe locally.
 *  Defaults to the active circle; the chip menu passes an id for a background one. */
async function disbandCircle(id?: string): Promise<void> {
  const c = id ? persisted.circles.find((x) => x.id === id) : activeCircle()
  const me = persisted.identity
  if (!c || !me) return
  const wasActive = c.id === persisted.activeCircleId
  try {
    await publishSignal(await buildDisbandSignal({ groupId: c.id, seedHex: c.seedHex, by: me.pk }), c)
  } catch { /* still drop locally even if the broadcast fails */ }
  const name = c.name
  if (wasActive) closeRadar()
  removeCircle(c.id)
  disbandConfirm = false
  resetConfirm = false
  removeConfirmPk = null
  if (wasActive) tab = 'home'
  toast(`Disbanded ${name}`)
  render()
}

// ── Backup & restore ─────────────────────────────────────────────────────────
const MIN_BACKUP_PASS = 8

/** Export this device's state as a passphrase-encrypted code (copy or file). */
async function doBackup(how: 'copy' | 'download'): Promise<void> {
  const input = document.getElementById('backup-pass') as HTMLInputElement | null
  const pass = input?.value ?? ''
  if (pass.length < MIN_BACKUP_PASS) { toast(`Pick a passphrase of at least ${MIN_BACKUP_PASS} characters`); return }
  try {
    const blob = await exportBackup(persisted, pass)
    if (how === 'copy') {
      await navigator.clipboard.writeText(blob)
      toast('Backup code copied — store it somewhere safe')
    } else {
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([blob], { type: 'text/plain' }))
      a.download = `flock-backup-${new Date().toISOString().slice(0, 10)}.txt`
      a.click()
      URL.revokeObjectURL(a.href)
      toast('Backup file saved — store it somewhere safe')
    }
    if (input) input.value = ''
  } catch { toast("Couldn't create the backup") }
}

/** Restore a backup from the welcome screen, then boot cleanly from the new state. */
async function doRestore(): Promise<void> {
  const code = (document.getElementById('restore-code') as HTMLTextAreaElement | null)?.value ?? ''
  const pass = (document.getElementById('restore-pass') as HTMLInputElement | null)?.value ?? ''
  if (!code.trim() || !pass) { toast('Paste the backup code and its passphrase'); return }
  try {
    const data = await importBackup(code, pass)
    persisted = applyBackup(persisted, data)
    store.save(persisted)
    location.reload() // boot from the restored state — subs, monitor and map come up as normal
  } catch (err) {
    // A hidden state exits HERE — the phrase alone unlocks it (reloads on
    // success). Constant work either way: a fresh install and a decoy must
    // fail identically, in behaviour and in timing (see decoy.ts).
    if (await tryUnhide(pass)) return
    toast(err instanceof Error ? err.message : 'Restore failed')
  }
}

// ── The decoy view — "hide flock" (docs/plans/2026-07-02-decoy-view.md) ─────
/** The sealed real state while hidden. Deliberately unremarkable name; the
 *  blob inside carries no magic string either. */
const DECOY_CACHE_KEY = 'flock:cache'

/** Arm hiding: derive the sealing key from the phrase once, up front — the
 *  moment a coercer approaches is not the moment to spend a second on a KDF. */
async function enableDecoy(): Promise<void> {
  const p1 = (document.getElementById('decoy-pass') as HTMLInputElement | null)?.value ?? ''
  const p2 = (document.getElementById('decoy-pass2') as HTMLInputElement | null)?.value ?? ''
  if (p1.length < MIN_BACKUP_PASS) { toast(`Pick a phrase of at least ${MIN_BACKUP_PASS} characters`); return }
  if (p1 !== p2) { toast("Those phrases don't match"); return }
  const salt = newSalt()
  persisted.decoy = { salt, key: await deriveDecoyKey(p1, salt) }
  store.save(persisted)
  toast('Hiding is on')
  render()
}

/** Seal everything and reboot as a fresh install. Saves are locked before the
 *  wipe so a queued signal handler can't write the real state back in the gap
 *  before the reload lands. Never overwrites an existing sealed state. */
async function hideNow(): Promise<void> {
  const cfg = persisted.decoy
  if (!cfg) return
  if (localStorage.getItem(DECOY_CACHE_KEY)) { toast("Couldn't hide — free up some storage and try again"); return }
  closeRadar() // a hidden app must fall silent — no beeps, haptics or GPS may outlive the hide
  // Nothing may re-arm the native mirror once hiding starts (mirrors lockSaves) —
  // an incoming signal can still render() until the reload lands.
  try { (await import('../../native/publishMirror')).lockNativePublish() } catch { /* plugin-less shell */ }
  // Native shell: any persistent foreground-service notification (the location
  // watcher, the stay-reachable service) would be a tell on a "fresh install" —
  // await their teardown BEFORE sealing and reloading.
  await stopBgWatch()
  await stopStayReachable()
  // Decoy hide must leave nothing behind, including the journal — a fresh
  // install has none, so the mirror must be fully wiped, not just config-cleared.
  try { await (await import('../../native/publishMirror')).wipeNativePublish() } catch { /* not running */ }
  try { await (await import('../../native/ble')).stopBle() } catch { /* not running */ }
  bleActive = false // a decoy must be radio-inert — no BLE advertising/scanning
  const sealed = await sealState(JSON.stringify(persisted), cfg.salt, cfg.key)
  store.lockSaves()
  localStorage.setItem(DECOY_CACHE_KEY, sealed)
  store.reset()
  location.reload()
}

/** Attempt the phrase against the sealed state; reloads into the real app on
 *  success. When nothing is hidden, burns the identical KDF cost and fails —
 *  so probing the restore screen can't tell a decoy from a fresh install. */
async function tryUnhide(pass: string): Promise<boolean> {
  const blob = localStorage.getItem(DECOY_CACHE_KEY)
  if (!blob) { await dummyWork(pass); return false }
  try {
    const json = await openState(blob, pass)
    store.restoreRaw(json)
    localStorage.removeItem(DECOY_CACHE_KEY)
    location.reload()
    return true
  } catch { return false }
}

// ── The app lock — key-at-rest (docs/plans/2026-07-02-app-lock.md) ──────────
const MIN_LOCK_PIN = 6
let lockForgotConfirm = false

/** The gate a locked device boots into. Deliberately its own render path —
 *  none of the normal machinery (subs, watch, invite sub) may start before
 *  the state exists. */
function renderLockScreen(err?: string): void {
  root.innerHTML = `
  <main class="screen onboard fade-in">
    <img class="hero-logo" src="./icon.svg" alt="" />
    <h1>Locked</h1>
    <p class="tagline">Enter your PIN to open flock.</p>
    <div class="field" style="text-align:left;margin-bottom:16px"><label for="lock-pin-entry">PIN</label><input class="input" id="lock-pin-entry" type="password" autocomplete="current-password" /></div>
    ${err ? `<div class="note" style="color:var(--alert);margin-bottom:12px">${esc(err)}</div>` : ''}
    <div class="actions">
      <button class="btn primary" data-action="lock-unlock">Unlock</button>
    </div>
    ${lockForgotConfirm
      ? `<div class="note" style="color:var(--alert);margin-top:16px">This wipes flock from this device — PIN, key and circles. A backup (or a fresh invite from your circle) is the way back in.</div>
         <div class="row" style="gap:10px;justify-content:center;margin-top:8px">
           <button class="btn small ghost" style="color:var(--alert);border-color:var(--alert-dim)" data-action="lock-wipe">Wipe this device</button>
           <button class="btn small ghost" data-action="lock-forgot-cancel">Cancel</button>
         </div>`
      : '<button class="btn ghost" data-action="lock-forgot" style="margin-top:16px">I&#39;ve forgotten my PIN</button>'}
  </main><div class="toast" id="toast"></div>`
  root.querySelectorAll('[data-action]').forEach((node) => {
    node.addEventListener('click', () => { void handleLockAction(node.getAttribute('data-action') as string) })
  })
  const input = document.getElementById('lock-pin-entry') as HTMLInputElement | null
  input?.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') void handleLockAction('lock-unlock') })
  input?.focus()
}

async function handleLockAction(action: string): Promise<void> {
  if (action === 'lock-unlock') {
    const pin = (document.getElementById('lock-pin-entry') as HTMLInputElement | null)?.value ?? ''
    if (!pin) return
    const secret = await unlockWithPin(pin)
    if (!secret) { renderLockScreen("That's not it — try again"); return }
    try {
      persisted = await store.openRest(secret)
    } catch { renderLockScreen("That's not it — try again"); return }
    store.armRest(secret)
    bootUnlocked()
  } else if (action === 'lock-forgot') { lockForgotConfirm = true; renderLockScreen() }
  else if (action === 'lock-forgot-cancel') { lockForgotConfirm = false; renderLockScreen() }
  else if (action === 'lock-wipe') {
    store.reset()
    await burnLock()
    location.reload()
  }
}

/** Arm the lock: a random storage secret, PIN-wrapped; state encrypts from now on. */
async function enableLock(): Promise<void> {
  const p1 = (document.getElementById('lock-pin') as HTMLInputElement | null)?.value ?? ''
  const p2 = (document.getElementById('lock-pin2') as HTMLInputElement | null)?.value ?? ''
  if (p1.length < MIN_LOCK_PIN) { toast(`Pick a PIN of at least ${MIN_LOCK_PIN} characters`); return }
  if (p1 !== p2) { toast("Those PINs don't match"); return }
  const secret = generateStorageSecret()
  await setupPin(p1, secret)
  persisted.lock = { secret }
  store.armRest(secret)
  store.save(persisted)
  toast('Lock is on')
  render()
}

/** Turn the lock off: plaintext at rest again, keystore burned. */
async function disableLock(): Promise<void> {
  delete persisted.lock
  store.sealOff(persisted)
  await burnLock()
  toast('Lock is off')
  render()
}

/** After a decoy unhide the state boots plaintext with the lock config intact —
 *  one PIN entry re-wraps OUR secret (healing even a keystore blob someone
 *  overwrote inside the decoy) and re-encrypts the state. */
async function reconfirmLock(): Promise<void> {
  const cfg = persisted.lock
  if (!cfg) return
  const pin = (document.getElementById('lock-repin') as HTMLInputElement | null)?.value ?? ''
  if (pin.length < MIN_LOCK_PIN) { toast(`Pick a PIN of at least ${MIN_LOCK_PIN} characters`); return }
  await setupPin(pin, cfg.secret)
  store.armRest(cfg.secret)
  store.save(persisted)
  toast('Locked again')
  render()
}

/** The covert hide gesture — hold the topbar wordmark. Fires mid-hold; no
 *  visible affordance (an animation would be a tell). */
const HIDE_HOLD_MS = 1200
function wireHideHold(node: HTMLElement): void {
  let timer = 0
  const begin = (e: Event): void => {
    if (!persisted.decoy) return
    e.preventDefault()
    timer = window.setTimeout(() => { void hideNow() }, HIDE_HOLD_MS)
  }
  const cancel = (): void => { if (timer) { clearTimeout(timer); timer = 0 } }
  node.addEventListener('pointerdown', begin)
  node.addEventListener('pointerup', cancel)
  node.addEventListener('pointerleave', cancel)
  node.addEventListener('pointercancel', cancel)
}

/** Press-and-hold a circle chip (or right-click on desktop) to open its action
 *  sheet. No preventDefault on pointerdown — the chip row scrolls horizontally,
 *  so we cancel on movement instead, and let native scroll through. */
const CHIP_HOLD_MS = 500
function wireChipHold(node: HTMLElement, id: string): void {
  let timer = 0
  let sx = 0
  let sy = 0
  const begin = (e: PointerEvent): void => {
    sx = e.clientX; sy = e.clientY
    timer = window.setTimeout(() => { openCircleMenu(id) }, CHIP_HOLD_MS)
  }
  const move = (e: PointerEvent): void => {
    if (timer && (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8)) cancel()
  }
  const cancel = (): void => { if (timer) { clearTimeout(timer); timer = 0 } }
  node.addEventListener('pointerdown', begin)
  node.addEventListener('pointermove', move)
  node.addEventListener('pointerup', cancel)
  node.addEventListener('pointerleave', cancel)
  node.addEventListener('pointercancel', cancel)
  node.addEventListener('contextmenu', (e) => { e.preventDefault(); openCircleMenu(id) })
}

// Set the instant a reorder drag ends, so the click that trails the release
// doesn't ALSO fire the tap-to-zoom action. Mirrors chipHeldGuard.
let stripDragGuard = false
const STRIP_HOLD_MS = 450

/** Press-and-hold a member avatar to reorder the strip (a plain tap zooms to
 *  them instead — see the 'strip-member' action). Same disambiguation as
 *  wireChipHold: cancel on early movement so a normal swipe-to-scroll still
 *  works, and only a deliberate hold arms the drag. Once armed, dragging
 *  swaps the held avatar past whichever neighbour it's crossed; releasing
 *  persists the new order as this device's own display preference — it never
 *  touches the wire. */
function wireMemberStrip(wrap: HTMLElement): void {
  const strip = wrap.querySelector<HTMLElement>('#member-strip') ?? wrap.querySelector<HTMLElement>('.member-strip')
  if (!strip) return
  let timer = 0
  let sx = 0
  let sy = 0
  let dragEl: HTMLElement | null = null
  const cancelTimer = (): void => { if (timer) { clearTimeout(timer); timer = 0 } }
  const end = (): void => {
    cancelTimer()
    if (!dragEl) return
    dragEl.classList.remove('dragging')
    const order = [...strip.querySelectorAll<HTMLElement>('.strip-member[data-pk]')].map((n) => n.dataset.pk as string)
    dragEl = null
    stripDragGuard = true
    window.setTimeout(() => { stripDragGuard = false }, 400) // belt-and-braces if the click never lands
    patchActive({ memberOrder: order })
  }
  strip.querySelectorAll<HTMLElement>('.strip-member[data-pk]').forEach((node) => {
    node.addEventListener('pointerdown', (e) => {
      sx = e.clientX; sy = e.clientY
      timer = window.setTimeout(() => {
        dragEl = node
        node.classList.add('dragging')
        try { node.setPointerCapture(e.pointerId) } catch { /* unsupported */ }
      }, STRIP_HOLD_MS)
    })
    node.addEventListener('pointermove', (e) => {
      if (!dragEl) {
        if (timer && (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8)) cancelTimer()
        return
      }
      // Swap past whichever sibling the pointer has crossed the midpoint of.
      const siblings = [...strip.querySelectorAll<HTMLElement>('.strip-member[data-pk]')].filter((n) => n !== dragEl)
      for (const sib of siblings) {
        const r = sib.getBoundingClientRect()
        const mid = r.left + r.width / 2
        const dragBefore = dragEl.compareDocumentPosition(sib) & Node.DOCUMENT_POSITION_FOLLOWING
        if ((e.clientX > mid && dragBefore) || (e.clientX < mid && !dragBefore)) {
          strip.insertBefore(dragEl, dragBefore ? sib.nextSibling : sib)
          break
        }
      }
    })
    node.addEventListener('pointerup', end)
    node.addEventListener('pointercancel', end)
  })
}

/** Full reset: sign out, wipe local state and every circle on this device. */
function resetDevice(): void {
  closeRadar() // nothing may keep beeping or sampling past a reset
  if (persisted.authMethod === 'signet') {
    void import('signet-login').then(({ logout }) => logout()).catch(() => { /* ignore */ })
  }
  signetSigner = null
  store.reset()
  store.disarmRest()
  void burnLock()
  stopWatch?.(); stopWatch = null
  void stopBgWatch() // native shell: the foreground service (and its notification) must not outlive the reset
  void stopStayReachable() // and the stay-reachable service likewise
  // A device reset must leave nothing behind, including the journal.
  void import('../../native/publishMirror').then((m) => m.wipeNativePublish()).catch(() => { /* not running */ })
  void import('../../native/ble').then((b) => b.stopBle()).catch(() => { /* not running */ }); bleActive = false // BLE radio must not outlive the reset
  stopAllSubs()
  stopInviteSub?.(); stopInviteSub = null
  inviteSubKey = ''
  if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = 0 }
  sharing = false
  adding = false
  disbandConfirm = false
  resetConfirm = false
  removeConfirmPk = null
  lostConfirmPk = null
  expandedMemberPk = null
  dmComeToMeArmed = false
  dmPeer = null
  document.getElementById('dm-sheet')?.remove()
  closeCircleMenu()
  mapInitToken++
  const mounted = mapView
  mapView = null
  mounted?.destroy()
  fix = null
  lastCamera = null // a wipe forgets the last location too
  circleStates.clear()
  beaconCadence.clear()
  coverCadence.clear()
  persisted = store.load()
  onboardStep = 'intro'
  tab = 'home'
  render()
}

// ── Inbound ──────────────────────────────────────────────────────────────────
function ensureSubscriptions(): void {
  // Runs on every render — quiet on a Tor-not-ready failure (the toggle flip
  // and the foreground refresh already own telling the user once).
  const relays = activeRelaysQuiet()
  if (!relays) { stopAllSubs(); return }
  const relayKey = relays.join(',')
  // Desired subs: one per circle, keyed by inbox (a reseed → new inbox → re-subscribe).
  const wanted = new Map<string, store.Circle>()
  for (const c of persisted.circles) {
    const inbox = deriveInbox(c.seedHex)
    wanted.set(`${c.id}@${relayKey}@${inbox.pk}`, c)
  }
  for (const [key, stop] of subs) if (!wanted.has(key)) { stop(); subs.delete(key) }
  for (const [key, c] of wanted) {
    if (subs.has(key)) continue
    const inbox = deriveInbox(c.seedHex)
    const circleId = c.id
    subs.set(key, svc.subscribeGiftWraps(relays, inbox.pk, (wrap) => { void onSignalWrap(circleId, wrap, inbox.sk) }))
  }
}

function stopAllSubs(): void {
  for (const stop of subs.values()) stop()
  subs.clear()
}

/** Force a fully fresh relay connection AND subscriptions. The disease isn't just
 *  a dead REQ — the whole SimplePool can go silently stale on mobile (sockets
 *  ESTABLISHED, but publishes stop landing and EVENTs stop arriving), and closing
 *  + re-opening REQs on that SAME pool never recovers it. So we also destroy the
 *  pool (svc.resetPool → fresh WebSockets on the next getPool). Order matters:
 *  stopAllSubs first CLEARS the subs map so ensureSubscriptions actually rebuilds
 *  every sub (it skips keys it still holds) on the new pool. Called on the moments
 *  the user is waiting on others (opening Chat, coming to the foreground) and on a
 *  short failsafe — the actual cure for "messages just don't arrive". */
function resubscribe(): void {
  lastPoolReset = nowSec() // start the cooldown so the stale-path failsafe won't immediately re-rebuild
  stopAllSubs()      // release + forget our REQ handles so the rebuild below re-creates them
  svc.resetPool()    // tear the (possibly-stale) pool down — reconnecting is what actually recovers
  ensureSubscriptions() // resubscribe on a brand-new pool with fresh connections
}

/** Rebuild the pool ONLY if it looks stale — no wrap (chat OR presence beacon) has
 *  arrived for a while — and not more often than the cooldown. During an active
 *  circle wraps keep lastWrapAt fresh, so this is a no-op and never churns healthy
 *  connections; it fires only to heal a genuinely dead pool. Used by the periodic
 *  failsafe and on opening Chat. (Foreground/resume rebuilds unconditionally — a
 *  backgrounded socket is almost always stale by the time we're back.) */
function recoverIfStale(): void {
  const now = nowSec()
  if (now - lastWrapAt > POOL_STALE_SEC && now - lastPoolReset > POOL_RESET_COOLDOWN_SEC) resubscribe()
}

async function onSignalWrap(circleId: string, wrap: { pubkey: string; content: string; id?: string }, inboxSk: Uint8Array): Promise<void> {
  lastWrapAt = nowSec() // the relay just delivered something → the pool is alive (even a dup counts)
  // Dedup a wrap that arrives via BOTH relay and BLE — guarded on bleActive so the
  // relay-only path (web, e2e, anyone not opted in) is never altered. The BLE path
  // (onBleFrame) dedups once up front then calls dispatchWrap per circle directly,
  // so it never consumes this guard on a circle that simply fails to decrypt.
  if (bleActive && wrap.id && !markWrapSeen(wrap.id)) return
  // Mesh v2 downlink bridging: a phone with relay connectivity floods what it
  // JUST received DOWN into the mesh too — the mirror of onBleFrame's uplink
  // bridge, so members out of relay range but still BLE-meshed hear it. Gated
  // on crowd-mesh actually being active (festival) and the wrap being newly
  // seen (the markWrapSeen check above already ran); same buffer as every
  // other mesh frame, so the native reliability wrapper also offers it to
  // later-arriving peers after its room-scoped manifest exchange.
  if (bleActive && bleMode === 'mesh' && wrap.id && persisted.circles.some((x) => festivalActive(x))) {
    const id = wrap.id
    const frame = JSON.stringify({ id, pubkey: wrap.pubkey, content: wrap.content })
    try { const ble = await import('../../native/ble'); await ble.broadcastBle(frame) } catch { /* best-effort */ }
  }
  await dispatchWrap(circleId, wrap, inboxSk)
}

/** Decrypt one wrap against one circle's inbox and route the rumor. No dedup — the
 *  caller owns that (onSignalWrap for relay; onBleFrame once, then all circles). */
async function dispatchWrap(circleId: string, wrap: { pubkey: string; content: string; id?: string }, inboxSk: Uint8Array): Promise<void> {
  const rumor = await giftUnwrap(rawNip44Decrypt(inboxSk), wrap)
  if (rumor) await onIncoming(circleId, rumor)
}

async function onIncoming(circleId: string, e: { pubkey: string; content: string; tags: string[][]; created_at: number }): Promise<void> {
  const c = persisted.circles.find((x) => x.id === circleId)
  const me = persisted.identity
  if (!c) return
  if (!me || e.pubkey !== me.pk) {
    const activity = cstate(circleId).lastActivity
    activity.set(e.pubkey, Math.max(activity.get(e.pubkey) ?? 0, e.created_at))
  }
  const t = e.tags.find((x) => x[0] === 't')?.[1]
  try {
    if (t === 'beacon' || t === 'breach' || t === 'pickup') {
      // Legacy 'breach'/'pickup' types decrypt with the same beacon key — accept
      // them as plain location beacons so an older app version still shows up.
      const p = await decryptBeacon(deriveBeaconKey(c.seedHex), e.content)
      const jumpKey = `${c.id}:${e.pubkey}`
      if (me && e.pubkey !== me.pk) {
        const prevPrecision = cstate(c.id).beacons.get(e.pubkey)?.precision
        if (precisionJumpedToExact(prevPrecision, p.precision) && !exactJumpNotified.has(jumpKey)) {
          exactJumpNotified.add(jumpKey)
          // Deliberately no reason given — the wire never says WHY (§6 invariant
          // 1), so guessing "find each other" vs "come to me" vs a manual slider
          // change would be a claim we can't back up. Just the fact, so a sudden
          // "exact spot" reading isn't unexplained.
          toast(`${nameFor(e.pubkey)}'s sharing jumped to Exact spot. Probably a one-off boost, not their usual detail.`)
        } else if (p.precision < PRECISION_MAX) {
          exactJumpNotified.delete(jumpKey) // back to their normal detail — a later jump should notify again
        }
      }
      saveBeacon(c.id, { member: e.pubkey, geohash: p.geohash, precision: p.precision, timestamp: p.timestamp || e.created_at })
    } else if (t === 'buzz') {
      const bz = await decryptBuzz(c.seedHex, e.content)
      if (bz.from !== e.pubkey) return // the actor is bound to the authenticated seal signer — no impersonating another member (mirrors 'joined')
      if (!me || bz.from !== me.pk) {
        const mine = !!me && bz.target === me.pk
        const label = bz.action === 'ring_lost_phone' ? RING_LOST_PHONE_LABEL : coordinationLabel(bz.action)
        // A group action enters the circle log. False = a
        // relay replay repopulating history; those must stay silent.
        const isNew = isGroupCoordinationAction(bz.action)
          ? appendChat(c.id, { from: bz.from, action: bz.action, at: bz.timestamp })
          : true
        const isFresh = nowSec() - bz.timestamp <= MSG_FRESH_SEC
        // "Make it ring": if THIS phone is flagged lost and a member buzzed it,
        // escalate to the alarm channel — loud even on silent/DND — so whoever
        // is near it (a taxi driver, a passer-by) hears it. Output only: it
        // never discloses location or changes what we share. See app/src/ring.ts.
        const iAmFlaggedLost = !!me && !!memberLost(c.id, me.pk)?.lost
        if (shouldRing({ targetedAtMe: mine, iAmFlaggedLost })) {
          beingRung = { circleId: c.id, by: bz.from, at: nowSec() }
          notifyIfHidden(`${nameFor(bz.from)} is ringing this phone to help find it`, { kind: 'ring', title: c.name, group: `ring:${c.id}` })
          try { navigator.vibrate?.(RING_VIBRATION) } catch { /* no haptics */ }
        } else if (isNew && isFresh) {
          // A roll-call ask riding the buzz: if I'm already sharing to THIS
          // circle, freshen my pin (no new disclosure). Otherwise surface the
          // explicit "share once?" card — an ask is never an automatic answer.
          if (bz.ask === 'location' && !bz.target) {
            if (sharing && c.id === activeCircle()?.id) {
              beaconCadence.delete(c.id)
              void autoEmit()
            } else {
              locAsk = { circleId: c.id, from: bz.from, at: nowSec() }
            }
          }
          raiseBuzz({ from: bz.from, reason: label, mine, circle: c.name })
          // The buzz banner is in-app only — with the screen off it must still
          // land as a system notification. With a sender attached this renders
          // as a Signal-style conversation per circle: title "Night out", lines
          // "Alex: Come to me", one notification updated in place.
          notifyIfHidden(label, { kind: 'group', title: c.name, group: `group:${c.id}`, sender: nameFor(bz.from), conversation: c.name })
          try { navigator.vibrate?.(mine ? [300, 120, 300, 120, 300] : [200, 100, 200]) } catch { /* no haptics */ }
        }
      }
    } else if (t === 'pin') {
      const pin = await decryptPin(c.seedHex, e.content)
      if (pin.from !== e.pubkey) return // bind the dropper to the authenticated seal signer — no dropping pins as another member
      landPin(c.id, pin)
    } else if (t === LOST_SIGNAL_TYPE) {
      const rep = await decryptLost(c.seedHex, e.content)
      if (rep.by !== e.pubkey) return // only report AS yourself (rep.member may be someone else's phone, but the reporter is the authenticated sender)
      const st = cstate(c.id)
      const prev = st.lost.get(rep.member)
      // Latest wins, and a tie goes to the arrival — one-second timestamps make
      // "mark then immediately clear" land in the same second, and the clear
      // must not be dropped as a stale echo.
      if (prev && prev.timestamp > rep.timestamp) return
      st.lost.set(rep.member, rep)
      const mine = !!me && rep.member === me.pk
      const byMe = !!me && rep.by === me.pk
      if (rep.lost) {
        if (mine) {
          // THIS is the lost phone: be loud for whoever is holding it, and show
          // the finder card on Home (see lostCard).
          notifyIfHidden(`This phone was reported lost by ${nameFor(rep.by)} — open flock`, { kind: 'alert', title: c.name, group: `alert:${c.id}` })
          try { navigator.vibrate?.([400, 150, 400, 150, 400]) } catch { /* no haptics */ }
          toast(`${nameFor(rep.by)} reported this phone lost`)
        } else if (!byMe) {
          toast(`📵 ${nameFor(rep.by)} reported ${nameFor(rep.member)}'s phone lost`)
          notifyIfHidden(`${nameFor(rep.member)}'s phone was reported lost`, { kind: 'alert', title: c.name, group: `alert:${c.id}` })
        }
      } else {
        // Cleared. If it was THIS phone, stop reading as "being rung".
        if (mine && beingRung?.circleId === c.id) beingRung = null
        if (!byMe) toast(`✓ ${nameFor(rep.member)}'s phone is marked found`)
      }
    } else if (t === FIND_PING_SIGNAL_TYPE) {
      // "Find my phone": a member asks THIS device for a one-shot exact fix. We
      // answer only if the owner pre-authorised this circle AND the phone is
      // flagged lost AND the ask is aimed at us — then a cancel window before it
      // discloses. Any failing gate is silent (no tell). See app/src/findping.ts.
      const req = await decryptFindPing(c.seedHex, e.content)
      if (req.from !== e.pubkey) return // the asker is bound to the authenticated seal signer
      if (!me) return
      const gate = shouldAnswerFindPing({
        preAuthorised: !!c.pingConsent,
        iAmFlaggedLost: !!memberLost(c.id, me.pk)?.lost,
        targetedAtMe: req.target === me.pk,
      })
      if (!gate) return
      if (!withinPingRateLimit(pingAnsweredAt.get(c.id), nowSec(), FIND_PING_MIN_GAP_SECONDS)) return
      startFindPingCountdown(c.id, req.from)
      return
    } else if (t === DISBAND_SIGNAL_TYPE) {
      const d = await decryptDisband(c.seedHex, e.content)
      if (d.by !== e.pubkey) return // bind to the authenticated seal signer — a forged disband must not wipe everyone's circle
      const name = c.name
      removeCircle(c.id) // the owner ended it for everyone — drop it and wipe its seed
      if (!activeCircle()) tab = 'home'
      toast(`${d.by === me?.pk ? 'You' : nameFor(d.by)} disbanded ${name}`)
      render()
      return
    } else if (t === JOINED_SIGNAL_TYPE) {
      // A newcomer saying "I'm here" (optionally "…and I go by Dave") — the
      // roster update below is the point. Nobody can announce anyone but
      // themselves, and their handle is a suggestion: petnames always win.
      const j = await decryptJoined(c.seedHex, e.content)
      if (j.member !== e.pubkey) return
      if (j.handle && me && j.member !== me.pk && persisted.handles?.[j.member] !== j.handle) {
        persisted.handles = { ...persisted.handles, [j.member]: j.handle }
        store.save(persisted)
      }
    } else {
      return
    }
    ensureMember(c, e.pubkey)
    refresh()
  } catch {
    /* not for us, or undecryptable */
  }
}
