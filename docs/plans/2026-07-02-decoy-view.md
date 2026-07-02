# Decoy view — "hide flock" under a compelled unlock

Phase J item 4 (competitive audit, 2026-07-02). If a coercer compels an unlock,
flock itself is evidence: circles, members, safe places, past alerts, a trail.
The decoy view lets the owner make flock look — and behave — like a freshly
installed app, and come back with a phrase, leaving nothing for a coercer to
find at the application layer.

## Decisions

### Decoy over wipe

GrapheneOS's duress PIN wipes; flock deliberately does not. A destructive wipe
under legal compulsion risks obstruction liability (destroying evidence under a
legal hold); a decoy view destroys nothing — the data is intact, encrypted,
recoverable by its owner. This was decided in the roadmap when the item was
raised and holds here.

### Encrypt-on-hide, not hide-the-UI

A decoy that merely renders a fake screen leaves the real state in plaintext
one devtools tab away. Hiding instead **encrypts the entire persisted state**
(`flock:v1`) under the owner's unlock phrase into a single opaque blob at
`flock:cache`, removes `flock:v1`, and reloads. The machinery is exactly the
backup path's (PBKDF2-SHA256 600k → canary-kit AES-256-GCM envelope — no new
crypto); the blob has no magic string, no version marker, nothing that
announces "encrypted flock state lives here".

The phrase-derived key is computed **once at enable time** and kept in state,
so the hide itself is instant — the moment a coercer approaches is not the
moment to spend a second on a KDF.

### The decoy is a real app, not a mock

After hiding, flock boots as a genuinely fresh install — because it *is* one:
no identity, no circles, no subscriptions, no geolocation watch. A coercer can
create a circle, invite someone, share — everything works, indistinguishable
from a first run (privacy invariant #1 applied to the app itself). Because no
subscription exists, signals arriving while hidden render nothing.

### Exit through the restore screen — zero new affordance

There is no hidden button, gesture, or input in the decoy. The exit is the
**existing "Restore from backup" screen**: type anything as the code and the
unlock phrase as the passphrase. If the phrase decrypts `flock:cache`, the
real state is restored and the app reboots. Every failure produces the
*genuine* restore-screen error, and the failure path does **constant work** —
when no hidden state exists, a dummy PBKDF2 run of the same cost fills the
gap — so a probing coercer cannot distinguish a decoy from a truly fresh
install by behaviour *or* timing.

A real backup code restores normally inside the decoy too (it is a real app).

### Hiding: covert gesture + visible button

- **Covert:** hold the "flock" wordmark in the topbar for 1.2 s (the Slice 5
  covert-hold threshold) — no visible affordance, works on every main screen.
- **Discoverable:** a "Hide flock now" button on the You-tab card, so the
  feature is learnable without folklore.

### No automatic alarm on hide

Hiding has legitimate non-duress uses (a border crossing, handing a phone to a
friend); alarming the circle on every hide would false-alarm. Under actual
duress, compose with the existing covert paths — e.g. the silent long-press on
"Stop sharing" raises the circle alarm, then hide. Documented on the card.

## Honest limits (documented in PRIVACY.md)

- **Forensics see a blob.** `flock:cache` is opaque (AES-GCM of a
  PBKDF2-derived key; format-free), but a forensic examiner who images the
  browser profile finds *something* encrypted and can demand the phrase.
  Deniability is behavioural (app-level), not forensic. Key-at-rest hardening
  is keystore-kit's job (Phase E).
- **The saved offline map survives.** An OPFS map extract of your home town is
  not moved (deleting it would re-download megabytes on unhide and look like
  cache churn). A coercer who creates a decoy circle and opens the map may see
  detailed offline tiles for one area — visually close to the raster fallback,
  but a determined inspector could notice. Follow-up if it proves real.
- **Nested hide refuses.** If someone enables protection *inside* a decoy and
  hides, the cache must not be overwritten — the attempt fails with a neutral
  storage-style message. Absurd corner, guarded anyway.
- **Losing the phrase while hidden** loses the state (that is the point) —
  unless a backup was made first; the enable card says exactly that.

## Implementation

- `app/src/decoy.ts` — pure crypto helpers (unit-tested, no I/O):
  `newSalt`, `deriveDecoyKey(phrase, saltB64)`, `sealState(json, saltB64,
  keyB64)`, `openState(blob, phrase)` (validates the decrypted JSON is a
  plausible state before it is trusted), `dummyWork(phrase)`.
- `app/src/store.ts` — `Persisted.decoy?: { salt, key }`;
  `restoreRaw(json)`; `lockSaves()` so a queued signal handler cannot
  resurrect `flock:v1` between the wipe and the reload.
- `app/src/app.ts` — You→Advanced card (set phrase → armed card), brand
  long-press → `hideNow()`, `doRestore` gains the constant-work unhide
  fallback.
- E2e (`e2e/decoy.spec.ts`) — two-person: hide → fresh + silent under B's
  signal → wrong phrase gets the genuine error → right phrase restores the
  circle. Solo: the decoy is fully usable; reset-inside-decoy preserves the
  cache; restore returns the real state.
