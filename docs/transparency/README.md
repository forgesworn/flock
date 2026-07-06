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
| `RELEASES.jsonl` | Append-only ledger, one JSON object per release, oldest first. Schema `flock.release-attestation/1`: `{build, commit, date, unsignedApkSha256, signedApkSha256}`. |
| `allowed_signers` | OpenSSH `allowed_signers` file — the public key(s) authorised to sign release tags. `git verify-tag` checks against this. |
| (each release) | A signed git tag `release/<build>` over the source commit, its message embedding the same record. |

The matching **private** key is `native/release-signing-key` — **gitignored**, held
only in the maintainer's out-of-band backup, exactly like the APK keystore
(`native/release.keystore`). Only the `.pub` half is committed. Losing it is not
catastrophic (rotate: append the new public line to `allowed_signers`, keep the old
so past tags still verify); leaking it lets someone forge *new* attestations, so
treat it like the keystore.

## Make a release attestation (maintainer)

After `npm run apk:release` and `deploy/deploy.sh` for a **clean** release commit:

```sh
npm run attest                 # records build→commit→hashes, mints signed tag release/<build>
git push origin HEAD release/<build>   # publish off-host (nothing is pushed until you run this)
```

`npm run attest` commits the ledger line and signs the tag **locally** — it never
pushes and never touches the APK signing key. Prove the signing chain any time
without making a release:

```sh
npm run attest -- --selftest   # signs a throwaway payload and verifies it round-trips
```

## Verify a release (anyone)

```sh
git config gpg.ssh.allowedSignersFile docs/transparency/allowed_signers
git verify-tag release/<build>          # must print: Good "git" signature for releases@flock.forgesworn.dev
```

Then rebuild the unsigned APK from that tag and confirm its hash matches the
`unsignedApkSha256` in the tag message / ledger line — full procedure in
`docs/verify-apk.md`.

## Honest limits

- **Private repo today.** `forgesworn/flock` is private, so only people with repo
  access can see these tags right now. The record is still meaningful — it is
  replicated to the forge, a copy we do not serve from Caddy, so *we* cannot
  silently diverge from it — but its value as a **public** transparency anchor is
  unlocked only when the source is made public. That is a deliberate decision, not
  an oversight.
- **One channel until the second lands.** The signed git tag is off-host channel
  #1. A project-key **Nostr note** per release (the stack is already Nostr) is the
  intended channel #2, so "download" and "verify" are answered by two independent
  systems. Scaffolding exists to add it; it needs the project publishing key.
- **Signed ≠ reproducible for the signed APK.** The *signed* hash identifies the
  exact published file; only the *unsigned* hash is independently reproducible
  (we alone hold the APK key). Both are recorded on purpose.
- **Append-only is a convention here, enforced by signatures + review**, not by a
  tamper-proof server. The point is that breaking it leaves evidence.

## Related

- `docs/verify-apk.md` — rebuild-and-compare procedure.
- `docs/plans/2026-07-06-verifiable-builds.md` — the full plan.
- `scripts/attest-release.mjs` — the tool. `deploy/deploy.sh` — the on-host anchor.
