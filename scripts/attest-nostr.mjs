#!/usr/bin/env node
// Off-host transparency channel #2: publish a release attestation as a Nostr
// note signed by the PROJECT key (docs/plans/
// 2026-07-06-verifiable-builds-completion-goal.md, workstream C).
//
//   npm run attest:nostr                       # publish the latest ledger record
//   npm run attest:nostr -- --build dfaa8a9    # publish a specific build's record
//   npm run attest:nostr -- --dry-run          # build + sign + verify, no network
//   npm run attest:nostr -- --selftest         # throwaway key, proves the chain
//
// Why a second channel: channel #1 (the SSH-signed release/<build> git tag +
// RELEASES.jsonl) rides git and the forge. This note rides Nostr — a system
// with no failure or compulsion domain shared with our host OR the forge — so
// "download", "verify via git" and "verify via Nostr" are answered by three
// independent parties. The note's content is the EXACT ledger record, so all
// channels are byte-consistent.
//
// Unlike flock's sensitive traffic, a transparency note is MEANT to be seen:
// publishing it to public relays is deliberately fine — for this note only.
//
// Keys: the PROJECT publishing key is a stable, well-known Nostr identity,
// distinct from any user key and from the release-signing key. Its npub is
// committed (docs/transparency/project-npub); its private half is supplied at
// publish time via FLOCK_PROJECT_NSEC (nsec1… or 64-hex) and never stored in
// the repo. Publishing refuses to run until the committed npub is real, and
// refuses a key that doesn't match it.
import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { finalizeEvent, verifyEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'

export const RELEASE_D_PREFIX = 'flock-release-'
const DEFAULT_RELAYS = ['wss://relay.trotters.cc']

/** The note template: NIP-78 addressable (kind 30078), one per release —
 *  content is the ledger record verbatim so every channel carries identical
 *  bytes. Exported for the vitest parity check. */
export function attestationEvent(record, createdAt) {
  return {
    kind: 30078,
    created_at: createdAt,
    tags: [
      ['d', `${RELEASE_D_PREFIX}${record.build}`],
      ['t', 'flock-release-attestation'],
    ],
    content: JSON.stringify(record),
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const LEDGER = join(ROOT, 'docs/transparency/RELEASES.jsonl')
  const NPUB_FILE = join(ROOT, 'docs/transparency/project-npub')
  const die = (msg) => { console.error(`✗ ${msg}`); process.exit(1) }

  const args = process.argv.slice(2)
  const selftest = args.includes('--selftest')
  const dryRun = args.includes('--dry-run')
  const buildArg = args[args.indexOf('--build') + 1] && args.includes('--build') ? args[args.indexOf('--build') + 1] : null

  // Pick the record: an explicit --build, else the newest release line.
  const records = readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.build)
  const record = buildArg ? records.find((r) => r.build === buildArg) : records[records.length - 1]
  if (!record) die(buildArg ? `build ${buildArg} is not in the ledger` : 'no release records in the ledger yet')

  // The signing key.
  let sk
  if (selftest) {
    sk = generateSecretKey()
    console.log('— selftest: throwaway project key, nothing publishes —')
  } else {
    // The committed npub is the public promise of who speaks for the project;
    // refuse to operate without it (blocked on the project publishing key —
    // see docs/transparency/README.md) or with a mismatched private key.
    const npubLine = readFileSync(NPUB_FILE, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')).pop()?.trim()
    if (!npubLine || npubLine === 'PENDING') {
      die('the project publishing key does not exist yet (docs/transparency/project-npub is PENDING) — mint it, commit its npub, then re-run')
    }
    const nsec = process.env.FLOCK_PROJECT_NSEC
    if (!nsec) die('set FLOCK_PROJECT_NSEC (nsec1… or 64-hex) — the project key is never stored in the repo')
    sk = nsec.startsWith('nsec1') ? nip19.decode(nsec).data : Uint8Array.from(Buffer.from(nsec, 'hex'))
    const expected = nip19.decode(npubLine).data
    if (getPublicKey(sk) !== expected) die('FLOCK_PROJECT_NSEC does not match the committed project npub — wrong key')
  }

  const signed = finalizeEvent(attestationEvent(record, Math.floor(Date.now() / 1000)), sk)
  if (!verifyEvent(signed)) die('freshly signed note failed local verification — refusing to publish')
  console.log(`✓ attestation note for release ${record.build} signed and locally verified`)
  console.log(`  npub:    ${nip19.npubEncode(signed.pubkey)}`)
  console.log(`  d tag:   ${RELEASE_D_PREFIX}${record.build}`)
  console.log(`  content: ${signed.content}`)

  if (selftest || dryRun) {
    console.log(`\n✓ ${selftest ? 'selftest' : 'dry run'} passed — nothing was published`)
    process.exit(0)
  }

  const relays = (process.env.FLOCK_ATTEST_RELAYS || DEFAULT_RELAYS.join(',')).split(',').map((r) => r.trim()).filter(Boolean)
  const { SimplePool } = await import('nostr-tools/pool')
  const pool = new SimplePool()
  const results = await Promise.allSettled(pool.publish(relays, signed))
  let ok = 0
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') { ok += 1; console.log(`✓ published to ${relays[i]}`) }
    else console.error(`✗ ${relays[i]}: ${r.reason?.message ?? r.reason}`)
  })
  pool.close(relays)
  if (!ok) die('no relay accepted the note — channel #2 is NOT published for this release')
  console.log(`\n✓ channel #2 live on ${ok}/${relays.length} relay(s). Anyone can verify:`)
  console.log(`  fetch kind 30078, author ${nip19.npubEncode(signed.pubkey)}, #d ${RELEASE_D_PREFIX}${record.build}`)
  console.log('  → its hashes must equal the signed git tag + the on-host anchor (docs/transparency/README.md).')
  process.exit(0)
}
