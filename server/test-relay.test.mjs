import { afterEach, describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey } from 'nostr-tools'
import WebSocket from 'ws'
import { createTestRelay, matchesFilter } from '../scripts/test-relay.mjs'

let relay

afterEach(async () => {
  if (relay) await relay.close()
  relay = undefined
})

const event = (overrides = {}) => ({
  id: 'a'.repeat(64),
  pubkey: 'b'.repeat(64),
  kind: 1059,
  created_at: 1_000,
  tags: [['p', 'c'.repeat(64)], ['expiration', '9999999999']],
  content: 'ciphertext',
  sig: 'd'.repeat(128),
  ...overrides,
})

const secretKey = generateSecretKey()
const signedEvent = (overrides = {}) => finalizeEvent({
  kind: 1059,
  created_at: 1_000,
  tags: [['p', 'c'.repeat(64)], ['expiration', '9999999999']],
  content: 'ciphertext',
  ...overrides,
}, secretKey)

describe('test relay filters', () => {
  it('matches prefixes, time bounds, kinds, and tag filters', () => {
    expect(matchesFilter(event(), {
      ids: ['aaaa'],
      authors: ['bbbb'],
      kinds: [1059],
      since: 999,
      until: 1_001,
      '#p': ['c'.repeat(64)],
    })).toBe(true)
    expect(matchesFilter(event(), { '#p': ['e'.repeat(64)] })).toBe(false)
  })

  it('stores, replays, and deletes events over the WebSocket protocol', async () => {
    relay = createTestRelay({ port: 0 })
    const port = await relay.listen()
    const socket = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise((resolve) => socket.once('open', resolve))

    const messages = []
    socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())))
    const stored = signedEvent()
    socket.send(JSON.stringify(['EVENT', stored]))
    await expect.poll(() => messages.some((message) => message[0] === 'OK')).toBe(true)

    socket.send(JSON.stringify(['REQ', 'stored', { kinds: [1059] }]))
    await expect.poll(() => messages.some((message) => message[0] === 'EOSE')).toBe(true)
    expect(messages.some((message) => message[0] === 'EVENT' && message[1] === 'stored')).toBe(true)

    socket.send(JSON.stringify(['EVENT', signedEvent({ kind: 5, tags: [['e', stored.id]] })]))
    await expect.poll(() => relay.events.has(stored.id)).toBe(false)
    socket.close()
  })
})
