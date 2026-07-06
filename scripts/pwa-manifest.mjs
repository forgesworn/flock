// Shared helpers for the PWA tamper-evidence layer (docs/plans/
// 2026-07-06-verifiable-builds-completion-goal.md, workstream B): the build
// emits dist-app/asset-manifest.json ({assetPath: sha256}); the deploy signs it
// with the release key (`ssh-keygen -Y sign`, the same primitive and custody as
// the release/<build> git tags); the service worker verifies the signature and
// each cached asset against it (app/public/sw-verify.js + sw.js).
//
// Used by vite.config.ts (emission), scripts/sign-pwa-manifest.mjs (signing),
// scripts/attest-release.mjs (the off-host record of the manifest hash), and
// scripts/pwa-manifest.test.mjs (parity with the shipped browser verifier).
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

/** SSHSIG namespace for manifest signatures. Distinct from "git" (the release
 *  tags) so a signature for one purpose can never be replayed as the other;
 *  docs/transparency/allowed_signers authorises both on the release key. */
export const PWA_SIG_NAMESPACE = 'flock-pwa-manifest'
export const MANIFEST_NAME = 'asset-manifest.json'

/** Hash every file under dir → {assetPath: sha256hex}, paths posix-relative and
 *  sorted. Skips the manifest + its signature (they can't cover themselves) and
 *  .pmtiles extracts (dev/demo only — deploy.sh never ships them). */
export function buildManifest(dir, build) {
  const assets = {}
  const walk = (sub) => {
    for (const entry of readdirSync(join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(rel)
      else if (rel !== MANIFEST_NAME && rel !== `${MANIFEST_NAME}.sig` && !rel.endsWith('.pmtiles')) {
        assets[rel] = createHash('sha256').update(readFileSync(join(dir, rel))).digest('hex')
      }
    }
  }
  walk('')
  const sorted = {}
  for (const k of Object.keys(assets).sort()) sorted[k] = assets[k]
  return { schema: 'flock.pwa-manifest/1', build, assets: sorted }
}

/** The exact bytes that are written, signed and verified — pretty-printed so a
 *  lockstep diff of two builds is reviewable, newline-terminated. */
export function manifestToBytes(manifest) {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

/** Raw 32-byte ed25519 public key out of an OpenSSH .pub line — what the
 *  service worker bakes in and WebCrypto imports. */
export function sshRawEd25519Pub(pubLine) {
  const buf = Buffer.from(pubLine.trim().split(/\s+/)[1], 'base64')
  const typeLen = buf.readUInt32BE(0)
  const type = buf.subarray(4, 4 + typeLen).toString()
  if (type !== 'ssh-ed25519') throw new Error(`expected an ssh-ed25519 key, got ${type}`)
  const keyLen = buf.readUInt32BE(4 + typeLen)
  return buf.subarray(8 + typeLen, 8 + typeLen + keyLen)
}

/** `ssh-keygen -Y sign` over the file → <file>.sig (armored SSHSIG). Handles a
 *  passphrase-protected key the same way the attest tool does — ssh-keygen
 *  prompts / uses the agent; the raw seed never passes through Node. */
export function signFileWithSshKey(filePath, keyPath, namespace = PWA_SIG_NAMESPACE) {
  execFileSync('ssh-keygen', ['-Y', 'sign', '-n', namespace, '-f', keyPath, filePath], { stdio: ['inherit', 'pipe', 'pipe'] })
}
