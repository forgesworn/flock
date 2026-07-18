import { describe, it, expect } from 'vitest'
import {
  createMeshBuffer,
  rememberMeshFrame,
  pruneMeshBuffer,
  liveMeshFrames,
  meshManifest,
  reconcileMeshManifests,
  meshFramesFor,
  MESH_BUFFER_DEFAULTS,
  type MeshBufferOptions,
  type MeshBufferState,
} from 'mesh-kit'

const testFrame = (data: string) => ({ kind: 'flock-gift-wrap', payload: data })
const remember = (
  state: MeshBufferState,
  entry: { id: string; data: string },
  now: number,
  options?: MeshBufferOptions,
) => rememberMeshFrame(state, { id: entry.id, frame: testFrame(entry.data) }, now, options)
const prune = (state: MeshBufferState, now: number, options?: MeshBufferOptions) =>
  pruneMeshBuffer(state, now, options)
const liveEntries = (state: MeshBufferState, now: number, options?: MeshBufferOptions) =>
  liveMeshFrames(state, now, options).map((entry) => ({
    id: entry.id,
    data: entry.frame.payload,
    storedAt: entry.storedAt,
  }))
const manifestOf = (state: MeshBufferState, now: number, options?: MeshBufferOptions) =>
  meshManifest(state, now, options)
const reconcile = reconcileMeshManifests
const entriesFor = (state: MeshBufferState, ids: readonly string[]) =>
  meshFramesFor(state, ids).map((entry) => ({
    id: entry.id,
    data: entry.frame.payload,
    storedAt: entry.storedAt,
  }))

const OPTS = { maxEntries: 3, ttlSeconds: 900 }

describe('remember (store-and-forward retention)', () => {
  it('starts empty', () => {
    const s = createMeshBuffer()
    expect(liveEntries(s, 0)).toEqual([])
    expect(manifestOf(s, 0)).toEqual([])
  })

  it('stores a wrap and makes it a live entry', () => {
    const s = remember(createMeshBuffer(), { id: 'a', data: 'wrap-a' }, 1000, OPTS)
    expect(liveEntries(s, 1000, OPTS)).toEqual([{ id: 'a', data: 'wrap-a', storedAt: 1000 }])
  })

  it('a duplicate id is a no-op (does not re-date or reorder it)', () => {
    let s = createMeshBuffer()
    s = remember(s, { id: 'a', data: 'wrap-a' }, 1000, OPTS)
    const before = s
    s = remember(s, { id: 'a', data: 'wrap-a-resent' }, 1500, OPTS)
    expect(s).toBe(before) // same state — pure no-op
    expect(liveEntries(s, 1500, OPTS)[0]).toEqual({ id: 'a', data: 'wrap-a', storedAt: 1000 })
  })

  it('is pure — never mutates the input state', () => {
    const s0 = createMeshBuffer()
    const s1 = remember(s0, { id: 'a', data: 'x' }, 1000, OPTS)
    expect(s0).not.toBe(s1)
    expect(liveEntries(s0, 1000, OPTS)).toEqual([])
    expect(liveEntries(s1, 1000, OPTS)).toHaveLength(1)
  })

  it('bounded ring buffer: evicts the OLDEST entry once maxEntries is exceeded', () => {
    let s = createMeshBuffer()
    s = remember(s, { id: 'a', data: 'a' }, 1000, OPTS)
    s = remember(s, { id: 'b', data: 'b' }, 1001, OPTS)
    s = remember(s, { id: 'c', data: 'c' }, 1002, OPTS)
    s = remember(s, { id: 'd', data: 'd' }, 1003, OPTS) // over maxEntries (3) — drops 'a'
    expect(manifestOf(s, 1003, OPTS)).toEqual(['b', 'c', 'd'].sort())
  })

  it('defaults match the design doc: 200 wraps / 15 min TTL', () => {
    expect(MESH_BUFFER_DEFAULTS).toEqual({ maxEntries: 200, ttlSeconds: 900 })
  })
})

describe('prune (TTL eviction)', () => {
  it('drops entries older than ttlSeconds', () => {
    let s = createMeshBuffer()
    s = remember(s, { id: 'a', data: 'a' }, 1000, OPTS)
    s = remember(s, { id: 'b', data: 'b' }, 1000 + 500, OPTS)
    const pruned = prune(s, 1000 + 901, OPTS) // 'a' is now 901s old (> 900 ttl)
    expect(manifestOf(pruned, 1000 + 901, OPTS)).toEqual(['b'])
  })

  it('keeps an entry exactly at the TTL boundary (< ttlSeconds, not <=)', () => {
    let s = createMeshBuffer()
    s = remember(s, { id: 'a', data: 'a' }, 1000, OPTS)
    expect(manifestOf(s, 1000 + 899, OPTS)).toEqual(['a'])
    expect(manifestOf(s, 1000 + 900, OPTS)).toEqual([])
  })

  it('returns the SAME state reference when nothing has expired (no needless churn)', () => {
    let s = createMeshBuffer()
    s = remember(s, { id: 'a', data: 'a' }, 1000, OPTS)
    const pruned = prune(s, 1000 + 10, OPTS)
    expect(pruned).toBe(s)
  })

  it('remember() implicitly prunes before inserting, so TTL and the ring cap compose', () => {
    let s = createMeshBuffer()
    s = remember(s, { id: 'a', data: 'a' }, 1000, OPTS)
    s = remember(s, { id: 'b', data: 'b' }, 1000 + 901, OPTS) // 'a' has now expired
    expect(manifestOf(s, 1000 + 901, OPTS)).toEqual(['b'])
  })
})

describe('manifestOf (compact id manifest for peer reconcile)', () => {
  it('is sorted, order-independent of insertion order', () => {
    let s1 = createMeshBuffer()
    s1 = remember(s1, { id: 'b', data: 'b' }, 1000, OPTS)
    s1 = remember(s1, { id: 'a', data: 'a' }, 1001, OPTS)
    let s2 = createMeshBuffer()
    s2 = remember(s2, { id: 'a', data: 'a' }, 1000, OPTS)
    s2 = remember(s2, { id: 'b', data: 'b' }, 1001, OPTS)
    expect(manifestOf(s1, 1002, OPTS)).toEqual(manifestOf(s2, 1002, OPTS))
  })

  it('excludes expired entries', () => {
    let s = createMeshBuffer()
    s = remember(s, { id: 'a', data: 'a' }, 1000, OPTS)
    expect(manifestOf(s, 1000 + 1000, OPTS)).toEqual([])
  })
})

describe('reconcile (sorted id-list diff — the v2 manifest exchange)', () => {
  it('everything I have that they lack goes in toSend; everything they have that I lack goes in toRequest', () => {
    const mine = ['a', 'b', 'c']
    const theirs = ['b', 'c', 'd']
    expect(reconcile(mine, theirs)).toEqual({ toSend: ['a'], toRequest: ['d'] })
  })

  it('identical manifests reconcile to nothing either way', () => {
    expect(reconcile(['a', 'b'], ['a', 'b'])).toEqual({ toSend: [], toRequest: [] })
  })

  it('an empty peer manifest means I should send everything I have', () => {
    expect(reconcile(['a', 'b'], [])).toEqual({ toSend: ['a', 'b'], toRequest: [] })
  })

  it('an empty local manifest means I should request everything they have', () => {
    expect(reconcile([], ['a', 'b'])).toEqual({ toSend: [], toRequest: ['a', 'b'] })
  })

  it('two empty manifests reconcile to nothing', () => {
    expect(reconcile([], [])).toEqual({ toSend: [], toRequest: [] })
  })
})

describe('entriesFor (resolve ids from reconcile into actual wraps to send)', () => {
  it('returns the entries for the given ids, in the ids order', () => {
    let s = createMeshBuffer()
    s = remember(s, { id: 'a', data: 'wrap-a' }, 1000, OPTS)
    s = remember(s, { id: 'b', data: 'wrap-b' }, 1001, OPTS)
    expect(entriesFor(s, ['b', 'a'])).toEqual([
      { id: 'b', data: 'wrap-b', storedAt: 1001 },
      { id: 'a', data: 'wrap-a', storedAt: 1000 },
    ])
  })

  it('silently skips an id no longer held (already evicted/expired)', () => {
    let s = createMeshBuffer()
    s = remember(s, { id: 'a', data: 'wrap-a' }, 1000, OPTS)
    expect(entriesFor(s, ['a', 'ghost'])).toEqual([{ id: 'a', data: 'wrap-a', storedAt: 1000 }])
  })
})

// End-to-end: two devices' buffers reconcile down to nothing outstanding after
// one round of exchange — the property that makes "a phone walking into range
// later gets the backlog" actually work.
describe('end-to-end reconcile round-trip', () => {
  it('after A sends what B is missing and B sends what A is missing, both hold the union', () => {
    let a: MeshBufferState = createMeshBuffer()
    a = remember(a, { id: '1', data: 'one' }, 1000, OPTS)
    a = remember(a, { id: '2', data: 'two' }, 1001, OPTS)
    let b: MeshBufferState = createMeshBuffer()
    b = remember(b, { id: '2', data: 'two' }, 1000, OPTS)
    b = remember(b, { id: '3', data: 'three' }, 1001, OPTS)

    const now = 1002
    const diffFromA = reconcile(manifestOf(a, now, OPTS), manifestOf(b, now, OPTS))
    const diffFromB = reconcile(manifestOf(b, now, OPTS), manifestOf(a, now, OPTS))

    // A sends '1' to B; B sends '3' to A.
    for (const e of entriesFor(a, diffFromA.toSend)) b = remember(b, e, now, OPTS)
    for (const e of entriesFor(b, diffFromB.toSend)) a = remember(a, e, now, OPTS)

    expect(manifestOf(a, now, OPTS)).toEqual(['1', '2', '3'])
    expect(manifestOf(b, now, OPTS)).toEqual(['1', '2', '3'])
  })
})
