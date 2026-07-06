# Release transparency log

This directory is flock's **off-host, append-only, signed record** of what we
shipped. It is the second half of the compelled-update defence: the reproducible
APK (`docs/verify-apk.md`) lets anyone rebuild the release and get the same bytes;
this log gives them a **trustworthy hash to compare against, published somewhere we
do not serve.**

## Why off-host matters

`deploy/deploy.sh` publishes the release hash on our own download host
(`flock.forgesworn.dev/downloads/flock.apk.unsigned.sha256`). That is convenient
but not sufficient on its own: a **compelled or compromised host can swap both the
APK and its hash** in one move, and nothing on that host would contradict it.

The record here rides **git**, not our web host. It is replicated to every clone
and to the forge, and each release is pinned by an **SSH-signed tag**. To forge a
targeted build silently, an adversary would have to also rewrite this signed,
append-only history everywhere it is mirrored — which is exactly the kind of
anomaly the record exists to surface. This is deterrence by **detection, not
prevention** (the same logic as Chrome/Go binary transparency and F-Droid).

## What's here

| File | Role |
|---|---|
| `RELEASES.jsonl` | Append-only ledger, one JSON object per release, oldest first. Schema `flock.release-attestation/2`: `{build, commit, date, unsignedApkSha256, signedApkSha256, pwaManifestSha256?}` (the optional PWA field pins the web build's signed asset manifest; `/1` records are APK-only history). |
| `allowed_signers` | OpenSSH `allowed_signers` file — the public key(s) authorised to sign release tags (namespace `git`) and the PWA asset manifest (namespace `flock-pwa-manifest`). `git verify-tag` / `ssh-keygen -Y verify` check against this. |
| `project-npub` | The project's Nostr publishing identity for channel #2 (**PENDING** until minted — see below). |
| (each release) | A signed git tag `release/<build>` over the source commit, its message embedding the same record. |

The matching **private** key is `native/release-signing-key` — **gitignored**, held
only in the maintainer's out-of-band backup, exactly like the APK keystore
(`native/release.keystore`). Only the `.pub` half is committed. Losing it is not
catastrophic (rotate: append the new public line to `allowed_signers`, keep the old
so past tags still verify); leaking it lets someone forge *new* attestations, so
treat it like the keystore.

The same key signs the **PWA asset manifest** at deploy time
(`npm run sign:pwa` — `deploy/deploy.sh` runs it automatically): namespace
`flock-pwa-manifest`, so a manifest signature can never be replayed as a tag
signature or vice versa. The service worker bakes the raw public half and
verifies what it caches against the signed manifest (`app/public/sw.js` +
`sw-verify.js`). One key, one custody story, two namespaces.

## Make a release attestation (maintainer)

After `npm run apk:release` and `deploy/deploy.sh` for a **clean** release commit
(the deploy signs the PWA asset manifest; keep `dist-app/` around so the attest
records its hash too):

```sh
npm run attest                 # records build→commit→hashes (+ PWA manifest hash), mints signed tag release/<build>
git push origin HEAD release/<build>   # publish off-host (nothing is pushed until you run this)
FLOCK_PROJECT_NSEC=nsec1… npm run attest:nostr   # channel #2, once the project key exists
```

`npm run attest` commits the ledger line and signs the tag **locally** — it never
pushes and never touches the APK signing key. Prove the signing chain any time
without making a release:

```sh
npm run attest -- --selftest   # signs a throwaway payload and verifies it round-trips
```

## Channel #2 — the project-key Nostr note

Channel #1 (the signed tag + ledger) rides git and the forge. Channel #2 rides
**Nostr** — no failure or compulsion domain shared with our host *or* the forge:
one addressable note per release (kind 30078, `d = flock-release-<build>`),
signed by the **project publishing key**, its content the ledger record
**verbatim** so every channel carries identical bytes. Unlike flock's sensitive
traffic, a transparency note is *meant* to be seen — publishing it to public
relays is deliberately acceptable **for this note only**.

```sh
FLOCK_PROJECT_NSEC=nsec1… npm run attest:nostr        # after the signed tag exists
npm run attest:nostr -- --selftest                    # prove the chain, throwaway key
```

The project key is a stable Nostr identity **distinct from any user key and from
the release-signing key**; its npub is committed in `project-npub`, its private
half held out-of-band and supplied only at publish time. **Status: the key is
not yet minted** (`project-npub` reads PENDING; the tool refuses to publish
until it's real, and refuses an nsec that doesn't match it).

## Verify a release (anyone)

```sh
git config gpg.ssh.allowedSignersFile docs/transparency/allowed_signers
git verify-tag release/<build>          # must print: Good "git" signature for releases@flock.forgesworn.dev
```

Then rebuild the unsigned APK from that tag and confirm its hash matches the
`unsignedApkSha256` in the tag message / ledger line — full procedure in
`docs/verify-apk.md`.

**The three-channel cross-check.** For high confidence, confirm the same record
in three places that would all have to be compromised together:

1. **On-host** — `https://flock.forgesworn.dev/downloads/flock.apk.unsigned.sha256`
   (and, for the web app, the sha256 of the served `asset-manifest.json` against
   `pwaManifestSha256`).
2. **Git (channel #1)** — the signed `release/<build>` tag / ledger line, above.
3. **Nostr (channel #2, once the key is live)** — fetch kind `30078` by the
   npub committed in `project-npub` with `#d = flock-release-<build>`; check the
   note's signature and that its hashes equal the tag's and the host's.

Match across all three ⇒ the shipped release is what this source built.

## Honest limits

- **Private repo today.** `forgesworn/flock` is private, so only people with repo
  access can see these tags right now. The record is still meaningful — it is
  replicated to the forge, a copy we do not serve from Caddy, so *we* cannot
  silently diverge from it — but its value as a **public** transparency anchor is
  unlocked only when the source is made public. That is a deliberate decision, not
  an oversight.
- **One operating channel until the project key is minted.** Channel #2 is built,
  tested and wired (`npm run attest:nostr`), but it publishes nothing until the
  project publishing key exists and `project-npub` carries its real npub.
- **Signed ≠ reproducible for the signed APK.** The *signed* hash identifies the
  exact published file; only the *unsigned* hash is independently reproducible
  (we alone hold the APK key). Both are recorded on purpose.
- **Append-only is a convention here, enforced by signatures + review**, not by a
  tamper-proof server. The point is that breaking it leaves evidence.

## Related

- `docs/verify-apk.md` — rebuild-and-compare procedure.
- `docs/plans/2026-07-06-verifiable-builds.md` — the full plan.
- `scripts/attest-release.mjs` — the tool. `deploy/deploy.sh` — the on-host anchor.
