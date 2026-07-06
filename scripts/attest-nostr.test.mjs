// Off-host transparency channel #2: the project-key Nostr note per release
// (docs/plans/2026-07-06-verifiable-builds-completion-goal.md, workstream C).
import { describe, it, expect } from 'vitest'
import { finalizeEvent, verifyEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { attestationEvent, RELEASE_D_PREFIX } from './attest-nostr.mjs'

const record = {
  schema: 'flock.release-attestation/2',
  build: 'dfaa8a9',
  commit: 'dfaa8a9be9a2209d7f2aff09be379ad483a4f121',
  date: '2026-07-06',
  unsignedApkSha256: 'd60b506765133c9357c57814b9b34baac721e85f7af6813cfb555802de0792cd',
  signedApkSha256: '0b7986e6d4280ddb90fe62f6a719ebf95fd627fef0ebd834e8d96db367b76a63',
}

describe('attestationEvent', () => {
  it('is an addressable NIP-78 note carrying the exact ledger record', () => {
    const tmpl = attestationEvent(record, 1751800000)
    expect(tmpl.kind).toBe(30078)
    expect(tmpl.created_at).toBe(1751800000)
    expect(tmpl.tags).toContainEqual(['d', `${RELEASE_D_PREFIX}dfaa8a9`])
    // Byte-consistent with the ledger/tag channels: content IS the record.
    expect(JSON.parse(tmpl.content)).toEqual(record)
  })

  it('signs and verifies with nostr-tools (what a verifier fetching the note runs)', () => {
    const sk = generateSecretKey()
    const signed = finalizeEvent(attestationEvent(record, 1751800000), sk)
    expect(verifyEvent(signed)).toBe(true)
    expect(signed.pubkey).toBe(getPublicKey(sk))
  })
})
