#!/usr/bin/env node
// Attest a flock release: record build → commit → APK hashes in the append-only
// transparency ledger (docs/transparency/RELEASES.jsonl) and mint an SSH-signed
// git tag release/<build> over the source commit, embedding the same record.
//
//   node scripts/attest-release.mjs            # attest the current HEAD release
//   node scripts/attest-release.mjs --selftest # prove the sign/verify round-trip only
//   npm run attest        /  npm run attest -- --selftest
//
// Why: flock's reproducible APK (docs/verify-apk.md) lets anyone rebuild the
// unsigned APK and confirm it matches this source. That check needs a trustworthy
// hash to compare against. deploy.sh already publishes the hash ON our host — but a
// compelled host could swap both the APK and that hash. The signed tag + ledger put
// the hash somewhere we do NOT serve: it rides git to every clone and to the forge,
// signed by the release key whose private half never leaves the maintainer's backup
// (native/release-signing-key, gitignored). A targeted build absent from this
// append-only, signed record is anomalous on its face — detection, not prevention.
//
// This tool NEVER pushes and NEVER touches the APK signing key. It commits the
// ledger line locally and prints the exact push commands for you to run.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, appendFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LEDGER = join(ROOT, 'docs/transparency/RELEASES.jsonl')
const SIGNERS = join(ROOT, 'docs/transparency/allowed_signers')
const PRIV_KEY = join(ROOT, 'native/release-signing-key')
const PRINCIPAL = 'releases@flock.forgesworn.dev'
const APK_DIR = 'android/app/build/outputs/apk/release'
const SIGNED_APK = join(ROOT, APK_DIR, 'flock-release.apk')
const UNSIGNED_APK = join(ROOT, APK_DIR, 'app-release-unsigned.apk')

const git = (...args) => execFileSync('git', args, { cwd: ROOT }).toString().trim()
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const die = (msg) => { console.error(`✗ ${msg}`); process.exit(1) }

// ── selftest: prove the release key + allowed_signers round-trip, mutate nothing ──
// Exercises the exact primitive `git tag -s` uses under the hood, so a verifier (or
// CI) can confirm the signing chain works without minting a release.
if (process.argv.includes('--selftest')) {
  if (!existsSync(PRIV_KEY)) die(`no signing key at ${PRIV_KEY} — mint it (see docs/transparency/README.md)`)
  const dir = mkdtempSync(join(tmpdir(), 'flock-attest-'))
  try {
    const payload = join(dir, 'payload')
    const message = 'flock release-attestation selftest\n'
    writeFileSync(payload, message)
    execFileSync('ssh-keygen', ['-Y', 'sign', '-n', 'git', '-f', PRIV_KEY, payload])
    // `-Y verify` reads the message from stdin (not a positional arg).
    const out = execFileSync('ssh-keygen', [
      '-Y', 'verify', '-f', SIGNERS, '-I', PRINCIPAL, '-n', 'git',
      '-s', `${payload}.sig`,
    ], { input: message }).toString().trim()
    console.log(`✓ selftest: ${out}`)
    console.log('  the release key signs and verifies against docs/transparency/allowed_signers.')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  process.exit(0)
}

// ── attest the current release ────────────────────────────────────────────────
if (!existsSync(PRIV_KEY)) die(`no signing key at ${PRIV_KEY} — mint it (see docs/transparency/README.md)`)
if (git('status', '--porcelain')) die('working tree is dirty — attest a clean release commit only')
if (!existsSync(SIGNED_APK)) die(`no signed APK at ${APK_DIR}/flock-release.apk — run 'npm run apk:release' first`)
if (!existsSync(UNSIGNED_APK)) die(`no unsigned APK at ${APK_DIR}/app-release-unsigned.apk — run 'npm run apk:release' first`)

const commit = git('rev-parse', 'HEAD')
const shortCommit = git('rev-parse', '--short', 'HEAD')

// PWA build hash (workstream B of the verifiable-builds plan): when dist-app
// holds this commit's build, record the sha256 of its asset manifest — the
// same bytes the release key signs for the service worker
// (scripts/sign-pwa-manifest.mjs) — so a forced web-asset push is at least
// RECORDED on a channel we don't serve. Optional: an APK-only attest (or a
// stale dist-app from another commit) simply omits it, loudly.
const PWA_MANIFEST = join(ROOT, 'dist-app/asset-manifest.json')
let pwaManifestSha256 = null
if (existsSync(PWA_MANIFEST)) {
  const pwaBuild = JSON.parse(readFileSync(PWA_MANIFEST, 'utf8')).build
  if (pwaBuild === shortCommit) {
    pwaManifestSha256 = sha256(PWA_MANIFEST)
  } else {
    console.error(`⚠ dist-app/asset-manifest.json is from build ${pwaBuild}, not ${shortCommit} — the PWA hash will NOT be recorded. Run 'npm run build:app' from this commit first if it should be.`)
  }
} else {
  console.error('⚠ no dist-app/asset-manifest.json — the PWA hash will NOT be recorded (build the PWA first if it should be).')
}

// Ground truth for the build id is the APK's OWN embedded stamp, not the git hash —
// guards against attesting a stale APK left over from a different commit (deploy.sh
// reads the same version.json for exactly this reason).
let embeddedBuild
try {
  embeddedBuild = execFileSync('unzip', ['-p', SIGNED_APK, 'assets/public/version.json'], { cwd: ROOT })
    .toString().match(/"build"\s*:\s*"([^"]+)"/)?.[1]
} catch { /* handled below */ }
if (!embeddedBuild) die('could not read the build stamp embedded in the signed APK (assets/public/version.json)')
if (embeddedBuild !== shortCommit) {
  die(`APK build stamp (${embeddedBuild}) ≠ HEAD (${shortCommit}) — the APK was built from a different commit; rebuild before attesting`)
}
const build = embeddedBuild

// Date from the committer epoch (UTC, timezone-independent) — the same derivation
// vite.config.ts stamps into the build, so the ledger date matches the build date.
const commitEpoch = Number(git('show', '-s', '--format=%ct', 'HEAD'))
const date = new Date(commitEpoch * 1000).toISOString().slice(0, 10)

// Refuse to double-attest a build already in the ledger.
const existing = readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
if (existing.some((e) => e.build === build)) die(`build ${build} is already attested in the ledger`)

// Schema /2 adds the optional pwaManifestSha256; /1 records (APK-only) remain
// valid history in the ledger.
const record = {
  schema: 'flock.release-attestation/2',
  build,
  commit,
  date,
  unsignedApkSha256: sha256(UNSIGNED_APK),
  signedApkSha256: sha256(SIGNED_APK),
  ...(pwaManifestSha256 ? { pwaManifestSha256 } : {}),
}

// Human-readable tag message embedding the record + how to verify it.
const tagMessage = [
  `flock release ${build}`,
  '',
  `commit:               ${commit}`,
  `date:                 ${date}  (committer epoch, UTC)`,
  `unsigned APK sha256:  ${record.unsignedApkSha256}`,
  `signed APK sha256:    ${record.signedApkSha256}`,
  ...(pwaManifestSha256 ? [`PWA manifest sha256:  ${pwaManifestSha256}`] : []),
  '',
  'The unsigned hash is the reproducibility anchor: rebuild it from this commit with',
  '`npm run apk:verify` and confirm it matches (docs/verify-apk.md). The signed hash',
  'identifies the exact file published at downloads/flock.apk.',
  ...(pwaManifestSha256 ? [
    'The PWA manifest hash pins the web build: it must equal the sha256 of the',
    'asset-manifest.json served at flock.forgesworn.dev (signed for the service',
    'worker by the same release key — scripts/sign-pwa-manifest.mjs).',
  ] : []),
  '',
  JSON.stringify(record),
  '',
].join('\n')

console.log(`→ attesting release ${build}`)
console.log(`  commit:              ${commit}`)
console.log(`  unsigned APK sha256: ${record.unsignedApkSha256}`)
console.log(`  signed APK sha256:   ${record.signedApkSha256}`)
if (pwaManifestSha256) console.log(`  PWA manifest sha256: ${pwaManifestSha256}`)

// 1. Append the ledger line and commit it (its own commit; the tag points at the
//    *source* commit the APK was built from, not this bookkeeping commit).
appendFileSync(LEDGER, JSON.stringify(record) + '\n')
git('add', 'docs/transparency/RELEASES.jsonl')
git('commit', '-m', `docs: attest release ${build} (unsigned ${record.unsignedApkSha256.slice(0, 12)}…)`)

// 2. Sign the tag over the SOURCE commit with the release key (SSH signing). Repo-
//    local config only — never touches the user's global git or the APK keystore.
const msgFile = join(mkdtempSync(join(tmpdir(), 'flock-attest-')), 'tag-msg')
writeFileSync(msgFile, tagMessage)
try {
  git('-c', 'gpg.format=ssh', '-c', `user.signingkey=${PRIV_KEY}`,
      'tag', '-s', `release/${build}`, commit, '-F', msgFile)
} finally {
  rmSync(dirname(msgFile), { recursive: true, force: true })
}

// 3. Verify the tag we just made, locally, before telling anyone it's good.
//    `git verify-tag` exits non-zero (execFileSync throws) if the signature or the
//    signer isn't trusted, so reaching the next line means it verified.
git('-c', `gpg.ssh.allowedSignersFile=${SIGNERS}`, 'verify-tag', `release/${build}`)
console.log(`✓ signed tag release/${build} created and verified against the release key`)

console.log('\nNothing was pushed. To publish this attestation off-host, run:')
console.log(`  git push origin HEAD release/${build}`)
console.log('\nAnyone can then verify it with:')
console.log('  git config gpg.ssh.allowedSignersFile docs/transparency/allowed_signers')
console.log(`  git verify-tag release/${build}`)
