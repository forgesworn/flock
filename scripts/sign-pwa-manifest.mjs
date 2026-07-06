#!/usr/bin/env node
// Sign the PWA asset manifest with the release key — the deploy-time half of
// the PWA tamper-evidence layer (docs/plans/
// 2026-07-06-verifiable-builds-completion-goal.md, workstream B).
//
//   npm run build:app && node scripts/sign-pwa-manifest.mjs
//
// Reads dist-app/asset-manifest.json (emitted by the build), signs its exact
// bytes with `ssh-keygen -Y sign` (namespace flock-pwa-manifest — distinct
// from the "git" namespace of release tags, so neither signature can be
// replayed as the other) → dist-app/asset-manifest.json.sig. Then proves the
// result BOTH ways before declaring success: ssh-keygen -Y verify against
// docs/transparency/allowed_signers, and the exact browser verifier that ships
// (app/public/sw-verify.js) via Node's WebCrypto — what a user's service
// worker will actually run.
//
// The private key (native/release-signing-key) lives only in the maintainer's
// out-of-band backup; a build without it simply ships unsigned, and the SW
// treats an unsigned manifest as absent (best-effort tamper-evidence, honest
// about it — the APK is the artefact with the strong claim).
import { execFileSync } from 'node:child_process'
import { createHash, webcrypto } from 'node:crypto'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sshRawEd25519Pub, signFileWithSshKey, PWA_SIG_NAMESPACE, MANIFEST_NAME } from './pwa-manifest.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = join(ROOT, 'dist-app', MANIFEST_NAME)
const PRIV_KEY = join(ROOT, 'native/release-signing-key')
const PUB_KEY = join(ROOT, 'native/release-signing-key.pub')
const SIGNERS = join(ROOT, 'docs/transparency/allowed_signers')
const PRINCIPAL = 'releases@flock.forgesworn.dev'

const die = (msg) => { console.error(`✗ ${msg}`); process.exit(1) }

if (!existsSync(MANIFEST)) die(`no ${MANIFEST_NAME} in dist-app/ — run 'npm run build:app' first`)
if (!existsSync(PRIV_KEY)) die(`no signing key at ${PRIV_KEY} — the release key lives in the maintainer's out-of-band backup (docs/transparency/README.md)`)

const bytes = readFileSync(MANIFEST)
rmSync(`${MANIFEST}.sig`, { force: true })
signFileWithSshKey(MANIFEST, PRIV_KEY)

// Prove it round-trips through the CLI path (allowed_signers, like the tags)…
const verified = execFileSync('ssh-keygen', [
  '-Y', 'verify', '-f', SIGNERS, '-I', PRINCIPAL, '-n', PWA_SIG_NAMESPACE,
  '-s', `${MANIFEST}.sig`,
], { input: bytes }).toString().trim()

// …and through the EXACT verifier the service worker ships.
const swVerify = (() => {
  const self = {}
  new Function('self', readFileSync(join(ROOT, 'app/public/sw-verify.js'), 'utf8'))(self)
  return self.flockVerify
})()
const pubHex = sshRawEd25519Pub(readFileSync(PUB_KEY, 'utf8')).toString('hex')
const verdict = await swVerify.verifyManifestSig(webcrypto.subtle, new Uint8Array(bytes), readFileSync(`${MANIFEST}.sig`, 'utf8'), pubHex, PWA_SIG_NAMESPACE)
if (verdict !== 'ok') die(`the shipped browser verifier rejected this signature (${verdict}) — do NOT deploy`)

console.log(`✓ ${verified}`)
console.log('✓ the shipped service-worker verifier (sw-verify.js) accepts it')
console.log(`  manifest sha256: ${createHash('sha256').update(bytes).digest('hex')}`)
console.log(`  (recorded off-host by 'npm run attest' — docs/transparency/README.md)`)
