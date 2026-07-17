#!/usr/bin/env node
// Minimal in-memory Nostr relay for deterministic end-to-end tests.
//
// This is deliberately test infrastructure, not a production relay. It keeps
// accepted events in RAM for the lifetime of the process, supports the NIP-01
// filters Flock uses, honours NIP-09 deletions and NIP-40 expiry, and never
// opens a connection outside the local machine.

import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { verifyEvent } from 'nostr-tools'
import { WebSocket, WebSocketServer } from 'ws'

function eventExpiry(event) {
  const tag = event.tags?.find((candidate) => candidate[0] === 'expiration')
  const value = Number(tag?.[1])
  return Number.isFinite(value) ? value : null
}

function isExpired(event, now = Math.floor(Date.now() / 1000)) {
  const expiry = eventExpiry(event)
  return expiry !== null && expiry <= now
}

function hasTag(event, name, values) {
  return event.tags?.some((tag) =>
    tag[0] === name && tag.slice(1).some((value) => values.includes(value)),
  ) ?? false
}

export function matchesFilter(event, filter) {
  if (filter.ids?.length && !filter.ids.some((prefix) => event.id.startsWith(prefix))) return false
  if (filter.authors?.length && !filter.authors.some((prefix) => event.pubkey.startsWith(prefix))) return false
  if (filter.kinds?.length && !filter.kinds.includes(event.kind)) return false
  if (filter.since !== undefined && event.created_at < filter.since) return false
  if (filter.until !== undefined && event.created_at > filter.until) return false

  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith('#') || !Array.isArray(values)) continue
    if (!hasTag(event, key.slice(1), values)) return false
  }
  return true
}

function isEvent(value) {
  return value !== null && typeof value === 'object' &&
    typeof value.id === 'string' && typeof value.pubkey === 'string' &&
    Number.isInteger(value.kind) && Number.isInteger(value.created_at) &&
    Array.isArray(value.tags) && typeof value.content === 'string' &&
    typeof value.sig === 'string' && verifyEvent(value)
}

function isEphemeral(event) {
  return event.kind >= 20_000 && event.kind < 30_000
}

function replaceableKey(event) {
  if (event.kind === 0 || event.kind === 3 || (event.kind >= 10_000 && event.kind < 20_000)) {
    return `${event.pubkey}:${event.kind}`
  }
  if (event.kind >= 30_000 && event.kind < 40_000) {
    const d = event.tags.find((tag) => tag[0] === 'd')?.[1] ?? ''
    return `${event.pubkey}:${event.kind}:${d}`
  }
  return null
}

export function createTestRelay({ host = '127.0.0.1', port = 7777 } = {}) {
  const events = new Map()
  const subscriptions = new Map()
  const server = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: true, events: events.size }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/nostr+json' })
    res.end(JSON.stringify({ name: 'flock test relay', supported_nips: [1, 9, 40] }))
  })
  const sockets = new WebSocketServer({ server })

  const send = (socket, message) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }

  const prune = () => {
    for (const [id, event] of events) if (isExpired(event)) events.delete(id)
  }

  const broadcast = (event) => {
    for (const [socket, byId] of subscriptions) {
      for (const [subscriptionId, filters] of byId) {
        if (filters.some((filter) => matchesFilter(event, filter))) {
          send(socket, ['EVENT', subscriptionId, event])
        }
      }
    }
  }

  const store = (event) => {
    const key = replaceableKey(event)
    if (key) {
      for (const [id, previous] of events) {
        if (replaceableKey(previous) === key && previous.created_at <= event.created_at) events.delete(id)
      }
    }
    events.set(event.id, event)
  }

  const deleteReferencedEvents = (event) => {
    for (const tag of event.tags) {
      if (tag[0] !== 'e' || typeof tag[1] !== 'string') continue
      const target = events.get(tag[1])
      if (target?.pubkey === event.pubkey) events.delete(tag[1])
    }
  }

  sockets.on('connection', (socket) => {
    subscriptions.set(socket, new Map())
    socket.on('close', () => subscriptions.delete(socket))
    socket.on('message', (raw) => {
      let message
      try { message = JSON.parse(raw.toString()) } catch {
        send(socket, ['NOTICE', 'invalid JSON'])
        return
      }
      if (!Array.isArray(message)) return
      prune()

      if (message[0] === 'EVENT') {
        const event = message[1]
        if (!isEvent(event) || isExpired(event)) {
          send(socket, ['OK', event?.id ?? '', false, 'invalid: event rejected'])
          return
        }
        if (event.kind === 5) deleteReferencedEvents(event)
        if (!isEphemeral(event)) store(event)
        broadcast(event)
        send(socket, ['OK', event.id, true, ''])
        return
      }

      if (message[0] === 'REQ' && typeof message[1] === 'string') {
        const subscriptionId = message[1]
        const filters = message.slice(2).filter((filter) => filter && typeof filter === 'object')
        subscriptions.get(socket)?.set(subscriptionId, filters)
        const sent = new Set()
        const ordered = [...events.values()].sort((a, b) => b.created_at - a.created_at)
        for (const filter of filters) {
          let count = 0
          for (const event of ordered) {
            if (sent.has(event.id) || !matchesFilter(event, filter)) continue
            send(socket, ['EVENT', subscriptionId, event])
            sent.add(event.id)
            count += 1
            if (Number.isInteger(filter.limit) && count >= filter.limit) break
          }
        }
        send(socket, ['EOSE', subscriptionId])
        return
      }

      if (message[0] === 'CLOSE' && typeof message[1] === 'string') {
        subscriptions.get(socket)?.delete(message[1])
      }
    })
  })

  return {
    events,
    server,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.off('error', reject)
        const address = server.address()
        resolve(typeof address === 'object' && address ? address.port : port)
      })
    }),
    close: () => new Promise((resolve) => {
      for (const socket of sockets.clients) socket.terminate()
      sockets.close(() => server.close(resolve))
    }),
  }
}

function option(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = option('--host', process.env.FLOCK_TEST_RELAY_HOST ?? '127.0.0.1')
  const port = Number(option('--port', process.env.FLOCK_TEST_RELAY_PORT ?? '7777'))
  const relay = createTestRelay({ host, port })
  await relay.listen()
  console.error(`flock test relay on ws://${host}:${port}`)
  const stop = async () => {
    await relay.close()
    process.exit(0)
  }
  process.once('SIGINT', () => { void stop() })
  process.once('SIGTERM', () => { void stop() })
}
