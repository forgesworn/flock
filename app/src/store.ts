// Local state: identity, circle, persistence. With the app lock OFF,
// localStorage holds plaintext (flagged in the UI); with it ON, the blob is
// AES-256-GCM ciphertext at rest — see the rest-encryption layer below and
// docs/plans/2026-07-02-app-lock.md.

import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { encryptEnvelope, decryptEnvelope } from 'canary-kit/sync'
import { decode as nip19decode } from 'nostr-tools/nip19'
import {
  coordinationActionFromLabel,
  isDirectCoordinationAction,
  isGroupCoordinationAction,
  type CoordinationAction,
  type Geofence,
  type NoReportZone,
  type MemberBeacon,
} from '@forgesworn/flock'
import { resolveRelays } from './relays'
import { deriveCircleSeed } from '@forgesworn/covey-kit'
import type { Pin } from './pin'

export type Mode = 'family' | 'nightout'
/** A local identity has `skHex`; a Signet identity is `pk`-only (key in the signer). */
export interface Identity { skHex?: string; pk: string }
export type AuthMethod = 'local' | 'signet'
export interface Circle {
  id: string
  seedHex: string
  name: string
  mode: Mode
  /** Known member pubkeys (hex), including self. */
  members?: string[]
  /** Member pubkeys evicted from this circle (hex). A durable tombstone: a reseed
   *  carries it (payload `r`) so every device drops them and never re-wraps the
   *  rotated seed back to them, and `withNewMember` refuses to silently re-add
   *  them. Cleared for a pubkey only by an explicit re-invite (on this device). */
  removed?: string[]
  /** Dead-man's-switch cadence in seconds; 0/undefined = disarmed. */
  checkinInterval?: number
  /** nsec-tree derivation epoch; reseed = epoch + 1 (creator-side). */
  epoch?: number
  /** Transient lifetime (unix sec, NIP-40 style). Undefined = long-lived (e.g. family). */
  expiresAt?: number
  /** This circle's safe places. Per-circle (synced to the circle — see fences sync). */
  geofences?: Geofence[]
  /** Latest-wins clock for the synced fence set (unix sec of the last applied edit). */
  fencesUpdatedAt?: number
  /** Who made that edit (pubkey hex) — the deterministic tie-break for equal clocks. */
  fencesBy?: string
  /** Roster additions not yet acknowledged — drives the "new phone joined" notice. */
  unseenMembers?: string[]
  /** When THIS device joined (unix sec) — see JOIN_GRACE_SEC. Unset for circles we created. */
  joinedAt?: number
  /** When the current seed was adopted (unix sec) — drives automatic rotation
   *  (rotation.ts). Stamped on create/join/reseed; migrated to "now" for
   *  circles that predate rotation. */
  reseededAt?: number
  /** Device-local: when this device last re-wrapped the current seed for
   *  offline members (rotation.ts refreshDue). Never synced. */
  seedRefreshedAt?: number
  /** Geohash precision (4–9) my own beacons are shared at in this circle —
   *  the "location detail" slider. Undefined = 6 (~neighbourhood). */
  sharePrecision?: number
  /** Device-local default location posture, chosen at create/join:
   *  `'always'` = share continuously while sharing is on (live tracking);
   *  `'private'` = disclosure-on-event only — never a continuous beacon; my
   *  location goes out only when I check in, answer a roll-call, or send an
   *  explicit share. Undefined = `'always'` (preserves pre-feature behaviour).
   *  Never synced — each member picks their own posture for this circle. */
  trackingDefault?: 'always' | 'private'
  /** "Find each other" (festival mode): while set and in the future, MY own beacons
   *  step up to building-level detail so the circle can walk to me in a crowd. A
   *  deliberate, temporary, device-local choice — auto-reverts to the slider at this
   *  unix-sec deadline. Never synced; each member opts in for themselves. */
  festivalUntil?: number
  /** Device-local standing consent: if my phone is lost, THIS circle may ask it
   *  for a one-shot exact location ("find my phone"). Off by default, never
   *  synced (the invite/reseed wire builders pick explicit fields), so it is my
   *  own setting on my own phone — the origin that makes a remotely-triggered
   *  disclosure legitimate. See docs/plans/2026-07-04-remote-exact-ping.md. */
  pingConsent?: boolean
  /** Device-local display order for the Home member strip (pubkeys, my own
   *  preference — never synced, never affects the wire). Members not listed
   *  here (new joiners, or a fresh install) fall in after it in their natural
   *  order — see `orderedMembers`. */
  memberOrder?: string[]
}

/** The circle's members in display order: `order` first (dropping anyone who's
 *  left), then anyone not in it yet (new joiners, or no order set at all) in
 *  their natural order. Pure — the actual persisted order lives on the circle;
 *  this just resolves "what to show" from it. */
export function orderedMembers(members: string[], order?: string[]): string[] {
  if (!order?.length) return members
  const known = new Set(members)
  const ranked = order.filter((pk) => known.has(pk))
  const rankedSet = new Set(ranked)
  return [...ranked, ...members.filter((pk) => !rankedSet.has(pk))]
}

/** Right after we join, relay replay delivers the existing members' history —
 *  discovering THEM is not news to us. Additions within this window of joinedAt
 *  are adopted silently. It only blinds the freshly joined device: every member
 *  that already held the roster still notices anyone who joins during it. */
export const JOIN_GRACE_SEC = 10 * 60

/** Roster addition with join-notice semantics: returns the circle patch for a
 *  genuinely new member, or null when already known — a reseed re-add or a
 *  signal echo must NOT re-fire the notice. `expected` adds silently (your own
 *  key, or an invite you sent yourself). */
export function withNewMember(c: Circle, pk: string, now: number, opts?: { expected?: boolean }): Partial<Circle> | null {
  const m = c.members ?? []
  if (m.includes(pk)) return null
  // An evicted member must never be silently re-added — otherwise a rotated seed
  // that reaches them (via a stale-roster refresh elsewhere) would quietly
  // reinstate them. An explicit re-invite clears the tombstone first (sendInvite).
  if ((c.removed ?? []).includes(pk)) return null
  const inJoinGrace = c.joinedAt !== undefined && now - c.joinedAt < JOIN_GRACE_SEC
  const patch: Partial<Circle> = { members: [...m, pk] }
  if (!opts?.expected && !inJoinGrace) patch.unseenMembers = [...(c.unseenMembers ?? []), pk]
  return patch
}
export interface Persisted {
  identity: Identity | null
  /** All circles this person belongs to (family, a trip, a night out…) — many at once. */
  circles: Circle[]
  /** Which circle is in focus. */
  activeCircleId: string | null
  /** Relays sensitive traffic is fanned out to (delivery redundancy). Non-empty. */
  relayUrls: string[]
  /** Inverse geofences — inside one, disclosure is capped even on a trigger. On-device
   *  only, and deliberately device-global: a private place (home) is YOURS, applies in
   *  every circle, and is never synced — unlike per-circle safe places. */
  noReportZones: NoReportZone[]
  /** Unix sec my deliberate darkness ends; undefined/elapsed = on grid. */
  offGridUntil?: number
  /** Local, private nicknames for members (pubkey → name). Never leaves the device. */
  petnames: Record<string, string>
  /** My self-chosen handle, announced INSIDE encrypted joined signals so circle
   *  members can recognise me — the relay never sees it. Optional; a pseudonym
   *  is fine (recognition, not identity). */
  myHandle?: string
  /** Handles members announced for THEMSELVES (pubkey → handle). A suggestion
   *  only: your own petnames always win, and the "new phone joined" notice
   *  remains the check that a handle isn't impersonating someone. */
  handles?: Record<string, string>
  /** Cached member beacons per circle (id → beacons) so map pins survive a refresh
   *  or a PWA relaunch. A convenience cache only — pruned by age + circle existence
   *  on load; live beacons always overwrite. On-device only, like everything here. */
  presence: Record<string, MemberBeacon[]>
  /** Dropped pins per circle (id → pins) — a member's car, a picnic spot… A
   *  local cache of the ephemeral pin signals so they survive a refresh; pruned
   *  by circle existence on load. On-device only, like presence. */
  pins?: Record<string, Pin[]>
  /** Opt-in: fetch public kind:0 profiles (names/avatars) from public relays. Default off. */
  showProfiles?: boolean
  /** How distances read across the app (location-detail sizes etc.). Undefined = metric.
   *  Device-local display preference, like showProfiles — not synced, not backed up. */
  units?: 'metric' | 'imperial'
  /** Native shell only: keep a foreground service alive so messages/alerts arrive
   *  while flock is closed (Signal-parity notifications). Off by default — a
   *  persistent notification + always-on battery is opt-in, and it must never run
   *  on a fresh or decoy install. Device-local, not synced, not backed up. */
  stayReachable?: boolean
  /** Native shell only, opt-in, off by default: exchange signals phone-to-phone
   *  over Bluetooth LE with co-located circle members (off-relay). Strictly
   *  additive — the relay path never depends on it. Device-local, not synced. */
  bleNearby?: boolean
  /** Opt-in, off by default: route relay traffic through Tor (Orbot) when a
   *  `.onion` relay is configured and Orbot is reachable. Native-shell-only in
   *  practice (a PWA can't reach Orbot's SOCKS proxy); fails loud rather than
   *  silently using clearnet when the route isn't ready (see relays.ts).
   *  Device-local, not synced — mirrors bleNearby/stayReachable. */
  torRelay?: boolean
  /** How the identity authenticates: a local key, or a Signet/bunker signer. */
  authMethod?: AuthMethod
  /** Local secret from which circle seeds are deterministically derived (nsec-tree). */
  circleRootHex?: string
  /** Helper hints: a master switch + per-hint dismissals. Absent = off. */
  hints?: Hints
  /** "Hide flock" (decoy view) — present = armed. The phrase-derived sealing
   *  key + its salt, computed once at enable time so the hide itself is
   *  instant. Lives inside the very blob it seals, so unhiding restores the
   *  protection still armed. See docs/plans/2026-07-02-decoy-view.md. */
  decoy?: { salt: string; key: string }
  /** App lock (key-at-rest) — present = armed. The random storage secret that
   *  encrypts this blob at rest; kept inside the blob it encrypts (free — you
   *  can't read it without having decrypted) so a decoy unhide can re-lock.
   *  Device-specific: excluded from backups, like the relay list. */
  lock?: { secret: string }
  /** Circle signal history (circle id → actions, oldest first). On-device only —
   *  the wire carries each action once, encrypted; this is the local activity log.
   *  Pruned with its circle; capped per thread.
   *  Plaintext at rest unless the App lock is on (same story as everything here). */
  chats?: Record<string, ChatMessage[]>
  /** Private 1:1 threads (peer pubkey → messages, oldest first). Same rules. */
  dms?: Record<string, ChatMessage[]>
  /** Last-read unix sec per thread ('c:<circleId>' | 'd:<peerPk>') — unread badges. */
  chatReadAt?: Record<string, number>
}

/** Helper-hint state: small "what & why" explanations shown while learning the
 *  app, each dismissible, all silencable from settings once comfortable. */
export interface Hints { on: boolean; dismissed: string[] }

// ── Signal history (circle + private 1:1 actions) ────────────────────────────
export type ChatAction = CoordinationAction | 'shared_exact_location'

/** One action in a thread. `from` is the sender's pubkey; `at` unix seconds
 *  (the rumor's own timestamp, so a relay replay carries the identical triple).
 *  `geohash`/`precision` are present only for a private "Come to me" location
 *  share. Labels are rendered locally; persisted history cannot hold prose. */
export interface ChatMessage { from: string; action: ChatAction; at: number; geohash?: string; precision?: number }

/** Cap per thread — a safety app's chat is a running conversation, not an archive. */
export const CHAT_MAX_PER_THREAD = 200

/**
 * Append an action to a thread, deduplicating relay replays: gift wraps are
 * replayed on every fresh subscribe, and the SAME rumor decrypts to the same
 * (from, at, action) triple — an exact match is an echo, not a new action.
 * Returns null when nothing changed (echo), else a fresh capped list kept in
 * `at` order so a delayed relay delivery still lands where it belongs.
 */
export function withChatMessage(list: ChatMessage[] | undefined, msg: ChatMessage, max = CHAT_MAX_PER_THREAD): ChatMessage[] | null {
  const cur = list ?? []
  if (cur.some((m) => m.at === msg.at && m.from === msg.from && m.action === msg.action)) return null
  const next = [...cur, msg].sort((a, b) => a.at - b.at)
  return next.length > max ? next.slice(next.length - max) : next
}

const HEX_64_RE = /^[0-9a-f]{64}$/
const LEGACY_LOCATION_MARKERS = new Set(['📍 Shared their exact location', '📍 Shared your exact location'])

function storedAction(value: Record<string, unknown>): ChatAction | null {
  if (typeof value.action === 'string') {
    if (value.action === 'shared_exact_location') return value.action
    const action = value.action as CoordinationAction
    if (isGroupCoordinationAction(action) || isDirectCoordinationAction(action)) return action
    return null
  }
  if (LEGACY_LOCATION_MARKERS.has(value.text as string)) return 'shared_exact_location'
  return coordinationActionFromLabel(value.text)
}

function migrateStoredMessage(value: unknown, scope: 'group' | 'direct'): ChatMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const o = value as Record<string, unknown>
  if (typeof o.from !== 'string' || !HEX_64_RE.test(o.from)) return null
  if (typeof o.at !== 'number' || !Number.isFinite(o.at)) return null
  const action = storedAction(o)
  if (action === null) return null
  if (scope === 'group' && !isGroupCoordinationAction(action)) return null
  if (scope === 'direct' && action !== 'shared_exact_location' && !isDirectCoordinationAction(action)) return null

  if (action === 'shared_exact_location') {
    if (typeof o.geohash !== 'string' || !o.geohash || typeof o.precision !== 'number' || !Number.isInteger(o.precision)) return null
    return { from: o.from, action, at: o.at, geohash: o.geohash, precision: o.precision }
  }
  return { from: o.from, action, at: o.at }
}

function migrateStoredThread(list: readonly unknown[], scope: 'group' | 'direct'): ChatMessage[] {
  const migrated = list.flatMap((item) => {
    const message = migrateStoredMessage(item, scope)
    return message ? [message] : []
  }).sort((a, b) => a.at - b.at)
  return migrated.length > CHAT_MAX_PER_THREAD ? migrated.slice(-CHAT_MAX_PER_THREAD) : migrated
}

/** Keep only group threads whose circle still exists — leaving/disbanding a
 *  circle must take its conversation with it. Pure; returns a fresh object. */
export function pruneChats(chats: Record<string, readonly unknown[]> | undefined, circleIds: string[]): Record<string, ChatMessage[]> {
  const live = new Set(circleIds)
  const out: Record<string, ChatMessage[]> = {}
  for (const [cid, list] of Object.entries(chats ?? {})) {
    if (!live.has(cid)) continue
    const migrated = migrateStoredThread(list, 'group')
    if (migrated.length) out[cid] = migrated
  }
  return out
}

/** Keep only 1:1 threads with people still in at least one of my circles —
 *  when the last shared circle goes, so does the thread (ephemerality is the
 *  point; nothing here should outlive the relationship that produced it). */
export function pruneDms(dms: Record<string, readonly unknown[]> | undefined, knownPks: Iterable<string>): Record<string, ChatMessage[]> {
  const known = new Set(knownPks)
  const out: Record<string, ChatMessage[]> = {}
  for (const [pk, list] of Object.entries(dms ?? {})) {
    if (!known.has(pk)) continue
    const migrated = migrateStoredThread(list, 'direct')
    if (migrated.length) out[pk] = migrated
  }
  return out
}

/** Should this hint render? Fresh devices (undefined state) show NOTHING —
 *  the screen should read as intuitive on its own; a new user opts in to the
 *  explanations under You rather than being shown them unasked. */
export function hintShown(h: Hints | undefined, id: string): boolean {
  const hints = h ?? { on: false, dismissed: [] }
  return hints.on && !hints.dismissed.includes(id)
}

/** Dismiss one hint (idempotent); the master switch is untouched. */
export function withHintDismissed(h: Hints | undefined, id: string): Hints {
  const hints = h ?? { on: false, dismissed: [] }
  return hints.dismissed.includes(id) ? hints : { ...hints, dismissed: [...hints.dismissed, id] }
}

const KEY = 'flock:v1'

/** Cached presence beacons older than this are dropped on load — a pin from hours
 *  ago is noise, not safety info. Generous enough to survive an evening of refreshes
 *  (a night-out circle), tight enough not to resurrect yesterday's positions. */
export const PRESENCE_MAX_AGE_SEC = 6 * 60 * 60

/**
 * Keep only cached beacons that are recent enough AND belong to a circle that still
 * exists — never resurrect an ancient pin, or leak presence from a circle you've
 * left / disbanded / reseeded. Pure; returns a fresh object.
 */
export function prunePresence(
  presence: Record<string, MemberBeacon[]>,
  circleIds: string[],
  now: number,
  maxAgeSec: number,
): Record<string, MemberBeacon[]> {
  const live = new Set(circleIds)
  const out: Record<string, MemberBeacon[]> = {}
  for (const [cid, list] of Object.entries(presence)) {
    if (!live.has(cid)) continue
    const kept = list.filter((b) => now - b.timestamp <= maxAgeSec)
    if (kept.length) out[cid] = kept
  }
  return out
}

/**
 * Migrate legacy device-global safe places into any circle without its own set.
 * Pure. The old device-global list applied to every family circle on this device,
 * so a per-circle copy preserves breach behaviour exactly; night-out circles never
 * evaluate fences, so a copy there is harmless (and keeps the data if the mode's
 * circle is the only one left).
 */
export function adoptLegacyFences(circles: Circle[], legacy?: Geofence[]): Circle[] {
  if (!legacy?.length) return circles
  return circles.map((c) => (c.geofences ? c : { ...c, geofences: [...legacy] }))
}

/** Missing legacy consent must fail closed. Existing explicit choices remain
 *  authoritative, including a deliberate opt-in made on this device. */
export function withPingConsentDefault(circles: Circle[]): Circle[] {
  return circles.map((c) => (c.pingConsent === undefined ? { ...c, pingConsent: false } : c))
}

const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
export const fromHex = (h: string): Uint8Array =>
  Uint8Array.from(h.match(/.{1,2}/g) ?? [], (x) => parseInt(x, 16))
const randHex = (n: number): string => toHex(crypto.getRandomValues(new Uint8Array(n)))

export function load(): Persisted {
  const fresh: Persisted = { identity: null, circles: [], activeCircleId: null, relayUrls: resolveRelays(), noReportZones: [], petnames: {}, presence: {} }
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return fresh
    const o = JSON.parse(raw) as Partial<Persisted> & { locked?: number }
    // Locked at rest: ciphertext must never partially hydrate. The boot flow
    // detects this via lockedAtRest() and goes through openRest() instead.
    if (o.locked === 1) return fresh
    return hydrate(o, fresh)
  } catch { /* ignore corrupt state */ }
  return fresh
}

/** Migrations + pruning over a parsed state — shared by load() and openRest(). */
function hydrate(o: Partial<Persisted> & { circle?: Circle | null; relayUrl?: string; geofences?: Geofence[] }, fresh: Persisted): Persisted {
  const state: Persisted = { ...fresh, ...o, circles: o.circles ?? [], noReportZones: o.noReportZones ?? [], petnames: o.petnames ?? {}, relayUrls: resolveRelays(o) }
  // Migrate the legacy single-relay field into the fanned-out list (resolveRelays did the work).
  delete (state as unknown as Record<string, unknown>).relayUrl
  // Migrate the legacy single-circle shape.
  if (o.circle && !state.circles.length) {
    state.circles = [o.circle]
    state.activeCircleId = o.circle.id
  }
  delete (state as unknown as Record<string, unknown>).circle
  // Drop expired transient circles, then keep the active id valid.
  const now = Math.floor(Date.now() / 1000)
  state.circles = state.circles.filter((c) => !c.expiresAt || c.expiresAt > now)
  // Migrate legacy device-global safe places into each circle.
  state.circles = adoptLegacyFences(state.circles, o.geofences)
  delete (state as unknown as Record<string, unknown>).geofences
  // Rotation migration: circles from before automatic seed rotation have no
  // seed age — start their clock now rather than mass-rotating on upgrade day.
  state.circles = state.circles.map((c) => (c.reseededAt ? c : { ...c, reseededAt: now }))
  state.circles = withPingConsentDefault(state.circles)
  if (!state.circles.some((c) => c.id === state.activeCircleId)) {
    state.activeCircleId = state.circles[0]?.id ?? null
  }
  // Rehydrate cached presence, but drop ancient pins and any circle we've since left.
  state.presence = prunePresence(o.presence ?? {}, state.circles.map((c) => c.id), now, PRESENCE_MAX_AGE_SEC)
  // Chat threads follow their circle / their person — an expired night-out
  // takes its conversation with it, and a 1:1 with someone no longer in any
  // circle doesn't linger on disk.
  state.chats = pruneChats(o.chats, state.circles.map((c) => c.id))
  const knownPks = new Set<string>()
  for (const c of state.circles) for (const pk of c.members ?? []) knownPks.add(pk)
  state.dms = pruneDms(o.dms, knownPks)
  return state
}

/** Once hiding starts, nothing may write the real state back — a queued signal
 *  handler saving between the wipe and the reload would resurrect what the
 *  decoy exists to hide. One-way; the reload clears it. */
let saveLocked = false
export function lockSaves(): void { saveLocked = true }

// ── At-rest encryption (the app lock — docs/plans/2026-07-02-app-lock.md) ────
// save() stays synchronous (it is called everywhere); with a key armed, the
// serialised state goes through a coalescing encrypt-then-write drain instead.
let restKey: Uint8Array | null = null
let pendingJson: string | null = null
let drainPromise: Promise<void> | null = null

/** Arm at-rest encryption — every subsequent save writes ciphertext. */
export function armRest(secretHex: string): void { restKey = fromHex(secretHex) }

/** Disarm without touching the blob (tests; hide/reset paths). */
export function disarmRest(): void { restKey = null; pendingJson = null }

/** Is a rest key armed this session? (Distinguishes a normal unlocked boot
 *  from the plaintext-after-unhide state that needs the PIN re-confirmed.) */
export function restArmed(): boolean { return restKey !== null }

/** Is the persisted blob ciphertext right now? */
export function lockedAtRest(): boolean {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return false
    return (JSON.parse(raw) as { locked?: number }).locked === 1
  } catch { return false }
}

export function save(state: Persisted): void {
  if (saveLocked) return
  if (restKey) {
    pendingJson = JSON.stringify(state)
    drainPromise = drainPromise ?? drainRest()
    return
  }
  // SAFETY: with no key armed, a stray save while the blob is ciphertext must
  // never clobber it with fresh plaintext — that would destroy the protected
  // state. Unlock (openRest + armRest) or sealOff are the only ways past this.
  if (lockedAtRest()) return
  localStorage.setItem(KEY, JSON.stringify(state))
}

async function drainRest(): Promise<void> {
  try {
    while (pendingJson) {
      const json = pendingJson
      pendingJson = null
      const key = restKey
      if (!key) return
      const d = await encryptEnvelope(key, json)
      // Re-check the kill switches after the await — a hide or a disable that
      // raced the encryption must win; resurrecting state here would leak.
      if (saveLocked || !restKey) return
      localStorage.setItem(KEY, JSON.stringify({ locked: 1, d }))
    }
  } finally { drainPromise = null }
}

/** Await any queued encrypted write (tests; belt-and-braces before a reload). */
export async function flushRest(): Promise<void> { await drainPromise }

/** Decrypt the at-rest blob with the storage secret and hydrate it exactly
 *  like load(). Throws on a wrong secret or a blob that is not locked. */
export async function openRest(secretHex: string): Promise<Persisted> {
  const fresh: Persisted = { identity: null, circles: [], activeCircleId: null, relayUrls: resolveRelays(), noReportZones: [], petnames: {}, presence: {} }
  const raw = localStorage.getItem(KEY)
  const o = JSON.parse(raw ?? '{}') as { locked?: number; d?: string }
  if (o.locked !== 1 || typeof o.d !== 'string') throw new Error('not locked')
  const json = await decryptEnvelope(fromHex(secretHex), o.d)
  return hydrate(JSON.parse(json) as Partial<Persisted>, fresh)
}

/** Deliberately rewrite the blob as plaintext — turning the lock off. The one
 *  sanctioned way to go from ciphertext back to plaintext at rest. */
export function sealOff(state: Persisted): void {
  restKey = null
  pendingJson = null
  localStorage.setItem(KEY, JSON.stringify(state))
}

export function reset(): void {
  localStorage.removeItem(KEY)
}

/** Replace the persisted blob verbatim — the unhide path, restoring exactly
 *  the JSON that was sealed (AES-GCM already authenticated it). */
export function restoreRaw(json: string): void {
  localStorage.setItem(KEY, json)
}

export function createIdentity(): Identity {
  const sk = generateSecretKey()
  return { skHex: toHex(sk), pk: getPublicKey(sk) }
}

export function createCircle(
  name: string,
  mode: Mode,
  ownerPk: string,
  circleRootHex: string,
  expiresAt?: number,
  prefs?: { trackingDefault?: 'always' | 'private'; sharePrecision?: number },
): Circle {
  const id = randHex(8)
  return {
    id,
    seedHex: deriveCircleSeed(circleRootHex, id, 0),
    name: name.trim() || 'My circle',
    mode,
    members: [ownerPk],
    checkinInterval: 0,
    epoch: 0,
    reseededAt: Math.floor(Date.now() / 1000),
    pingConsent: false,
    ...(expiresAt ? { expiresAt } : {}),
    ...(prefs?.trackingDefault ? { trackingDefault: prefs.trackingDefault } : {}),
    ...(prefs?.sharePrecision ? { sharePrecision: prefs.sharePrecision } : {}),
  }
}

/** A fresh 32-byte group seed (hex) — used when reseeding. */
export function newSeed(): string {
  return randHex(32)
}

/** Decode an npub to a 64-char hex pubkey. Throws if not a valid npub. */
export function npubToHex(npub: string): string {
  const d = nip19decode(npub.trim())
  if (d.type !== 'npub' || typeof d.data !== 'string') throw new Error('That does not look like an invite key')
  return d.data
}

const b64encode = (s: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(s)))
const b64decode = (s: string): string => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)))

export function encodeInvite(c: Circle): string {
  return b64encode(JSON.stringify({ v: 1, id: c.id, s: c.seedHex, n: c.name, m: c.mode, ...(c.expiresAt ? { x: c.expiresAt } : {}) }))
}

/** A tappable/scannable join link. The code (which carries the SEED) travels in
 *  the URL FRAGMENT — a fragment is never sent to any server, so neither the
 *  host nor a CDN in front of it ever sees the secret. Camera apps OPEN a link;
 *  bare text they offer to web-search, which would hand the seed to a search
 *  engine. The app scrubs the fragment from the address bar on load. */
export function inviteLink(c: Circle, origin: string): string {
  return `${origin}/#join=${encodeInvite(c)}`
}

/** The invite code from pasted text: a bare code, or a full join link. */
export function inviteCodeFrom(text: string): string {
  const m = text.match(/#join=([^&\s]+)/)
  return m ? m[1] : text.trim()
}

export function decodeInvite(code: string): Circle {
  // A blank field or a mangled paste must surface the friendly message below, not
  // a raw "Unexpected end of JSON input" from the parser — so guard the empty
  // case and treat any base64/JSON failure as an invalid code.
  const trimmed = code.trim()
  let o: { v?: unknown; s?: unknown; id?: unknown; n?: unknown; m?: unknown; x?: unknown }
  try {
    if (!trimmed) throw new Error('empty')
    o = JSON.parse(b64decode(trimmed))
  } catch {
    throw new Error('That invite code is not valid.')
  }
  if (o.v !== 1 || typeof o.s !== 'string' || o.s.length !== 64 || typeof o.id !== 'string') {
    throw new Error('That invite code is not valid.')
  }
  return {
    id: o.id,
    seedHex: o.s,
    name: typeof o.n === 'string' && o.n ? o.n : 'Circle',
    mode: o.m === 'nightout' ? 'nightout' : 'family',
    ...(typeof o.x === 'number' ? { expiresAt: o.x } : {}),
  }
}
