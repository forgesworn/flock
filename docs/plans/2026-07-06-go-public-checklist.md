# Go-public checklist — forgesworn/flock

**Status:** Prep — secrets audit PASSED (2026-07-06) · **Owner:** Darren (the flip
itself is a GitHub setting, maintainer-only)

Making `forgesworn/flock` public exposes **every past commit**, not just the current
tree. This is the pre-flight. It also *unlocks* the reproducible-build + attestation
work: `docs/verify-apk.md` and the signed `release/<build>` tags only become
externally verifiable once outsiders can actually clone the source.

## 1. Secrets audit — ✅ PASSED (2026-07-06)

Scanned the **entire history** (`git rev-list --all`), not just HEAD:

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
- [ ] **`SECURITY.md`** — for a coercion-resistance product this matters: how to
  report a vulnerability, the response expectation, and pointers to the warrant
  canary + the transparency log (`docs/transparency/`) and `docs/PRIVACY.md`
  "When a court comes knocking". *Add before or with the flip.*
- [ ] **README framing** — the header still says "Private repo — Owned by us". Update
  the public-facing framing (what flock is, install = APK is the verifiable artefact,
  link `docs/verify-apk.md`) so a first-time visitor lands well.
- [ ] **CONTRIBUTING.md** (optional) — only if inbound contributions are wanted;
  a private-by-default posture may prefer "issues welcome, PRs by discussion".

## 4. What the flip unlocks (verify then)

- `docs/verify-apk.md` already cites `github.com/forgesworn/flock` as the clone URL
  — becomes real; drop the "private today" caveat in `docs/transparency/README.md`
  and `verify-apk.md` once live.
- The signed `release/<build>` tags become externally checkable — an outsider can
  `git verify-tag` against the committed `allowed_signers`.

## Sequence

1. Add `SECURITY.md` + refresh the README header. *(code — can do now)*
2. Confirm key-only SSH on the host; decide on the username redaction. *(Darren)*
3. Re-run the §1 audit immediately before flipping. *(code — can do now)*
4. Flip to public on GitHub. *(Darren — maintainer-only)*
5. Drop the "private today" caveats; push the first real `release/<build>` tag at
   the next deploy so there is a live, externally-verifiable attestation on day one.

## Related

- `docs/transparency/README.md`, `docs/verify-apk.md` — what going public unlocks.
- `docs/plans/2026-07-06-verifiable-builds.md` — the umbrella plan.
