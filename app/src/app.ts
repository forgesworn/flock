// flock PWA — UI controller. Vanilla TS, render-on-state. Wires the flock
// library (decideEmission → build signal) to real Nostr publish/subscribe.

import * as store from './store'
import * as svc from './services'
import { makeLocalSigner, makeSignetSigner, type FlockSigner } from './signer'
import { login as signetLogin, restoreSession as signetRestore, logout as signetLogout } from 'signet-login'
import { buildSignInOptions } from './signin'
import { PRIVATE_RELAYS, ONION_RELAYS, parseRelayList, unknownRelays, effectiveRelays } from './relays'
import { deriveCircleSeed, deriveInbox, personalInboxTag } from './keys'
import { giftWrap, giftUnwrap, rawNip44Decrypt } from './giftwrap'
import { getProfile, fetchProfiles } from './profiles'
import { encode, decode, bounds, precisionToRadius } from 'geohash-kit'
import { shouldEmitBeacon, hasMoved, nextPollDelaySeconds, jitteredSeconds, shouldEmitCover, type BeaconCadence } from './cadence'
import { shouldRing, RING_VIBRATION, RING_REASON } from './ring'
import { shouldAnswerFindPing, withinPingRateLimit, FIND_PING_CANCEL_SECONDS, FIND_PING_MIN_GAP_SECONDS } from './findping'
import { advertIdNow, meshUuidNow } from './bleId'
import { createMeshBuffer, remember as rememberMeshWrap, liveEntries as liveMeshEntries, type MeshBufferState } from './meshBuffer'
import { WORD_INVITE, newWordCode, normaliseWordCode, deriveWordCodeSeed, wordInviteTag, wordInviteParkKey, buildWordInviteRef, readWordInviteRef, buildWordInviteDeletion } from './wordcode'
import qrcode from 'qrcode-generator'
import { npubEncode } from 'nostr-tools/nip19'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { MapView, MapPoint } from './map'
import { bboxContains, type BBox } from './area'
import { isNativeShell, shareOrigin, isApkUpdateAvailable } from './native'
import { rotationDue, refreshDue } from './rotation'
import { buildInviteWrap, buildReseedWraps, readInvite, readInviteViaRef, buildDmWrap, readDmWrap, buildPrivateLocationWrap, readPrivateLocationWrap, type DirectMessage, type PrivateLocationShare } from './invite'
import { exportBackup, importBackup, applyBackup } from './backup'
import { newSalt, deriveDecoyKey, sealState, openState, dummyWork } from './decoy'
import { generateStorageSecret, setupPin, unlockWithPin, unlockWithGrace, burnLock } from './lock'
import {
  decideEmission,
  haversineMetres,
  signalTypeForReason,
  buildLocationSignal,
  classifyPresence,
  buildBuzzSignal,
  decryptBuzz,
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
} from '@forgesworn/flock'

// ── State ──────────────────────────────────────────────────────────────────
let persisted = store.load()
let tab: 'home' | 'map' | 'circle' | 'you' = 'home'
let fix: svc.Fix | null = null
let sharing = false
let geoIssue: 'denied' | 'nofix' | null = null // actionable location trouble shown as a card, not a toast
let stopWatch: (() => void) | null = null
let hidden = false // app backgrounded (page hidden) — pause sampling; a hidden PWA can't sample reliably anyway
const subs = new Map<string, () => void>() // circleId@relay@inboxPk → unsubscribe (one per circle)
// Last automatic beacon per circle — drives the movement-aware re-emit gate so a
// stationary member (identical geohash cell) doesn't keep waking the relays.
const beaconCadence = new Map<string, BeaconCadence>()
// Automatic-emit cadence (seconds). Heartbeats stay well under the 600s presence
// "stale" window, so a still member keeps reading as "active" without spamming.
const COARSE_MIN_INTERVAL = 45 // never faster than this
const COARSE_HEARTBEAT = 300 //  …but re-affirm presence every 5 min when still
// Timing hygiene (audit F1): jitter softens the exact 45s/300s periods; cover
// traffic narrows the ~6x moving-vs-still swing with a low-rate decoy publish
// that fills the quiet stretch between heartbeats (src/signals.ts `cover` type
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
let toastTimer = 0

let mapView: MapView | null = null
let offlineBBox: BBox | null = null // bounds of the active circle's saved map (null = not offline)
let focusMemberPk: string | null = null // "see on map" target — frame their cell once the map mounts
let focusGeohash: string | null = null // a one-off PM location share's cell — not a live circle beacon, framed once then forgotten

let stopInviteSub: (() => void) | null = null
let inviteSubKey = ''
let awaitingInvite = false
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
 *  Only the download-page nudge on Home hangs off it — never an auto-update. */
let lastUpdateCheck = 0
async function checkForUpdate(): Promise<void> {
  if (updateAvailable) return // found once — stop asking
  // A backgrounded WebView suspends timers, so the 6-hour interval is unreliable;
  // the resume/visibility hooks below drive most real checks. Throttle so rapid
  // foreground/background toggles don't hammer the deploy.
  const now = Date.now()
  if (now - lastUpdateCheck < 20_000) return
  lastUpdateCheck = now
  try {
    const res = await fetch(`${shareOrigin()}/downloads/apk.json`, { cache: 'no-store' })
    if (!res.ok) return // no APK published yet (or offline) → never nag
    const v = (await res.json()) as { build?: string }
    if (isApkUpdateAvailable(__FLOCK_BUILD__, v.build)) {
      updateAvailable = true
      render()
    }
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
// Mesh v2 store-and-forward (app/src/meshBuffer.ts): wraps seen in crowd-mesh
// mode are RETAINED (200 wraps / 15 min TTL) and re-offered to later-arriving
// peers on the next mesh (re)start — today a frame floods only to peers
// connected at that instant, so a phone walking into range a minute later got
// nothing. Only touched in mesh mode; discreet mode stays single-hop, as
// designed. A full peer-connect manifest handshake (DarkFi tips-DAG-style) is
// hardware-gated — see docs/plans/2026-07-04-ble-mesh-v2-test-plan.md — this
// is the pure retention half plus a best-effort periodic re-flood using only
// the EXISTING plugin surface (broadcastBle), needing no native changes.
let meshBuffer: MeshBufferState = createMeshBuffer()
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
let disbandConfirm = false // inline confirm for the destructive "disband for everyone"
let resetConfirm = false // inline confirm for the destructive "sign out & reset this device"
let removeConfirmPk: string | null = null // member pk pending an inline remove confirm
let lostConfirmPk: string | null = null // member pk pending an inline "report lost" confirm
let editingPetname: string | null = null // pubkey whose nickname is being edited inline
let dmComeToMeArmed = false // PM "Come to me" inline confirm is open (it shares an exact spot, privately, to just this person)

// Per-circle live state — signals are circle-scoped, so beacons from one circle
// must never bleed into another. Keyed by circle id.
interface CircleState {
  beacons: Map<string, MemberBeacon>
  /** Latest lost-phone report per member (mark or clear — latest wins). */
  lost: Map<string, LostReport>
}
const circleStates = new Map<string, CircleState>()
function cstate(id: string): CircleState {
  let s = circleStates.get(id)
  if (!s) { s = { beacons: new Map(), lost: new Map() }; circleStates.set(id, s) }
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
  persisted.activeCircleId = id
  store.save(persisted)
  disbandConfirm = false
  resetConfirm = false
  removeConfirmPk = null
  lostConfirmPk = null
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

/** Short label for a map pin: my private petname → their announced handle →
 *  public name (opted-in) → 2-char initials. Falls back to initials, never a
 *  long npub, so the pin tag stays tidy; caps a long name so one member can't
 *  stretch the tag across the map. Rendered via textContent in map.ts, so it
 *  is not (and must not be double-) HTML-escaped here. */
function pinLabel(pk: string): string {
  const name = (persisted.petnames[pk] || persisted.handles?.[pk] || (persisted.showProfiles ? getProfile(pk)?.name : '') || '').trim()
  if (!name) return initials(pk)
  return name.length > 14 ? `${name.slice(0, 13)}…` : name
}

/** Avatar markup — a public picture (opted-in) or initials. `isMe` shows "You". */
function avatarHtml(pk: string, isMe: boolean, small = false): string {
  const cls = small ? 'avatar small' : 'avatar'
  if (persisted.showProfiles) {
    const pic = getProfile(pk)?.picture
    if (pic) return `<span class="${cls}"><img src="${esc(pic)}" alt="" loading="lazy" referrerpolicy="no-referrer"/></span>`
  }
  return `<span class="${cls}">${isMe ? 'You' : initials(pk)}</span>`
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
      await ble.startBle({ room: uuid, selfId: id.pk, serviceUuid: uuid, hops }, onBleFrame)
      bleActive = true
      bleMode = mesh ? 'mesh' : 'discreet'
      // Mesh v2 store-and-forward: re-offer everything still-live in the buffer
      // on every mesh (re)start — the JS-level approximation of "re-advertise
      // to later-arriving peers" until a native peer-connect hook exists (see
      // the test-plan doc). Best-effort; a peer who already has an entry just
      // dedups it (markWrapSeen on their side).
      if (bleMode === 'mesh') {
        for (const entry of liveMeshEntries(meshBuffer, nowSec())) void ble.broadcastBle(entry.data)
      }
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
  // Mesh v2 store-and-forward: retain it (mesh mode only — discreet stays
  // single-hop) so a peer who walks into range after this instant still gets
  // it on the next mesh (re)start (see syncBle's re-flood, above).
  if (bleMode === 'mesh') meshBuffer = rememberMeshWrap(meshBuffer, { id: ev.id, data }, nowSec())
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
  map: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s6.5-5.7 6.5-11A6.5 6.5 0 0 0 5.5 10c0 5.3 6.5 11 6.5 11Z"/><circle cx="12" cy="10" r="2.3"/></svg>',
  circle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><path d="M16 5.5a3 3 0 0 1 0 5.8M16.5 20a5.5 5.5 0 0 0-3-4.9"/></svg>',
  you: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 7.7-7 9-4-1.3-7-4.5-7-9V6z"/><circle cx="12" cy="10" r="2.3"/><path d="M8.5 16.5a3.6 3.6 0 0 1 7 0"/></svg>',
}

// ── Mount / render ──────────────────────────────────────────────────────────
export function mount(el: HTMLElement): void {
  root = el
  // Persistent banner layer, outside `root` so render() (which rewrites root's
  // innerHTML) can't wipe or re-animate it. Reused across mounts.
  bannerLayer = document.getElementById('banner-layer') ?? document.body.appendChild(Object.assign(document.createElement('div'), { id: 'banner-layer' }))
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
  renderLockScreen()
}

function bootUnlocked(): void {
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

/** Join straight from a scanned/tapped link — the same path as a pasted code.
 *  A guest without a handle is asked for one FIRST (join-name screen): the
 *  moment they land in the circle is exactly when "who is this?" matters. */
function joinFromLink(code: string): void {
  try {
    const circle = store.decodeInvite(store.inviteCodeFrom(code))
    if (persisted.circles.some((c) => c.id === circle.id)) { switchCircle(circle.id); return }
    if (!persisted.myHandle) { pendingJoin = circle; render(); return }
    completeJoin(circle)
  } catch { toast('That join link is not valid — ask for a fresh one.') }
}

function completeJoin(circle: store.Circle): void {
  persisted.identity ??= store.createIdentity()
  circle.members = [persisted.identity.pk]
  circle.joinedAt = nowSec() // the roster about to replay is not news — see JOIN_GRACE_SEC
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

/** The "what should they call you?" step for a link/QR guest. */
function joinNameView(c: store.Circle): string {
  return `<main class="screen onboard fade-in">
    <img class="hero-logo" src="./icon.svg" alt="" />
    <h1>Joining ${esc(c.name)}</h1>
    <p class="tagline">What should this circle call you? A first name or nickname is perfect.</p>
    <div class="actions">
      <div class="field"><label for="join-handle">Your name</label><input class="input" id="join-handle" maxlength="40" placeholder="Dave · Mum · a nickname" /></div>
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
  // The map now lives on BOTH Home (compact) and the Map tab — keep it alive for
  // either, tear it down elsewhere. wireApp re-mounts it into the active tab's #map.
  if (tab !== 'map' && tab !== 'home' && mapView) { mapView.destroy(); mapView = null }
  if (persisted.identity) ensureInviteSub()
  const keep = captureFocusedInput()
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
  const body = tab === 'home' ? homeView() : tab === 'map' ? mapView_screen() : tab === 'circle' ? circleView() : youView()
  root.innerHTML = `${findPingBanner()}<main class="screen ${animate ? 'fade-in ' : ''}${tab === 'map' ? 'map-screen' : ''}">${body}</main>${navView()}<div class="toast" id="toast"></div>`
  patchBuzzBanner() // the buzz banner lives in its own layer — keep it in sync after a render
  wireApp()
  if (dmPeer) mountDmSheet() // a full render drops the overlay — put it back
  if (circleMenu) mountCircleMenu() // same for the long-press action sheet
  restoreFocusedInput(keep)
  // Being ON Home with the thread in view IS reading it (Signal-in-the-chat).
  if (tab === 'home' && !document.hidden && activeCircle()) markThreadRead(chatKeyOf((activeCircle() as store.Circle).id))
  scrollChatToEnd()
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
  if (sharing && fix) return { cls: 'state-share', label: 'Sharing live', sub: `${precisionLabel(sharePrecisionOf(c))} · your circle can see you` }
  if (sharing && !fix) return { cls: 'state-share', label: 'Locating…', sub: 'Getting a fix' }
  return { cls: 'state-safe', label: 'Private', sub: 'Location hidden until you share it' }
}

function homeMapStatusHtml(): string {
  const s = homeMapStatus()
  const n = memberPoints().filter((p) => p.member !== persisted.identity?.pk).length
  const seen = n ? `${n} ${n === 1 ? 'person' : 'people'} on the map` : 'No one sharing right now'
  return `<div class="map-status ${s.cls}" id="home-map-status">
    <span class="ms-dot"></span>
    <span class="ms-text"><strong>${esc(s.label)}</strong><span class="ms-sub">${esc(s.sub)} · ${esc(seen)}</span></span>
    <span class="ms-open" data-action="tab" data-tab="map" aria-label="Open the full map">⤢</span>
  </div>`
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
const GROUP_QUICK_ACTIONS = ['Check in', 'On my way'] as const
const DM_QUICK_ACTIONS = ['Come to me', 'Where are you?', 'Call me', 'On my way'] as const

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

function homeView(): string {
  const c = activeCircle() as store.Circle
  return `
    ${topbar()}
    ${updateAvailable ? `
    <div class="card stack" style="margin-bottom:14px">
      <div><strong>A newer version of flock is ready</strong></div>
      <div class="note">Download it and install over the top — everything on this phone stays put.</div>
      <a class="btn small primary" href="https://flock.forgesworn.dev/get.html">Get the update</a>
    </div>` : ''}
    <div class="home-map-shell">
      <div id="map" class="map-canvas home-map"></div>
      ${homeMapStatusHtml()}
    </div>
    <div id="home-panel">${homePanelInner(c)}</div>`
}

/** Everything below the Home map — the scrollable home: share toggle, the
 *  people, the circle chat, then the dials (precision, find-each-other).
 *  Isolated so a presence tick can re-render it in place, leaving the live map
 *  above untouched (mirrors the map tab's #map-panel pattern). */
function homePanelInner(c: store.Circle): string {
  return `
    <div class="actions">
      <button class="btn ${sharing ? 'ghost' : 'primary'}" data-action="toggle-share">
        ${sharing ? 'Stop sharing' : 'Start sharing'}
      </button>
      ${hint('home-watch', 'Sharing live lets your circle see where you are — you choose how closely with the slider below. Stop any time; nothing is shared while it\'s off. Tap anyone on the map to message them privately.')}
    </div>
    ${geoIssueCard()}
    ${batteryCard()}
    ${rollCallCard()}
    ${lostCard(c)}
    ${memberStrip()}
    ${inviteCta()}
    ${chatSection(c)}
    ${precisionCard(c)}
    ${festivalCard(c)}`
}

/** The circle's people at a glance — avatars with a presence dot, right under
 *  the map. Tap someone to message them privately; tap yourself for your row
 *  on the Circle tab; the ＋ leads to inviting. */
function memberStrip(): string {
  const me = persisted.identity?.pk ?? ''
  const st = active()
  const items = members().map((pk) => {
    const b = st?.beacons.get(pk)
    const p = b ? classifyPresence([b], nowSec(), { staleAfterSeconds: 600 })[0] : null
    const dot = p ? (p.status === 'active' ? 'on' : 'idle') : ''
    const isMe = pk === me
    const label = isMe ? 'You' : nameFor(pk)
    return `<button class="strip-member" data-action="strip-member" data-pk="${pk}" aria-label="${esc(isMe ? 'You' : `Message ${label} privately`)}">
      <span class="strip-avatar">${avatarHtml(pk, isMe)}${dot ? `<span class="presence-dot ${dot}"></span>` : ''}</span>
      <span class="strip-name">${esc(label.length > 9 ? `${label.slice(0, 8)}…` : label)}</span>
    </button>`
  }).join('')
  return `<div class="member-strip">${items}<button class="strip-member add" data-action="go-invite" aria-label="Invite someone">
    <span class="strip-avatar plus">＋</span><span class="strip-name">Invite</span>
  </button></div>`
}

/** The circle chat — one running, Signal-style thread for everyone in the
 *  circle. Quick actions live here as presets (they ARE messages) — just the
 *  ones that make sense said to a whole group; person-to-person asks ("Come to
 *  me", "Where are you?", "Call me") live in the PM sheet instead. */
function chatSection(c: store.Circle): string {
  const list = persisted.chats?.[c.id] ?? []
  const thread = list.slice(-CHAT_SHOWN).map((m, i, arr) => chatBubble(m, arr[i - 1])).join('')
    || `<div class="note chat-empty">No messages yet. Say something: everyone in ${esc(c.name)} sees it, it's encrypted end-to-end and lives only on your phones.</div>`
  const chip = (r: string): string => r === 'Check in'
    ? `<button class="btn small" data-action="check-in">${esc(r)}</button>`
    : `<button class="btn small" data-action="chat-preset" data-reason="${esc(r)}">${esc(r)}</button>`
  return `<div class="section-title" style="margin-top:22px">Chat · ${esc(c.name)}</div>
  <div class="card chat-card">
    <div class="chat-thread" id="chat-thread">${thread}</div>
    <div class="chip-row chat-presets">${GROUP_QUICK_ACTIONS.map(chip).join('')}</div>
    <div class="chat-composer">
      <textarea class="input" id="chat-input" rows="1" maxlength="500" placeholder="Message ${esc(c.name)}…" autocapitalize="sentences"></textarea>
      <button class="btn small primary" data-action="chat-send">Send</button>
    </div>
    ${hint('chat', 'Messages go to everyone in this circle, encrypted end-to-end: the servers never see them. “Check in” also asks all your circles to show where they are. To message one person privately, and ask them to come to you with your exact spot, tap them above or on the map.')}
  </div>`
}

/** One chat bubble. The sender's name heads a run of their messages (Signal
 *  style) — never on my own (right-aligned) bubbles. */
function chatBubble(m: store.ChatMessage, prev?: store.ChatMessage): string {
  const mine = m.from === persisted.identity?.pk
  const who = !mine && (!prev || prev.from !== m.from) ? `<span class="msg-who">${esc(nameFor(m.from))}</span>` : ''
  // A private "Come to me" location share — the marker text plus its precision,
  // and (received side only) a jump to see it on the map.
  const view = !mine && m.geohash
    ? `<button class="btn small ghost" data-action="see-shared-location" data-geohash="${esc(m.geohash)}">See on map</button>`
    : ''
  const size = m.precision !== undefined ? ` · ${esc(precisionSize(m.precision))}` : ''
  return `<div class="msg${mine ? ' mine' : ''}">${who}<span class="msg-text">${esc(m.text)}${size}</span>${view}<span class="msg-when">${esc(fmtChatTime(m.at))}</span></div>`
}

/** "14:02" today, "Wed 14:02" earlier — a running conversation's clock. */
function fmtChatTime(at: number): string {
  const d = new Date(at * 1000)
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

/** Sharing is on but flock isn't battery-exempt: the one setting that makes
 *  locked-screen sharing actually hold. Actionable card, not a silent gap. */
function batteryCard(): string {
  if (!isNativeShell() || !sharing || batteryExempt !== false) return ''
  return `<div class="card stack geo-issue" style="margin-top:14px">
    <strong>Keep sharing with the screen off</strong>
    <div class="note">Android pauses flock's connection a few minutes after the phone locks, so your circle would stop seeing you mid-walk. Allow flock to ignore battery optimisation: it's the same setting Signal asks for, and the location toggle still rules what's shared.</div>
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
  return `<div class="card stack geo-issue" style="margin-top:14px" role="alert">
    <strong>This phone was reported lost</strong>
    <div class="note">${esc(nameFor(rep.by))} flagged it in ${esc(c.name)}. Found this phone? Please help it home — its owner's friends can see roughly where it is.</div>
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

/** A loud, friendly nudge to invite people while you're the only one here. */
function inviteCta(): string {
  if (members().length > 1) return ''
  return `<div class="card invite-cta" data-action="go-invite" role="button" tabindex="0">
    <div class="cta-emoji">👋</div>
    <div class="cta-text"><strong>It's just you so far</strong><span>Add the people you want to stay close to.</span></div>
    <span class="cta-go">Invite →</span>
  </div>`
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
  const pill = lost
    ? '<span class="pill alert">phone lost</span>'
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
    ? `${isMe ? 'you · ' : ''}on the map · within ${precisionSize(beacon.precision).replace('~', '')} · last seen ${seenAt}`
    : isMe ? 'you' : 'in this circle'
  const locate = beacon ? `<button class="icon-btn" data-action="see-on-map" data-pk="${pk}" aria-label="See on the map">📍</button>` : ''
  // Lost phone: anyone can flag a member's phone, anyone can clear it — a
  // coordination flag, deliberately not gated on the owner (they don't have
  // their phone; that's the point).
  // A flagged-lost phone can be RUNG — a targeted buzz it plays as a loud alarm
  // even on silent, so it's findable by sound (the back-of-a-taxi minutes problem).
  const ringBtn = lost && !isMe
    ? `<button class="btn small" data-action="make-it-ring" data-pk="${pk}" title="Ring it — sounds even on silent">🔔 Ring</button>`
    : ''
  // ...and asked for a ONE-SHOT exact fix, but only if its owner pre-authorised
  // this circle and it's flagged lost (it decides on-device; this is just the ask).
  const findBtn = lost && !isMe
    ? `<button class="btn small" data-action="find-exact" data-pk="${pk}" title="Ask for an exact location (only if its owner allowed it)">📍 Find</button>`
    : ''
  const lostBtn = lost
    ? `${ringBtn}${findBtn}<button class="btn small" data-action="found-phone" data-pk="${pk}">Found it</button>`
    : isMe ? '' : `<button class="icon-btn" data-action="ask-lost" data-pk="${pk}" aria-label="Report their phone lost">📵</button>`
  const edit = isMe ? '' : `<button class="icon-btn" data-action="edit-petname" data-pk="${pk}" aria-label="Set a nickname">✎</button>`
  // Private message — works whether or not they're on the map right now (a pin tap
  // is the map-side equivalent). Not for my own row.
  const msg = isMe ? '' : `<button class="icon-btn" data-action="msg-member" data-pk="${pk}" aria-label="Message ${esc(nameFor(pk))} privately">✉️</button>`
  // Remove — right here where you're looking at the roster, not buried three
  // taps deep in Advanced settings. Reuses the same confirm + reseed as before.
  const remove = isMe ? '' : `<button class="icon-btn" data-action="ask-remove" data-pk="${pk}" aria-label="Remove ${esc(nameFor(pk))} from this circle">🚪</button>`
  const isNew = (activeCircle()?.unseenMembers ?? []).includes(pk)
  return `<div class="member${isNew ? ' unseen' : ''}">
    ${avatarHtml(pk, isMe)}
    <div class="meta"><div class="who">${isMe ? 'You' : esc(nameFor(pk))}${isNew ? ' <span class="pill new">new</span>' : ''}</div><div class="when">${sub}</div></div>
    ${pill}${msg}${locate}${lostBtn}${edit}${remove}
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
      <div class="note">Let them scan the QR with their camera — it opens flock and joins in one tap. Or copy the link and send it. It carries the secret, so treat it like a password.</div>
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
        <div class="note">Four plain words you can read out or send over Signal — no scanning, no long link. The words aren’t the secret; they unlock a one-time invite parked on your private relay, and expire in 15 minutes.</div>
      `}
    </div>

    <div class="section-title" style="margin-top:22px">Send to their key (remote)</div>
    <div class="card stack">
      ${hint('invite-remote', "In person? Show them the QR above. Far away? Ask them to open flock, tap 'Join remotely', and send you the key it shows.")}
      <div class="field"><label for="invite-npub">Their invite key</label><input class="input" id="invite-npub" placeholder="npub1…" value="${esc(pendingInviteNpub ?? '')}" autocapitalize="off" autocorrect="off" spellcheck="false" /></div>
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

    <div class="section-title" style="margin-top:22px">If your phone gets lost</div>
    <div class="card stack">
      <div class="row" style="justify-content:space-between;gap:12px">
        <span>Let this circle find my phone</span>
        <button class="switch${c.pingConsent ? ' on' : ''}" data-action="toggle-ping-consent" role="switch" aria-checked="${!!c.pingConsent}" aria-label="Let this circle find my phone"><span class="knob"></span></button>
      </div>
      <div class="note">${hint('ping-consent', "If your phone is ever lost, members can ask it for its exact location to come and fetch it. It only answers when it's been marked lost, warns you first with a chance to say no, and never turns on ongoing sharing. Off by default.")}</div>
    </div>`
}

function youView(): string {
  const me = persisted.identity as store.Identity
  const c = activeCircle() as store.Circle
  void refreshDndAccess() // native: reflect current DND-access grant (re-renders only if it changed)
  return `
    ${topbar()}
    <h2 style="margin-bottom:14px">You</h2>
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
    <div class="note" style="margin-top:16px;text-align:center">flock · your location, shared only when you choose<br/>version ${esc(__FLOCK_BUILD__)} · ${esc(__FLOCK_BUILT_AT__)}</div>`
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
    const preview = (last?.from === me ? 'You: ' : '') + (last?.text ?? '')
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
        <button class="switch${persisted.stayReachable ? ' on' : ''}" data-action="toggle-stay-reachable" role="switch" aria-checked="${!!persisted.stayReachable}"><span class="knob"></span></button>
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
  const item = (id: string, label: string, icon: string, unread = 0): string =>
    `<button data-action="tab" data-tab="${id}" aria-current="${tab === id}">${icon}<span>${label}</span>${unread ? `<span class="nav-badge">${unread > 9 ? '9+' : unread}</span>` : ''}</button>`
  return `<nav class="nav">${item('home', 'Home', ICON.home, groupUnreadTotal())}${item('map', 'Map', ICON.map)}${item('circle', 'Circle', ICON.circle)}${item('you', 'You', ICON.you, dmUnreadTotal())}</nav>`
}

// ── Map screen ───────────────────────────────────────────────────────────────
function mapView_screen(): string {
  return `
    ${topbar()}
    <div class="map-shell">
      <div class="map-stage">
        <div id="map" class="map-canvas"></div>
        <div id="offline-oob" class="offline-oob" hidden></div>
      </div>
      <div class="map-panel" id="map-panel">${mapPanelInner()}</div>
    </div>`
}

function mapPanelInner(): string {
  const c = activeCircle()
  const mine = sharing
    ? `<div class="note">You're sharing at ${esc(precisionLabel(sharePrecisionOf(c)).toLowerCase())} — your own pin and square are exactly what everyone else sees of you. Change the detail on Home.</div>`
    : `<div class="note">You're not sharing — nothing of yours is on anyone's map. ${fix ? 'The dashed square shows what your circle <em>would</em> see at your current detail setting.' : ''}</div>`
  return `
    <div class="row" style="justify-content:space-between"><strong>${esc(c?.name ?? 'Your circle')}</strong></div>
    <div class="note">Everyone sharing appears here — each somewhere inside their square, at the detail its owner chose; an exact share is a bare pin.</div>
    ${mine}`
}

// ── Views: onboarding ────────────────────────────────────────────────────────
function onboardingView(): string {
  let inner: string
  if (onboardStep === 'create') {
    const ttlChip = (mode: string, label: string): string =>
      `<button class="btn small${ttlMode === mode ? ' primary' : ''}" data-action="ob-ttl" data-ttl="${mode}">${label}</button>`
    inner = `
      <h1>New circle</h1>
      <p class="tagline">Give it a name and choose how long it lasts.</p>
      <div class="field" style="text-align:left;margin-bottom:14px"><label for="cname">Name</label><input class="input" id="cname" placeholder="Mallorca trip · The Smiths · Sat night" /></div>
      <div class="field" style="text-align:left;margin-bottom:6px"><label>How long</label></div>
      <div class="chip-row" role="group" aria-label="Lifetime" style="margin-bottom:10px;justify-content:center">
        ${ttlChip('ongoing', 'Ongoing')}${ttlChip('today', 'Today')}${ttlChip('custom', 'Custom')}
      </div>
      <div id="ob-ttl-custom" class="row" style="gap:8px;justify-content:center;margin-bottom:22px"${ttlMode === 'custom' ? '' : ' hidden'}>
        <input class="input" id="ttl-num" type="number" min="1" max="60" value="3" style="max-width:84px" />
        <select class="input" id="ttl-unit" style="max-width:120px"><option value="hours">hours</option><option value="days" selected>days</option></select>
      </div>
      <div class="actions">
        <button class="btn primary" data-action="do-create">Create circle</button>
        <button class="btn ghost" data-action="back">Back</button>
      </div>`
  } else if (onboardStep === 'join') {
    inner = `
      <h1>Join a circle</h1>
      <p class="tagline">Type the six words someone read you, paste an invite code, or join remotely by sharing your key.</p>
      <div class="field" style="text-align:left;margin-bottom:12px"><label for="jwords">Spoken words</label><input class="input" id="jwords" placeholder="six words, in order" autocapitalize="off" autocorrect="off" spellcheck="false" /></div>
      <div class="actions" style="margin-bottom:18px">
        <button class="btn primary" data-action="join-words"${spokenCodeBusy ? ' disabled' : ''}>${spokenCodeBusy ? 'Finding invite…' : 'Join with words'}</button>
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
      <p class="tagline">Create another circle or join one — you can be in many at once: family, a trip, a night out.</p>
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
      <div class="note onboard-note">version ${esc(__FLOCK_BUILD__)} · ${esc(__FLOCK_BUILT_AT__)}</div>`
  }
  return `<main class="screen onboard fade-in">${inner}</main><div class="toast" id="toast"></div>`
}

// ── Wiring ───────────────────────────────────────────────────────────────────
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
  root.querySelectorAll('[data-action]').forEach((node) => {
    node.addEventListener('click', () => {
      const a = node.getAttribute('data-action')
      if (a === 'create') { onboardStep = 'create'; rerenderOnboard() }
      else if (a === 'join') { onboardStep = 'join'; rerenderOnboard() }
      else if (a === 'restore') { onboardStep = 'restore'; rerenderOnboard() }
      else if (a === 'do-restore') void doRestore()
      else if (a === 'back') { onboardStep = 'intro'; awaitingInvite = false; rerenderOnboard() }
      else if (a === 'ob-ttl') {
        // Update in place too, for the same reason as ob-mode.
        ttlMode = (node as HTMLElement).dataset.ttl as 'ongoing' | 'today' | 'custom'
        root.querySelectorAll<HTMLElement>('[data-action="ob-ttl"]').forEach((b) => b.classList.toggle('primary', b.dataset.ttl === ttlMode))
        const cust = document.getElementById('ob-ttl-custom')
        if (cust) (cust as HTMLElement).hidden = ttlMode !== 'custom'
      }
      else if (a === 'cancel-add') { adding = false; onboardStep = 'intro'; render() }
      else if (a === 'do-create') doCreate()
      else if (a === 'do-join') doJoin()
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
  const brand = root.querySelector<HTMLElement>('.topbar .brand')
  if (brand) wireHideHold(brand)
  root.querySelectorAll<HTMLElement>('.circle-chip:not(.add)').forEach((chip) => {
    const id = chip.getAttribute('data-id')
    if (id) wireChipHold(chip, id)
  })
  if (tab === 'map' || tab === 'home') void initMap()
}

/** The Home-screen "location detail" slider. `input` patches the labels in place
 *  (a full render mid-drag would tear the control out from under the thumb);
 *  `change` commits: persist, re-tier sampling, and re-emit promptly so the
 *  circle sees the new detail level straight away.
 *  Two guards against "it changed by itself":
 *  - while a finger is on the thumb, background panel rebuilds are DEFERRED
 *    (sliderDragging → homePanelDirty), so the control is never torn mid-drag;
 *  - a `change` from a slider no longer in the DOM (a rebuild raced the release)
 *    is ignored — a detached thumb must never commit a stale value. */
let sliderDragging = false
let homePanelDirty = false
function wirePrecisionSlider(): void {
  const slider = document.getElementById('share-precision') as HTMLInputElement | null
  if (!slider) return
  const dragEnd = (): void => {
    if (!sliderDragging) return
    sliderDragging = false
    if (homePanelDirty) { homePanelDirty = false; renderHomePanel() }
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
async function initMap(camera?: { lng: number; lat: number; zoom: number }): Promise<void> {
  mapView?.destroy()
  const container = document.getElementById('map')
  if (!container) return
  const { MapView } = await import('./map') // lazy — keeps maplibre out of the main bundle
  mapView = await MapView.create(container, fix ?? undefined, { circleId: activeCircle()?.id })
  // Tap a member's pin → their private thread (skip my own pin — that's just me).
  mapView.onMemberClick((pk) => { if (pk && pk !== persisted.identity?.pk) openDmThread(pk) })
  if (import.meta.env.DEV) (window as unknown as { flockMapView?: unknown }).flockMapView = mapView // e2e seam (dev only)
  updateMapData()
  requestAnimationFrame(() => mapView?.map.resize())
  if (camera) { mapView.map.jumpTo({ center: [camera.lng, camera.lat], zoom: camera.zoom }); mapView.suppressAutoFit() } // a re-init keeps the person's view
  // "See on map": frame the chosen member's whole disclosed cell (a Region cell
  // needs a very different zoom from a street one), then hand the camera over.
  if (focusMemberPk) {
    const b = active()?.beacons.get(focusMemberPk)
    focusMemberPk = null
    if (b) {
      const bb = bounds(b.geohash)
      mapView.autoFit([{ lat: bb.minLat, lon: bb.minLon }, { lat: bb.maxLat, lon: bb.maxLon }])
      mapView.suppressAutoFit()
    }
  }
  // A PM "Come to me" location share, tapped from the DM thread — frame its
  // cell the same way, but it's a one-off (not a live circle beacon), so
  // there's nothing to look up beyond the geohash itself.
  if (focusGeohash) {
    const bb = bounds(focusGeohash)
    focusGeohash = null
    mapView.autoFit([{ lat: bb.minLat, lon: bb.minLon }, { lat: bb.maxLat, lon: bb.maxLon }])
    mapView.suppressAutoFit()
  }
  if (offlineMapEnabled()) void refreshOfflineState()
  if (!fix && !camera) void centreOnCurrentPosition() // no live share yet → actively locate for the map
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
  renderMapPanel()
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

function renderMapPanel(): void {
  const panel = document.getElementById('map-panel')
  if (panel) panel.innerHTML = mapPanelInner()
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
function updateMapData(): void {
  const pts = memberPoints()
  mapView?.setMembers(pts)
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
  // A reseed (security reset, member removal, monthly rotation) changes which
  // inbox each circle listens on. The full render() path always re-syncs
  // subscriptions, but the in-place branches below did NOT — so sitting on
  // Home (the default, most-common tab) silently kept the OLD subscription
  // alive until a tab switch or restart forced a full render. Idempotent diff
  // against the current subs Map, so calling it every tick is cheap.
  ensureSubscriptions()
  // Both map-bearing tabs update in place — a full render would destroy the live
  // map canvas (and any open thread sheet) under the user on every presence tick.
  if (tab === 'map' && mapView) { updateMapData(); renderMapPanel(); patchBuzzBanner(); patchNavBadges() }
  else if (tab === 'home' && mapView) { updateMapData(); renderHomePanel(); patchBuzzBanner(); patchNavBadges() }
  else render({ animate: false }) // a background refresh must not replay the fade-in (it reads as a flash)
}

/** Keep the nav's unread badges honest during in-place refreshes (a DM landing
 *  while the map tab is up must still light You) without a full rebuild. */
function patchNavBadges(): void {
  const nav = document.querySelector('.nav')
  if (!nav) return
  const set = (tabId: string, n: number): void => {
    const btn = nav.querySelector(`[data-tab="${tabId}"]`)
    if (!btn) return
    const existing = btn.querySelector('.nav-badge')
    if (!n) { existing?.remove(); return }
    const label = n > 9 ? '9+' : String(n)
    if (existing) { existing.textContent = label; return }
    const el = document.createElement('span')
    el.className = 'nav-badge'
    el.textContent = label
    btn.appendChild(el)
  }
  set('home', groupUnreadTotal())
  set('you', dmUnreadTotal())
}

/** Re-render Home's controls in place (share toggle, people, chat, precision)
 *  plus the map status chip, leaving the live map canvas above untouched. Mirrors
 *  the map tab's renderMapPanel; re-binds only the panel's own actions.
 *  Deferred while the precision slider is mid-drag — rebuilding the control
 *  under the finger both kills the drag AND lets the detached slider commit a
 *  stale value on release ("the slider changed by itself"). */
function renderHomePanel(): void {
  if (sliderDragging) { homePanelDirty = true; return }
  const keep = captureFocusedInput() // half-typed chat must survive an incoming beacon
  const panel = document.getElementById('home-panel')
  if (panel) {
    panel.innerHTML = homePanelInner(activeCircle() as store.Circle)
    panel.querySelectorAll('[data-action]').forEach((node) => {
      const action = node.getAttribute('data-action') as string
      node.addEventListener('click', () => handleAction(action, node as HTMLElement))
    })
    wirePrecisionSlider()
  }
  restoreFocusedInput(keep)
  if (tab === 'home' && !document.hidden && activeCircle()) markThreadRead(chatKeyOf((activeCircle() as store.Circle).id))
  scrollChatToEnd()
  const status = document.getElementById('home-map-status')
  if (status) {
    const tmp = document.createElement('div')
    tmp.innerHTML = homeMapStatusHtml()
    const fresh = tmp.firstElementChild as HTMLElement | null
    if (fresh) {
      status.replaceWith(fresh)
      fresh.querySelectorAll('[data-action]').forEach((node) => {
        const action = node.getAttribute('data-action') as string
        node.addEventListener('click', () => handleAction(action, node as HTMLElement))
      })
    }
  }
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
    const session = await signetLogin(buildSignInOptions('flock', [...PRIVATE_RELAYS]))
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
    const session = await signetRestore({ defaultRelay: PRIVATE_RELAYS[0] })
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
      members: roster, joinedAt: nowSec(), reseededAt: nowSec(), ...(payload.x ? { expiresAt: payload.x } : {}),
    }
    upsertCircle(joined, true)
    announceJoin(joined) // the inviter expected me, but the REST of the circle didn't
    awaitingInvite = false
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

// ── Buzz ─────────────────────────────────────────────────────────────────────
async function sendBuzz(reason: string, target?: string, opts?: { quiet?: boolean }): Promise<void> {
  const c = activeCircle()
  const id = persisted.identity
  if (!c || !id) return
  const r = reason.trim()
  if (!r) { toast('Pick or type a reason'); return }
  try {
    const at = nowSec()
    const tmpl = await buildBuzzSignal({ groupId: c.id, seedHex: c.seedHex, from: id.pk, reason: r, timestamp: at, ...(target ? { target } : {}) })
    await publishSignal(tmpl, c)
    // An untargeted buzz IS a circle-chat message — record my own side of the
    // thread (recipients append on decrypt; my echo is skipped there).
    if (!target) appendChat(c.id, { from: id.pk, text: r, at })
    if (!opts?.quiet) toast(target ? 'Buzzed' : 'Buzzed everyone')
  } catch { toast('Message failed. Check your connection.') }
  refresh()
}

/** Send the circle-chat composer's text (or a preset chip) to everyone. */
function chatSend(text: string): void {
  const t = text.trim()
  if (!t) { toast('Type a message first'); return }
  const input = document.getElementById('chat-input') as HTMLTextAreaElement | null
  if (input) input.value = ''
  void sendBuzz(t, undefined, { quiet: true }) // the message appearing in the thread IS the feedback
}

/** "Check in" — tell EVERY circle I'm OK, and ask them all to show where they
 *  are (a roll-call). Receivers answer on their own terms: an explicit tap, at
 *  their own detail, through the normal policy pipeline (see rollCallCard). */
async function doCheckIn(): Promise<void> {
  const id = persisted.identity
  if (!id) return
  let sent = 0
  for (const c of persisted.circles) {
    try {
      const at = nowSec()
      const tmpl = await buildBuzzSignal({ groupId: c.id, seedHex: c.seedHex, from: id.pk, reason: 'Check in', ask: 'location', timestamp: at })
      await publishSignal(tmpl, c)
      appendChat(c.id, { from: id.pk, text: 'Check in', at })
      sent++
    } catch { /* keep going — other circles may still be reachable */ }
  }
  // My own answer to my own roll-call: freshen my pin if I'm already sharing.
  const ac = activeCircle()
  if (sharing && ac) { beaconCadence.delete(ac.id); void autoEmit() }
  toast(sent === 0
    ? "Couldn't check in. Check your connection."
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
    await publishSignal(await buildBuzzSignal({ groupId: c.id, seedHex: c.seedHex, from: id.pk, reason: RING_REASON, target: pk }), c)
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
 *  Latest report wins on every device (see the lost signal's inner timestamp). */
async function sendLostReport(pk: string, lost: boolean): Promise<void> {
  const c = activeCircle()
  const id = persisted.identity
  if (!c || !id || !pk) return
  try {
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

// ── Messaging (free text: group buzz, or private 1:1 DM) ─────────────────────
/** Send a private direct message to ONE member — gift-wrapped to their personal
 *  inbox, never the shared circle inbox, so only they can read it. */
async function sendDm(pk: string, text: string): Promise<void> {
  const c = activeCircle()
  const signer = getSigner()
  const id = persisted.identity
  if (!c || !signer || !id) return
  const t = text.trim()
  if (!t) { toast('Type a message first'); return }
  if (pk === id.pk) { toast("That's you"); return }
  try {
    const wrap = await buildDmWrap(signer, pk, { circleId: c.id, text: t })
    await svc.publishSigned(activeRelays(), wrap as never)
    appendDm(pk, { from: id.pk, text: t, at: nowSec() }) // my side of the thread
  } catch { toast('Message failed — check your connection') }
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
  root.appendChild(el)
  el.querySelectorAll('[data-action]').forEach((node) => {
    const a = node.getAttribute('data-action') as string
    node.addEventListener('click', () => handleAction(a, node as HTMLElement))
  })
  el.addEventListener('click', (e) => { if (e.target === el) closeCircleMenu() }) // tap the dim backdrop to dismiss
}
/** The private-chat sheet: the whole 1:1 thread plus a composer — Signal's chat
 *  screen in miniature. The old one-shot compose sheet grew a memory. Presets
 *  here are the person-to-person asks — "Come to me" also shares your exact
 *  spot with just this person, so it asks first. */
function dmSheet(): string {
  if (!dmPeer) return ''
  const list = persisted.dms?.[dmPeer] ?? []
  const thread = list.slice(-CHAT_SHOWN).map((m, i, arr) => chatBubble(m, arr[i - 1])).join('')
    || `<div class="note chat-empty">No messages yet, it's just the two of you. Encrypted so only ${esc(nameFor(dmPeer))} can read it.</div>`
  const chip = (r: string): string => r === 'Come to me'
    ? `<button class="btn small${dmComeToMeArmed ? ' primary' : ''}" data-action="dm-come-to-me">${esc(r)}</button>`
    : `<button class="btn small" data-action="dm-preset" data-reason="${esc(r)}">${esc(r)}</button>`
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
      <div class="chip-row chat-presets">${DM_QUICK_ACTIONS.map(chip).join('')}</div>
      ${confirm}
      <div class="chat-composer">
        <textarea class="input" id="dm-input" rows="1" maxlength="500" placeholder="Message ${esc(nameFor(dmPeer))}…" autocapitalize="sentences"></textarea>
        <button class="btn small primary" data-action="dm-send">Send</button>
      </div>
      <div class="note">Private: encrypted so only they can read it. It stays out of the circle chat.</div>
    </div>
  </div>`
}
function mountDmSheet(opts?: { keepFocus?: boolean }): void {
  const prior = document.getElementById('dm-input') as HTMLTextAreaElement | null
  const keep = opts?.keepFocus ? prior?.value ?? '' : ''
  document.getElementById('dm-sheet')?.remove()
  if (!dmPeer) return
  const tmp = document.createElement('div')
  tmp.innerHTML = dmSheet()
  const el = tmp.firstElementChild as HTMLElement | null
  if (!el) return
  root.appendChild(el)
  el.querySelectorAll('[data-action]').forEach((node) => {
    const action = node.getAttribute('data-action') as string
    node.addEventListener('click', () => handleAction(action, node as HTMLElement))
  })
  const input = el.querySelector('#dm-input') as HTMLTextAreaElement | null
  if (input) { input.value = keep; input.focus() }
  scrollChatToEnd()
}
/** Send text to the open DM thread, then refresh it in place. Shared by the
 *  composer's Send button and the preset chips (Where are you? / Call me / On
 *  my way) — "Come to me" is the one exception, since it also shares location
 *  and asks first (see doDmComeToMe). */
function dmSendText(text: string): void {
  const pk = dmPeer
  const t = text.trim()
  if (!pk) return
  if (!t) { toast('Type a message first'); return }
  void sendDm(pk, t).then(() => { if (dmPeer === pk) mountDmSheet({ keepFocus: true }) })
}
/** Send whatever's in the DM composer. */
function dmSend(): void {
  const input = document.getElementById('dm-input') as HTMLTextAreaElement | null
  const t = input?.value ?? ''
  if (input) input.value = ''
  dmSendText(t)
}

/** A private direct message just arrived on my personal inbox. Surface it as the
 *  top banner (locked, "just you"), notify and buzz — but only from a member of a
 *  circle I'm actually in, so a stranger who scraped my npub can't spam or spoof a
 *  circle name at me. */
function onIncomingDm(dm: DirectMessage): void {
  const me = persisted.identity
  if (me && dm.from === me.pk) return // my own message echoed back — never notify myself
  const c = persisted.circles.find((x) => x.id === dm.circleId)
  if (!c || !(c.members ?? []).includes(dm.from)) return // not a fellow circle member — drop
  const isNew = appendDm(dm.from, { from: dm.from, text: dm.text, at: dm.at })
  // A relay replaying history (re-subscribe after a reconnect) repopulates the
  // thread silently — only a genuinely new, recent message rings.
  if (!isNew || nowSec() - dm.at > MSG_FRESH_SEC) { refresh(); return }
  if (dmPeer === dm.from && !document.hidden) {
    // Their thread is open in front of me — the message lands IN the sheet.
    markThreadRead(dmKeyOf(dm.from))
    mountDmSheet({ keepFocus: true })
    refresh()
    return
  }
  raiseBuzz({ from: dm.from, reason: dm.text, mine: true, circle: c.name, private: true })
  // Private 1:1 → its own conversation notification, headed by the sender and
  // updated in place per person (Signal-style), distinct from a circle thread.
  notifyIfHidden(dm.text, { kind: 'dm', title: nameFor(dm.from), group: `dm:${dm.from}`, sender: nameFor(dm.from) })
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
  const text = '📍 Shared their exact location'
  const isNew = appendDm(loc.from, { from: loc.from, text, at: loc.at, geohash: loc.geohash, precision: loc.precision })
  if (!isNew || nowSec() - loc.at > MSG_FRESH_SEC) { refresh(); return }
  if (dmPeer === loc.from && !document.hidden) {
    markThreadRead(dmKeyOf(loc.from))
    mountDmSheet({ keepFocus: true })
    refresh()
    return
  }
  raiseBuzz({ from: loc.from, reason: text, mine: true, circle: c.name, private: true })
  notifyIfHidden(text, { kind: 'dm', title: nameFor(loc.from), group: `dm:${loc.from}`, sender: nameFor(loc.from) })
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
  await sendDm(pk, 'Come to me')
  const fresh = await svc.currentPosition({ enableHighAccuracy: true, maximumAge: 5000, timeoutMs: 2500 })
  if (fresh) fix = fresh
  const use = fresh ?? fix
  const done = (msg: string): void => { toast(msg); mountDmSheet({ keepFocus: true }) }
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
    appendDm(pk, { from: id.pk, text: '📍 Shared your exact location', at: nowSec(), geohash, precision: plan.precision })
    done('Sent, your exact spot is on its way')
  } catch { done("Sent. Couldn't attach your spot.") }
}


function handleAction(action: string, node: HTMLElement): void {
  switch (action) {
    case 'tab': tab = (node.dataset.tab as typeof tab); render(); break
    case 'switch-circle': if (chipHeldGuard) { chipHeldGuard = false; break } switchCircle(node.dataset.id as string); break
    case 'add-circle': adding = true; onboardStep = 'intro'; render(); break
    case 'go-invite': tab = 'circle'; showInvite = true; render(); break
    case 'toggle-invite': showInvite = !showInvite; spokenCode = null; render(); break
    case 'toggle-share': sharing ? stopSharing() : startSharing(); break
    case 'geo-retry': geoIssue = null; sharing = false; startSharing(); break
    case 'festival-start': startFestival(Number(node.dataset.hours ?? '3')); break
    case 'festival-stop': stopFestival(); break
    case 'msg-member': openDmThread(node.dataset.pk ?? ''); break
    case 'strip-member': {
      const pk = node.dataset.pk ?? ''
      if (pk === persisted.identity?.pk) { tab = 'circle'; render() } else openDmThread(pk)
      break
    }
    case 'chat-send': chatSend((document.getElementById('chat-input') as HTMLTextAreaElement | null)?.value ?? ''); break
    case 'chat-preset': chatSend(node.dataset.reason ?? ''); break
    case 'check-in': void doCheckIn(); break
    case 'open-dm': openDmThread(node.dataset.pk ?? ''); break
    case 'dm-send': dmSend(); break
    case 'dm-close': closeDmThread(); break
    case 'battery-allow': batteryAsked = true; void import('../../native/stayReachable').then((m) => m.requestBatteryExemption()).catch(() => { /* older shell */ }); break
    case 'rollcall-share': void doRollCallShare(); break
    case 'rollcall-dismiss': locAsk = null; refresh(); break
    case 'toggle-settings': showSettings = !showSettings; render(); break
    case 'see-on-map': focusMemberPk = node.dataset.pk ?? null; tab = 'map'; render(); break
    case 'see-shared-location':
      focusGeohash = node.dataset.geohash ?? null
      dmPeer = null
      document.getElementById('dm-sheet')?.remove()
      tab = 'map'
      render()
      break
    case 'ask-lost': lostConfirmPk = node.dataset.pk ?? null; render(); break
    case 'cancel-lost': lostConfirmPk = null; render(); break
    case 'report-lost': void sendLostReport(node.dataset.pk ?? '', true); break
    case 'found-phone': void sendLostReport(node.dataset.pk ?? '', false); break
    case 'make-it-ring': void ringPhone(node.dataset.pk ?? ''); break
    case 'find-exact': void askFindPing(node.dataset.pk ?? ''); break
    case 'cancel-findping': cancelFindPing(); break
    case 'toggle-ping-consent': togglePingConsent(); break
    case 'dm-preset': dmSendText(node.dataset.reason ?? ''); break
    case 'dm-come-to-me': dmComeToMeArmed = !dmComeToMeArmed; mountDmSheet({ keepFocus: true }); break
    case 'dm-come-to-me-cancel': dmComeToMeArmed = false; mountDmSheet({ keepFocus: true }); break
    case 'dm-come-to-me-confirm': dmComeToMeArmed = false; void doDmComeToMe(dmPeer ?? ''); break
    case 'copy-invite': void copyInvite(); break
    case 'share-word-code': case 'new-word-code': void shareWordCode(); break
    case 'copy-word-code': void copyWordCode(); break
    case 'save-handle': saveHandle(); break
    case 'copy-npub': copyNpub(); break
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
  upsertCircle(store.createCircle(name, 'nightout', persisted.identity.pk, persisted.circleRootHex, expiresAt), true)
  onboardStep = 'intro'
  awaitingInvite = false
  adding = false
  ttlMode = 'ongoing'
  tab = 'circle' // land where inviting people is front-and-centre
  render()
}

/** Remote join: create an identity, show my npub, and wait for a gift-wrapped invite. */
function doJoinRemote(): void {
  persisted.identity ??= store.createIdentity()
  store.save(persisted)
  awaitingInvite = true
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
        // The one failure the user must fix by hand: keep the toggle honest
        // (sharing reverts) and explain HOW on a persistent card, not a toast.
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
// parity). Opt-in (`persisted.stayReachable`); NEVER runs without a real
// identity (a decoy/hidden or reset install has none), so its ongoing
// notification can't become a "fresh install" tell.
async function syncStayReachable(): Promise<void> {
  if (!isNativeShell()) return
  const want = !!persisted.stayReachable && !!persisted.identity
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
  void checkForUpdate()
  void refreshBatteryExempt()
  void refreshDndAccess()
  // Orbot may have been started/stopped while flock was backgrounded.
  void syncTor().then(() => render())
  // The app being open IS the read — clear delivered message notifications,
  // exactly as Signal does. Foreground-service notifications are immune.
  void import('../../native/notify').then((n) => n.clearDelivered()).catch(() => { /* shell only */ })
}

/** Flip the "stay reachable when closed" toggle: persist, start/stop the
 *  service, and — on enable — ask for the Doze battery exemption without which
 *  an aggressive OEM freezes the service overnight (parity would silently lapse). */
async function toggleStayReachable(): Promise<void> {
  persisted.stayReachable = !persisted.stayReachable
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

function onFix(f: svc.Fix): void {
  fix = f
  geoIssue = null // any successful fix clears the location-trouble card
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
  // Native shell: any persistent foreground-service notification (the location
  // watcher, the stay-reachable service) would be a tell on a "fresh install" —
  // await their teardown BEFORE sealing and reloading.
  await stopBgWatch()
  await stopStayReachable()
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

/** Full reset: sign out, wipe local state and every circle on this device. */
function resetDevice(): void {
  if (persisted.authMethod === 'signet') { try { void signetLogout() } catch { /* ignore */ } }
  signetSigner = null
  store.reset()
  store.disarmRest()
  void burnLock()
  stopWatch?.(); stopWatch = null
  void stopBgWatch() // native shell: the foreground service (and its notification) must not outlive the reset
  void stopStayReachable() // and the stay-reachable service likewise
  void import('../../native/ble').then((b) => b.stopBle()).catch(() => { /* not running */ }); bleActive = false // BLE radio must not outlive the reset
  stopAllSubs()
  stopInviteSub?.(); stopInviteSub = null
  inviteSubKey = ''
  if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = 0 }
  sharing = false
  awaitingInvite = false
  adding = false
  disbandConfirm = false
  resetConfirm = false
  removeConfirmPk = null
  lostConfirmPk = null
  dmComeToMeArmed = false
  dmPeer = null
  document.getElementById('dm-sheet')?.remove()
  closeCircleMenu()
  mapView?.destroy()
  mapView = null
  fix = null
  circleStates.clear()
  beaconCadence.clear()
  coverCadence.clear()
  meshBuffer = createMeshBuffer()
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

async function onSignalWrap(circleId: string, wrap: { pubkey: string; content: string; id?: string }, inboxSk: Uint8Array): Promise<void> {
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
  // other mesh frame, so it's also re-offered to later-arriving peers.
  if (bleActive && bleMode === 'mesh' && wrap.id && persisted.circles.some((x) => festivalActive(x))) {
    const id = wrap.id
    const frame = JSON.stringify({ id, pubkey: wrap.pubkey, content: wrap.content })
    meshBuffer = rememberMeshWrap(meshBuffer, { id, data: frame }, nowSec())
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
      if (!me || bz.from !== me.pk) {
        const mine = !!me && bz.target === me.pk
        // An untargeted buzz IS a circle-chat message — thread it. False = a
        // relay replay repopulating history; those must stay silent.
        const isNew = !bz.target ? appendChat(c.id, { from: bz.from, text: bz.reason, at: bz.timestamp }) : true
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
          raiseBuzz({ from: bz.from, reason: bz.reason, mine, circle: c.name })
          // The buzz banner is in-app only — with the screen off it must still
          // land as a system notification. With a sender attached this renders
          // as a Signal-style conversation per circle: title "Night out", lines
          // "Alex: Come to me", one notification updated in place.
          const buzzBody = bz.reason || `Buzzed${mine ? ' you' : ' the circle'}`
          notifyIfHidden(buzzBody, { kind: 'group', title: c.name, group: `group:${c.id}`, sender: nameFor(bz.from), conversation: c.name })
          try { navigator.vibrate?.(mine ? [300, 120, 300, 120, 300] : [200, 100, 200]) } catch { /* no haptics */ }
        }
      }
    } else if (t === LOST_SIGNAL_TYPE) {
      const rep = await decryptLost(c.seedHex, e.content)
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
