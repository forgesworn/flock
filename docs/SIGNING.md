# flock APK signing key

flock's Android APK is signed with a single release key. **Android only installs an
update if it is signed with the same key as the installed version** — so this one key
is load-bearing: lose it and every user must uninstall/reinstall (losing local state);
let a *second* key exist and you ship builds that silently can't update people.

## The canonical release key

| | |
|---|---|
| **Certificate SHA-256** | `32:0A:B5:BC:EE:9E:BE:E3:3A:22:DA:A6:18:E7:9D:14:E8:1F:1A:B8:02:76:C3:DD:96:37:EF:AB:25:86:98:77` |
| (colon-free, as `apksigner` prints) | `320ab5bcee9ebee33a22daa618e79d14e81f1ab80276c3dd9637efab25869877` |
| Algorithm / validity | RSA-4096, from 2026-07-03 |
| Keystore | `native/release.keystore` (+ `native/keystore.properties`) — **gitignored**, held only in the maintainer's out-of-band backup |

This fingerprint is **pinned in `native/build-apk.sh`** (`CANONICAL_CERT`): a release
build whose signed cert doesn't match it **aborts**, and a missing keystore **errors**
instead of minting a new one. It matches the production APK at
`https://flock.forgesworn.dev/downloads/flock.apk` and every shipped install.

## Verify any APK is signed by the real key

```sh
apksigner verify --print-certs flock.apk | grep "SHA-256"
# → certificate SHA-256 digest: 320ab5bc…25869877   (must match the row above)
```

Reproducibility (that the *contents* match this source) is separate — see
`docs/verify-apk.md`. Signature = "who built it"; reproducibility = "from what".

## Custody rules

- **Back up `native/release.keystore` + `native/keystore.properties` out-of-band**
  (password manager / offline media), same as any root secret. They are never committed.
- **Never run `apk:release` without the real keystore present.** The build now refuses
  to (it used to silently mint a throwaway key — see the incident below).
- **Building on a fresh clone / CI:** restore the keystore first. There is no auto-mint.

## Minting a key (rare, deliberate)

Only for the *first-ever* release, or a full re-key (which forces every device to
reinstall). It is gated so it can't happen by accident:

```sh
FLOCK_MINT_KEYSTORE=1 npm run apk:release
```

This prints the new cert fingerprint. If you ever do this, **update `CANONICAL_CERT`
in `native/build-apk.sh` and the table above** to the new value.

## Incident note (2026-07-06)

A GrapheneOS test device was found running an older flock signed with a **different,
orphaned key** (`3C:AF:A9:23:0D:59:AD:AD:C9:C9:1C:2B:00:A4:63:EE:81:00:EB:E0:B1:7C:65:F2:C6:D6:8E:3D:D2:1A:DB:37`)
— an artefact of an earlier `apk:release` run made **before** the canonical keystore was
in place, which the old script silently minted. It is on no device now (that phone was
uninstalled/reinstalled onto the canonical key). The build-script guards above exist so
this can't recur: a missing keystore errors, and a non-canonical signature aborts.

## Related

- `native/build-apk.sh` — the guarded release path.
- `docs/verify-apk.md` — reproducibility (content matches source).
- `docs/transparency/` — off-host, signed record of released build hashes.
