// FlockSigner — the one signing/encryption seam.
//
// Today: LocalSigner (key in localStorage — preview only). Next: a SignetSigner
// adapter over signet-login's `SignetSigner` (key in a NIP-46 bunker, never in
// flock). All event signing + NIP-44 goes through this interface so swapping the
// backend is a one-line change.

import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { getConversationKey, encrypt as nip44encrypt, decrypt as nip44decrypt } from 'nostr-tools/nip44'
import { fromHex } from './store'

export interface SignedEvent {
  id: string
  pubkey: string
  kind: number
  created_at: number
  tags: string[][]
  content: string
  sig: string
}

export interface EventTemplate {
  kind: number
  content: string
  tags: string[][]
  created_at?: number
}

/** Unified signer — LocalSigner now, SignetSigner (signet-login) next. */
export interface FlockSigner {
  readonly pubkey: string
  signEvent(template: EventTemplate): Promise<SignedEvent>
  nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string>
  nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string>
}

const nowSec = (): number => Math.floor(Date.now() / 1000)

/** Local-key signer. The nsec lives in localStorage — preview only; superseded by Signet. */
export class LocalSigner implements FlockSigner {
  readonly pubkey: string
  constructor(private readonly skHex: string) {
    this.pubkey = getPublicKey(fromHex(skHex))
  }

  signEvent(template: EventTemplate): Promise<SignedEvent> {
    const t = { ...template, created_at: template.created_at ?? nowSec() }
    return Promise.resolve(finalizeEvent(t, fromHex(this.skHex)) as unknown as SignedEvent)
  }

  nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string> {
    return Promise.resolve(nip44encrypt(plaintext, getConversationKey(fromHex(this.skHex), peerPubkey)))
  }

  nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string> {
    return Promise.resolve(nip44decrypt(ciphertext, getConversationKey(fromHex(this.skHex), peerPubkey)))
  }

  /** WIP escape hatch for the gift-wrap path until SignetSigner-based wrapping lands. */
  get secretKeyHex(): string { return this.skHex }
}

export function makeLocalSigner(skHex: string): FlockSigner {
  return new LocalSigner(skHex)
}
