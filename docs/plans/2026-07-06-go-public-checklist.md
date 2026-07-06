# Go-public checklist — forgesworn/flock

**Status:** Prep **essentially complete** — secrets audit re-PASSED over the full
277-commit history (2026-07-06), `SECURITY.md` added, README refreshed, first real
release already attested & published (`release/dfaa8a9`). **Only maintainer steps
remain:** the DEPLOY.md username-redaction call + confirm key-only SSH (§2), then
the flip itself. · **Owner:** Darren (the flip is a GitHub setting, maintainer-only)

Making `forgesworn/flock` public exposes **every past commit**, not just the current
tree. This is the pre-flight. It also *unlocks* the reproducible-build + attestation
work: `docs/verify-apk.md` and the signed `release/<build>` tags only become
externally verifiable once outsiders can actually clone the source.

## 1. Secrets audit — ✅ RE-PASSED (2026-07-06, full 277-commit history)

Re-run this session over the updated history (new release commits + the
release-signing key landing). Method corrected to grep every commit
(`git grep -E <pattern> $(git rev-list --all)` — note `git grep` has no commit
`--stdin`, so the rev-list must be a positional arg list). Results, all clean:
**no** `BEGIN … PRIVATE KEY` / `nsec1…` / `xprv…` in any blob; **no** sensitive
path (`*.keystore`, `keystore.properties`, `release-signing-key`, `.env`, `*.pem`,
`*.p12`, `*.jks`) ever committed; all three private keys gitignored + untracked;
the only `storePass=` hits are `build-apk.sh`'s `printf`/`sed` template (no value)
and this doc; the only "secret" match is the code identifier
`const secret = generateStorageSecret()` (a runtime RNG call, not a literal).

Original 2026-07-06 audit (still valid), scanned the **entire history**
(`git rev-list --all`), not just HEAD:

- **No sensitive file ever committed** — checked `native/release.keystore`, any
  `*.keystore`, `native/keystore.properties`, `native/release-signing-key` (the APK
  key and the new release-signing key — both gitignored, private halves never in
  git), `.env` / `.env.*`, `*.pem`, `*.p12`, `*.jks`. All: never committed.
- **No key material in any blob** — no `BEGIN … PRIVATE KEY` block, no `nsec1…`, no
  `xprv…` anywhere in history or the current tree.
- **Only marker hit is benign** — `native/build-apk.sh` matches `storePass=`, but
  that is the *template* that writes the gitignored `keystore.properties`
  (`printf 'storePass=%s\n' "$PASS"`), carrying no actual value.

**Re-run before flipping** (history can change): the two scans in this session —
`git log --all --full-history -- <sensitive paths>` and the blob marker grep over
`git rev-list --all`. If either is non-empty for anything but the `build-apk.sh`
template, history must be rewritten (`git filter-repo`) *before* going public.

## 2. Infra detail that becomes public — decide, not blocking

- **Host IP `95.217.39.110` + SSH users `deploy`/`root`** appear in `deploy/*` and
  `docs/DEPLOY.md`. The IP is already discoverable (DNS for `flock.forgesworn.dev`),
  so low marginal risk; the **usernames** are a minor recon gift. Options: accept
  (SSH should be key-only, no password auth), or parameterise the docs to
  `deploy@<host>` and keep the real values in a private ops note. *Recommendation:
  confirm key-only SSH, then accept — redacting docs that describe a public URL's
  own host is low-value.*
- **`relay.trotters.cc`** (the no-log private relay) is referenced throughout — but
  it is already the deployed app's default relay, discoverable by any user. Not a new
  exposure; no action.

## 3. Public-readiness polish

- [x] `LICENSE` present (MIT — matches `package.json`).
- [x] `README.md` present.
- [x] **`SECURITY.md`** — ✅ added (2026-07-06). Private reporting via GitHub
  private vulnerability reporting (never a public issue); the coercion-resistance
  invariants as the highest-severity scope; response expectation; pointers to
  `docs/PRIVACY.md` "When a court comes knocking", `FLOCK.md` §6, `docs/verify-apk.md`,
  and `docs/transparency/`. Does **not** overclaim the warrant canary (still planned,
  not published). **Maintainer step:** enable *Private vulnerability reporting* in the
  repo's Security settings (a GitHub toggle, like the flip) so that channel is live.
- [x] **README framing** — ✅ refreshed (2026-07-06). Replaced the stale "**Not yet:**
  delivery with the app fully closed" line (that gate is now shipped + measured GREEN)
  with the shipped native-background-publish status **and** the "the APK is the
  verifiable artefact" framing, linking `docs/verify-apk.md` + `SECURITY.md`. (The
  "Private repo — Owned by us" line lives in `CLAUDE.md`, internal dev guidance, not
  the README; honest until the flip.)
- [ ] **CONTRIBUTING.md** (optional) — only if inbound contributions are wanted;
  a private-by-default posture may prefer "issues welcome, PRs by discussion".

## 4. What the flip unlocks (verify then)

- `docs/verify-apk.md` already cites `github.com/forgesworn/flock` as the clone URL
  — becomes real; drop the "private today" caveat in `docs/transparency/README.md`
  and `verify-apk.md` once live.
- The signed `release/<build>` tags become externally checkable — an outsider can
  `git verify-tag` against the committed `allowed_signers`.

## Sequence

1. ~~Add `SECURITY.md` + refresh the README header.~~ ✅ **done 2026-07-06.**
2. Confirm key-only SSH on the host; decide on the username redaction. *(Darren —
   still open; see §2. Recommendation stands: confirm key-only, then accept.)*
3. ~~Re-run the §1 audit immediately before flipping.~~ ✅ **re-passed 2026-07-06**
   over the full history — but history keeps moving, so **run it once more in the
   same session as the flip** (the two scans in §1).
4. Flip to public on GitHub. *(Darren — maintainer-only)* + enable *Private
   vulnerability reporting* in Security settings so `SECURITY.md`'s channel is live.
5. Drop the "private today" caveats in `docs/transparency/README.md` +
   `docs/verify-apk.md`. **The first real `release/<build>` tag is already published**
   (`release/dfaa8a9`, 2026-07-06) — so there is a live, externally-verifiable
   attestation waiting the moment the repo goes public; nothing to build here.

## Related

- `docs/transparency/README.md`, `docs/verify-apk.md` — what going public unlocks.
- `docs/plans/2026-07-06-verifiable-builds.md` — the umbrella plan.
