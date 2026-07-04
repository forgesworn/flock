import { describe, it, expect, vi, beforeEach } from 'vitest'

// A minimal localStorage for Node (mirrors store.rest.test.ts's stub) — the
// profile cache persists across renders via localStorage.
const mem = new Map<string, string>()
globalThis.localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  removeItem: (k: string) => { mem.delete(k) },
  clear: () => mem.clear(),
  key: () => null,
  length: 0,
} as unknown as Storage

// profiles.ts calls window.setTimeout (the app's usual timer, mirrored across
// app.ts) — stub a passthrough so this browser-only module runs in Node.
globalThis.window = { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) } as unknown as Window & typeof globalThis

type ProfileEvent = { pubkey: string; content: string; created_at: number }
type SubscribeProfilesFn = (relays: readonly string[], pubkeys: string[], onEvent: (e: ProfileEvent) => void) => () => void

const subscribeProfilesMock = vi.fn<SubscribeProfilesFn>(() => () => { /* noop unsubscribe */ })
vi.mock('./services', () => ({
  subscribeProfiles: (...args: Parameters<SubscribeProfilesFn>) => subscribeProfilesMock(...args),
}))

const PK_A = 'a'.repeat(64)
const PK_B = 'b'.repeat(64)
const PK_C = 'c'.repeat(64)

// The module keeps an in-memory cache + a `loaded` flag, so each test needs a
// fresh module instance (mirroring localStorage being cleared too).
async function freshProfiles() {
  vi.resetModules()
  return import('./profiles')
}

beforeEach(() => {
  mem.clear()
  subscribeProfilesMock.mockReset()
  subscribeProfilesMock.mockImplementation(() => () => { /* noop unsubscribe */ })
})

describe('fetchProfiles — per-pubkey REQs (audit F3: unbatch the roster)', () => {
  it('issues one subscribeProfiles call PER pubkey — never one batched authors filter', async () => {
    const { fetchProfiles } = await freshProfiles()
    fetchProfiles([PK_A, PK_B, PK_C], () => { /* noop */ })
    expect(subscribeProfilesMock).toHaveBeenCalledTimes(3)
    for (const call of subscribeProfilesMock.mock.calls) expect(call[1]).toHaveLength(1)
    const requested = subscribeProfilesMock.mock.calls.map((c) => c[1][0]).sort()
    expect(requested).toEqual([PK_A, PK_B, PK_C].sort())
  })

  it('skips a pubkey already cached from an earlier fetch — no REQ at all for it', async () => {
    const { fetchProfiles } = await freshProfiles()
    subscribeProfilesMock.mockImplementation((_relays, pks, onEvent) => {
      onEvent({ pubkey: pks[0] as string, content: JSON.stringify({ name: 'Alex' }), created_at: 1 })
      return () => { /* noop */ }
    })
    fetchProfiles([PK_A], () => { /* noop */ })
    subscribeProfilesMock.mockClear()

    fetchProfiles([PK_A, PK_B], () => { /* noop */ })
    expect(subscribeProfilesMock).toHaveBeenCalledTimes(1)
    expect(subscribeProfilesMock.mock.calls[0]?.[1]).toEqual([PK_B])
  })

  it('is a complete no-op once every requested pubkey is cached', async () => {
    const { fetchProfiles } = await freshProfiles()
    fetchProfiles([PK_A], () => { /* noop */ })
    subscribeProfilesMock.mockClear()
    fetchProfiles([PK_A], () => { /* noop */ })
    expect(subscribeProfilesMock).not.toHaveBeenCalled()
  })

  it('ignores non-hex-pubkey junk without issuing any REQ', async () => {
    const { fetchProfiles } = await freshProfiles()
    fetchProfiles(['not-a-pubkey', 'also bad'], () => { /* noop */ })
    expect(subscribeProfilesMock).not.toHaveBeenCalled()
  })

  it('still surfaces a real hit via getProfile once its per-pubkey REQ answers', async () => {
    const { fetchProfiles, getProfile } = await freshProfiles()
    subscribeProfilesMock.mockImplementation((_relays, pks, onEvent) => {
      onEvent({ pubkey: pks[0] as string, content: JSON.stringify({ name: 'Alex', picture: 'https://example.com/a.jpg' }), created_at: 1 })
      return () => { /* noop */ }
    })
    let updated = false
    fetchProfiles([PK_A], () => { updated = true })
    expect(updated).toBe(true)
    expect(getProfile(PK_A)).toEqual({ name: 'Alex', picture: 'https://example.com/a.jpg' })
  })
})
