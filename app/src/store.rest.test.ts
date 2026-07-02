import { describe, it, expect, beforeEach } from 'vitest'
import * as store from './store'

// A minimal localStorage for Node — the rest-encryption layer is the one part
// of the store that must be exercised against real (stubbed) storage.
const mem = new Map<string, string>()
globalThis.localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  removeItem: (k: string) => { mem.delete(k) },
  clear: () => mem.clear(),
  key: () => null,
  length: 0,
} as unknown as Storage

const SECRET = 'a'.repeat(64)
const OTHER_SECRET = 'b'.repeat(64)

function state(name: string): store.Persisted {
  return {
    identity: { pk: 'c'.repeat(64), skHex: 'd'.repeat(64) } as unknown as store.Identity,
    circles: [{ id: 'e'.repeat(64), name, seedHex: 'f'.repeat(64), mode: 'family', members: [] } as unknown as store.Circle],
    activeCircleId: 'e'.repeat(64),
    relayUrls: ['wss://relay.trotters.cc'],
    noReportZones: [],
    petnames: {},
    presence: {},
  }
}

beforeEach(() => {
  mem.clear()
  store.disarmRest()
})

describe('store — at-rest encryption (app lock)', () => {
  it('a save under an armed lock writes ciphertext, never the state', async () => {
    store.armRest(SECRET)
    store.save(state('Secret Squad'))
    await store.flushRest()
    const raw = localStorage.getItem('flock:v1') as string
    expect((JSON.parse(raw) as { locked?: number }).locked).toBe(1)
    for (const tell of ['Secret Squad', 'seedHex', 'identity', 'f'.repeat(64)]) {
      expect(raw).not.toContain(tell)
    }
  })

  it('openRest round-trips the state under the secret', async () => {
    store.armRest(SECRET)
    store.save(state('Secret Squad'))
    await store.flushRest()
    const back = await store.openRest(SECRET)
    expect(back.circles[0]?.name).toBe('Secret Squad')
    expect(back.identity?.pk).toBe('c'.repeat(64))
  })

  it('openRest rejects a wrong secret', async () => {
    store.armRest(SECRET)
    store.save(state('Secret Squad'))
    await store.flushRest()
    await expect(store.openRest(OTHER_SECRET)).rejects.toThrow()
  })

  it('load() sees a locked blob as a fresh device — no partial hydration of ciphertext', async () => {
    store.armRest(SECRET)
    store.save(state('Secret Squad'))
    await store.flushRest()
    store.disarmRest()
    const loaded = store.load()
    expect(loaded.identity).toBeNull()
    expect(loaded.circles).toEqual([])
    expect(store.lockedAtRest()).toBe(true)
  })

  it('rapid saves coalesce — the last state wins at rest', async () => {
    store.armRest(SECRET)
    store.save(state('one'))
    store.save(state('two'))
    store.save(state('three'))
    await store.flushRest()
    const back = await store.openRest(SECRET)
    expect(back.circles[0]?.name).toBe('three')
  })

  // SAFETY: a stray save before unlock must never clobber the ciphertext with
  // fresh plaintext — that would destroy the state the lock protects.
  it('a plaintext save while locked at rest is a no-op', async () => {
    store.armRest(SECRET)
    store.save(state('Secret Squad'))
    await store.flushRest()
    const sealed = localStorage.getItem('flock:v1')
    store.disarmRest()
    store.save(state('attacker visible'))
    expect(localStorage.getItem('flock:v1')).toBe(sealed)
  })

  it('sealOff deliberately rewrites plaintext (turning the lock off)', async () => {
    store.armRest(SECRET)
    store.save(state('Secret Squad'))
    await store.flushRest()
    store.sealOff(state('Secret Squad'))
    expect(store.lockedAtRest()).toBe(false)
    expect(store.load().circles[0]?.name).toBe('Secret Squad')
    // and saves stay plaintext afterwards
    store.save(state('still plain'))
    expect((JSON.parse(localStorage.getItem('flock:v1') as string) as store.Persisted).circles[0]?.name).toBe('still plain')
  })

  it('lockedAtRest is false for plaintext or an empty device', () => {
    expect(store.lockedAtRest()).toBe(false)
    store.save(state('plain'))
    expect(store.lockedAtRest()).toBe(false)
  })
})
