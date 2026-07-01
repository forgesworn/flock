# Fair meeting point + granular location precision

**Date:** 2026-07-01 · **Owner:** TBD · **Status:** Slices 1 & 2 **shipped**; Slice 3 (venues + granular precision) pending

## Why this exists

Phase F is half-built. **Set rendezvous** (`src/rendezvous.ts`) is the *when* —
someone names a place, each device computes its ETA/arrival and broadcasts a coarse
status. Missing is the *where*: **"some of us are in one bar, some in another, some
back at the hotel — where do we all go?"** That is `rendezvous-kit`'s `findRendezvous()`
run at the app edge (the comment in `src/rendezvous.ts` already says as much).

Two things make it more than a venue search:

1. People are **at venues** (hotels, bars) and want **venue suggestions** everyone can
   reach fairly — not a bare centroid in the middle of a road.
2. **Granular privacy.** I might share my **exact** spot with a close mate but only
   **neighbourhood** level with the wider group — a level I set for myself, and can
   override per individual.

## The make-or-keep privacy constraint

flock withholds location by default (FLOCK.md §6). Finding a meeting point needs
locations — so this is a **new, voluntary, opt-in disclosure**, and it must not become
a standing leak. Three rules the design holds to:

1. **Opt-in per request.** Nothing is contributed unless the member actively taps
   "share for this". Declining sends nothing and is observationally identical to sharing.
2. **On-device maths.** Reachability + fairness run **in-browser** over the locations
   that device already holds — member coordinates never leave the device for routing
   (see the on-device engine below).
3. **Venue search never sees who's where.** Only the *search-area polygon* goes out,
   and only via our **same-origin proxy** — or not at all (centroid fallback).

## The precision ladder (geohash-standard)

Precision is a **geohash character count** — flock's `policy.ts` already speaks this
(`coarse: 6`, `full: 9`). Exposed rungs, with standard geohash cell sizes:

| Level | Geohash chars | Cell (≈) | Typical use |
|---|:--:|---|---|
| **Off** | — | — | withheld (the default) |
| **Town** | 5 | 4.9 km | "I'm in this city" |
| **Neighbourhood** | 6 | 1.2 × 0.6 km | **group default** |
| **Street** | 7 | 153 m | a nearer circle |
| **Exact** | 9 | 4.8 m | a trusted individual |

- **Per-circle default** — the level shared with the *group* on opt-in (default
  **Neighbourhood**, geohash 6, which is exactly today's `policy.coarse`).
- **Per-person override** — share **finer** (up to Exact) with named individuals;
  stored on-device like petnames. Never silently coarser than the chosen default.

### How per-recipient precision rides the transport

flock signals go to the **shared group inbox** — everyone decrypts, so one message
cannot be coarse-for-some and fine-for-others. Per-recipient precision is therefore
**two sends**:

- a **coarse beacon to the group inbox** at the per-circle default (everyone sees
  neighbourhood), and
- a **targeted fine beacon** gift-wrapped to an individual's **`personalInboxTag`**
  (only they decrypt the exact position).

The targeted send reuses the personal-inbox tag shipped in `5991050` — the same
primitive that keeps invites off the wire now also carries "exact, but only to Bob".
The relay sees only opaque `kind:1059` wraps to a hashed tag; it learns neither the
recipient nor the precision.

## rendezvous-kit integration (`findRendezvous`)

- **Dependency:** `rendezvous-kit` (v1.21.x). Its only runtime dep is `geohash-kit`,
  already in flock; ESM. (It's a sibling repo — publish to npm or workspace-link it in.)
- **On-device engine (default, no third party).** Implement its `RoutingEngine`
  interface with a **radius isochrone** (`circleToPolygon(centre, speedKmh × minutes)`,
  exported from `rendezvous-kit/geo`) and a **haversine travel-time matrix**. Speeds
  mirror `src/rendezvous.ts`'s `SPEED_KMH` (walk 5 / cycle 15 / drive 30 / transit 20).
  Pure, offline, deterministic → **member locations never leave the device**. A real
  engine (Valhalla/ORS) slots behind the same seam later for road-accurate times, but is
  **opt-in — never a silent fallback to a third party**.
- **Call:** `findRendezvous(onDeviceEngine, { participants, mode, maxTimeMinutes,
  venueTypes, fairness })` → ranked `RendezvousSuggestion[]` (`venue {name,lat,lon,type}`,
  per-person `travelTimes`, `fairnessScore`).
- **Fairness:** default `min_max` (minimise the worst-off person's travel); offer
  `min_total` / `min_variance` as a toggle.
- **Venues:** `searchVenues(polygon, venueTypes, overpassUrl)` pointed at a same-origin
  **`/overpass` proxy** (Caddy `handle_path`, client headers stripped — mirrors the
  shipped tiles/Nominatim proxy). The kit sends only the polygon, never participants.
  Venue types for this context: `pub`, `bar`, `cafe`, `restaurant`, `fast_food`. Start
  **centroid-first** (empty `venueTypes` → the kit returns the fair centre) and add
  venues once the proxy is up.

## The flow

1. **Propose** (any member): "Find where we should meet" → pick venue types, transport
   mode, time budget. Broadcasts a **meeting-point request** (new encrypted signal).
2. **Contribute** (each member, opt-in): a prompt — "share your spot to help pick a
   place?" — sends a **coarse location beacon** at their per-circle default (plus any
   per-person exact overrides). Declining sends nothing.
3. **Compute** (proposer's device): `findRendezvous` over the coarse locations received
   → ranked suggestions.
4. **Show:** suggestion cards (venue, each person's ETA, fairness) + **map pins** —
   members at their disclosed precision (exact = dot, coarse = cell blob), venues as markers.
5. **Pick → set:** choosing a suggestion creates a **set-rendezvous** via the existing
   encrypted `buildRendezvousSignal` — the half already built.

## Protocol additions

All gift-wrapped `kind:1059` (the relay sees opaque wraps to the rotating inbox /
personal tags):

- `meeting-request` (`t=mtg-req`) → group inbox: venue types / mode / time budget.
- `meeting-share` (`t=mtg-loc`) → group inbox: a member's **coarse** location + transport
  mode, opt-in; **plus** optional **targeted exact** beacons to `personalInboxTag(individual)`.
- Result reuses the existing `rzv` set-rendezvous signal.

## Phasing (build in slices)

- ✅ **Slice 1 — engine core (pure, no UI/privacy surface).** Added the dep; implemented
  the on-device `RoutingEngine` + `suggestMeetingPoint` in `app/src/meetingPoint.ts`
  (centroid-first, +6 unit tests). We compose rendezvous-kit's geo primitives ourselves
  rather than calling its `findRendezvous` — that always hits public Overpass, an
  un-injectable third-party leak. Deliverable met: N coarse points → a ranked fair point.
- ✅ **Slice 2 — the flow, single precision.** `mtg-req` + opt-in `mtg-loc` signals
  (`src/meeting.ts`, +6 unit tests); the proposer's device computes + shows a suggestion
  card; pick → set-rendezvous. Two-person **e2e** (`e2e/meeting.spec.ts`). Neighbourhood
  (geohash-6) default only. `mtg-loc` carries an **already-encoded coarse geohash** (not
  raw lat/lon), keeping coordinates out of the library and the coarsening at the edge.
- **Slice 3 — granular precision + map pins + venues.** Per-circle default + per-person
  override + targeted exact beacons; map pins at disclosed precision; the Overpass proxy +
  venue types + fairness toggle.

## Privacy invariants / non-goals

- Withhold-by-default holds: opting out sends nothing and is indistinguishable from sharing.
- On-device routing is the **default and only** path unless the user explicitly enables an
  external engine.
- Overpass sees a search polygon via our proxy — never member coordinates or IPs (the kit
  never sends participants to a venue API).
- Exact precision reaches **only** explicitly named individuals, via their personal-inbox tag.
- Not doing (v1): continuous real-time tracking (this is a one-shot, opt-in contribution);
  road-accurate ETAs (as-the-crow-flies, like the existing rendezvous ETA).

## Open questions

- Publish `rendezvous-kit` to npm, or workspace-link it into flock for now?
- Default time budget + mode for a night-out context (e.g. 30 min, walk)?
- Should a `meeting-request` auto-expire (NIP-40) like transient circles?
- Do coarse contributions reuse the existing beacon signal, or is `mtg-loc` cleaner?
