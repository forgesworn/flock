// PWA tamper-evidence: the signed asset manifest (docs/plans/
// 2026-07-06-verifiable-builds-completion-goal.md, workstream B).
//
// Parity discipline mirrors the native golden vectors: the browser-side
// verifier that actually ships (app/public/sw-verify.js) is loaded here as-is
// and must verify real `ssh-keygen -Y sign` output produced by the Node-side
// tooling — the same signature the deploy step mints with the release key.
import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, webcrypto } from 'node:crypto'
import { buildManifest, manifestToBytes, sshRawEd25519Pub, signFileWithSshKey, PWA_SIG_NAMESPACE } from './pwa-manifest.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/** Load app/public/sw-verify.js — a classic worker script — the way the SW
 *  does: execute it against a bare `self` and use what it attaches. */
function loadSwVerify() {
  const src = readFileSync(resolve(here, '../app/public/sw-verify.js'), 'utf8')
  const self = {}
  new Function('self', src)(self)
  return self.flockVerify
}

describe('buildManifest', () => {
  it('hashes every asset with sorted, posix-relative paths and skips manifest/sig/pmtiles', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flock-manifest-'))
    writeFileSync(join(dir, 'index.html'), '<!doctype html>hello')
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'assets', 'main-abc.js'), 'console.log(1)')
    writeFileSync(join(dir, 'asset-manifest.json'), '{}')            // never hashes itself
    writeFileSync(join(dir, 'asset-manifest.json.sig'), 'sig')       // nor its signature
    writeFileSync(join(dir, 'demo.pmtiles'), 'tiles')                // never ships (deploy excludes)
    const m = buildManifest(dir, 'abc1234')
    expect(m.schema).toBe('flock.pwa-manifest/1')
    expect(m.build).toBe('abc1234')
    expect(Object.keys(m.assets)).toEqual(['assets/main-abc.js', 'index.html']) // sorted
    expect(m.assets['index.html']).toBe(createHash('sha256').update('<!doctype html>hello').digest('hex'))
  })

  it('serialises deterministically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flock-manifest-'))
    writeFileSync(join(dir, 'b.txt'), 'b')
    writeFileSync(join(dir, 'a.txt'), 'a')
    const one = manifestToBytes(buildManifest(dir, 'x'))
    const two = manifestToBytes(buildManifest(dir, 'x'))
    expect(Buffer.compare(one, two)).toBe(0)
    expect(one[one.length - 1]).toBe(0x0a) // newline-terminated
  })
})

describe('sshRawEd25519Pub', () => {
  it('extracts the raw 32-byte key from the committed release .pub', () => {
    const pub = sshRawEd25519Pub(readFileSync(resolve(here, '../native/release-signing-key.pub'), 'utf8'))
    expect(pub.length).toBe(32)
    expect(pub.toString('hex')).toBe('8e43dc5c2de234f1c6b75bc9720fd4313f8a24bdb5e5c00f20d00ba09b075b12')
  })
})

describe('sign → sw-verify parity (the shipped browser verifier)', () => {
  let keyDir, pubHex, manifestPath, manifestBytes, sigText, verify

  beforeAll(() => {
    // Throwaway ed25519 keypair standing in for the release key (whose private
    // half never touches this machine).
    keyDir = mkdtempSync(join(tmpdir(), 'flock-sigtest-'))
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-f', join(keyDir, 'key'), '-C', 'test'])
    pubHex = sshRawEd25519Pub(readFileSync(join(keyDir, 'key.pub'), 'utf8')).toString('hex')

    const dir = mkdtempSync(join(tmpdir(), 'flock-dist-'))
    writeFileSync(join(dir, 'index.html'), '<!doctype html>flock')
    manifestBytes = manifestToBytes(buildManifest(dir, 'test123'))
    manifestPath = join(dir, 'asset-manifest.json')
    writeFileSync(manifestPath, manifestBytes)
    signFileWithSshKey(manifestPath, join(keyDir, 'key'))
    sigText = readFileSync(`${manifestPath}.sig`, 'utf8')
    verify = loadSwVerify()
  })

  it('verifies a genuine signature', async () => {
    const res = await verify.verifyManifestSig(webcrypto.subtle, new Uint8Array(manifestBytes), sigText, pubHex, PWA_SIG_NAMESPACE)
    expect(res).toBe('ok')
  })

  it('rejects tampered manifest bytes', async () => {
    const tampered = Buffer.from(manifestBytes)
    tampered[tampered.length - 2] ^= 0xff
    const res = await verify.verifyManifestSig(webcrypto.subtle, new Uint8Array(tampered), sigText, pubHex, PWA_SIG_NAMESPACE)
    expect(res).toBe('bad')
  })

  it('rejects a signature from a different key', async () => {
    const otherPub = 'aa'.repeat(32)
    const res = await verify.verifyManifestSig(webcrypto.subtle, new Uint8Array(manifestBytes), sigText, otherPub, PWA_SIG_NAMESPACE)
    expect(res).toBe('bad')
  })

  it('rejects the right signature under the wrong namespace', async () => {
    const res = await verify.verifyManifestSig(webcrypto.subtle, new Uint8Array(manifestBytes), sigText, pubHex, 'git')
    expect(res).toBe('bad')
  })

  it("classifies content that isn't an SSHSIG at all as not-a-signature, not bad", async () => {
    // The distinction matters: an SPA host falls back unknown paths to
    // index.html, so a *legitimately unsigned* self-host serves HTML where the
    // .sig would be. That is "no signature shipped" (quiet, unless the origin
    // was signed before — the sticky marker), NOT a cryptographic rejection.
    const html = '<!doctype html><html><body>flock</body></html>'
    const res = await verify.verifyManifestSig(webcrypto.subtle, new Uint8Array(manifestBytes), html, pubHex, PWA_SIG_NAMESPACE)
    expect(res).toBe('not-a-signature')
  })

  it('reports unsupported (never a false alarm) when WebCrypto lacks Ed25519', async () => {
    const subtle = {
      digest: webcrypto.subtle.digest.bind(webcrypto.subtle),
      importKey: () => Promise.reject(new Error('Ed25519 not supported')),
    }
    const res = await verify.verifyManifestSig(subtle, new Uint8Array(manifestBytes), sigText, pubHex, PWA_SIG_NAMESPACE)
    expect(res).toBe('unsupported')
  })

  it('sha256Hex matches Node for asset-hash comparison', async () => {
    const bytes = new TextEncoder().encode('flock asset body')
    expect(await verify.sha256Hex(webcrypto.subtle, bytes))
      .toBe(createHash('sha256').update('flock asset body').digest('hex'))
  })
})
