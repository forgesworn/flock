#!/usr/bin/env node
// flock relay rooms — short-lived, RAM-only relay room control plane.
//
// This process does not store user data. Active room state lives in memory only:
// room id, admin token hash, expiry, and the backend address returned by the
// runner. The runner is deliberately external so production can use Firecracker
// microVMs while tests use an in-memory mock.
//
// HTTP:
//   GET    /healthz              → service status
//   POST   /rooms                → create a room
//   DELETE /rooms/:id            → burn a room; Authorization: Bearer <adminToken>
//   WS     /r/:id                → raw WebSocket proxy to that room's relay
//
// Production runner contract:
//   FLOCK_ROOM_RUNNER=external
//   FLOCK_ROOM_START_CMD=/opt/flock-rooms/start-room
//   The command receives the room spec as JSON on stdin and must print one JSON
//   line on stdout: {"backendHost":"127.0.0.1","backendPort":12345}

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import net from 'node:net'
import { pathToFileURL } from 'node:url'

const DEFAULT_HOST = process.env.HOST ?? '127.0.0.1'
const DEFAULT_PORT = Number(process.env.PORT ?? 8792)
const DEFAULT_PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? `http://${DEFAULT_HOST}:${DEFAULT_PORT}`
const DEFAULT_TTL_SECONDS = Number(process.env.FLOCK_ROOM_DEFAULT_TTL_SECONDS ?? 6 * 60 * 60)
const MAX_TTL_SECONDS = Number(process.env.FLOCK_ROOM_MAX_TTL_SECONDS ?? 7 * 24 * 60 * 60)
const MAX_ROOMS = Number(process.env.FLOCK_ROOM_MAX_ROOMS ?? 128)
const CREATE_RATE_MAX = Number(process.env.FLOCK_ROOM_CREATE_RATE_MAX ?? 12)
const CREATE_RATE_WINDOW_MS = Number(process.env.FLOCK_ROOM_CREATE_RATE_WINDOW_SECONDS ?? 10 * 60) * 1000
const MAX_BODY_BYTES = 4096

function json(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': bytes.length,
  }).end(bytes)
}

function noStore(res, status = 204) {
  res.writeHead(status, { 'cache-control': 'no-store' }).end()
}

function roomId() {
  return randomBytes(16).toString('base64url')
}

function adminToken() {
  return randomBytes(32).toString('base64url')
}

function hashSecret(secret) {
  return createHash('sha256').update(secret).digest()
}

function sameSecret(candidate, digest) {
  const got = hashSecret(candidate)
  return got.length === digest.length && timingSafeEqual(got, digest)
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > MAX_BODY_BYTES) {
        reject(new Error('request too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (!raw.trim()) { resolve({}); return }
      try { resolve(JSON.parse(raw)) } catch { reject(new Error('invalid JSON')) }
    })
    req.on('error', reject)
  })
}

function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}

function roomPath(pathname) {
  const m = pathname.match(/^\/(?:rooms|r)\/([A-Za-z0-9_-]{12,80})$/)
  return m?.[1] ?? null
}

function bearer(req) {
  const h = String(req.headers.authorization ?? '')
  const m = h.match(/^Bearer\s+(.+)$/i)
  return m?.[1] ?? ''
}

function clientBucket(req, salt) {
  const ip = req.socket.remoteAddress ?? ''
  return createHash('sha256').update(salt).update(ip).digest('base64url')
}

function createRateLimiter() {
  const salt = randomBytes(16)
  const buckets = new Map()
  return (req) => {
    const key = clientBucket(req, salt)
    const now = Date.now()
    const hits = (buckets.get(key) ?? []).filter((t) => now - t < CREATE_RATE_WINDOW_MS)
    if (hits.length >= CREATE_RATE_MAX) {
      buckets.set(key, hits)
      return true
    }
    hits.push(now)
    buckets.set(key, hits)
    if (buckets.size > 10_000) {
      for (const [k, v] of buckets) if (!v.some((t) => now - t < CREATE_RATE_WINDOW_MS)) buckets.delete(k)
    }
    return false
  }
}

function publicRelayUrl(baseUrl, id) {
  const u = new URL(baseUrl)
  u.pathname = `/r/${id}`
  u.search = ''
  u.hash = ''
  u.protocol = u.protocol === 'https:' ? 'wss:' : u.protocol === 'http:' ? 'ws:' : u.protocol
  return u.toString()
}

function sanitizeCreate(body) {
  const input = body && typeof body === 'object' ? body : {}
  const ttlSeconds = clampInt(input.ttlSeconds, DEFAULT_TTL_SECONDS, 60, MAX_TTL_SECONDS)
  return {
    ttlSeconds,
    limits: {
      maxConnections: clampInt(input.maxConnections, 32, 1, 512),
      maxEvents: clampInt(input.maxEvents, 10_000, 100, 250_000),
      maxEventBytes: clampInt(input.maxEventBytes, 65_536, 1024, 262_144),
      messagesPerSecond: clampInt(input.messagesPerSecond, 25, 1, 250),
    },
  }
}

export function createExternalRunner(opts = {}) {
  const startCmd = opts.startCmd ?? process.env.FLOCK_ROOM_START_CMD
  if (!startCmd) throw new Error('FLOCK_ROOM_START_CMD is required when FLOCK_ROOM_RUNNER=external')
  const startTimeoutMs = Number(opts.startTimeoutMs ?? process.env.FLOCK_ROOM_START_TIMEOUT_MS ?? 15_000)
  return {
    async start(spec) {
      const child = spawn(startCmd, {
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          FLOCK_ROOM_ID: spec.id,
          FLOCK_ROOM_EXPIRES_AT: String(spec.expiresAt),
          FLOCK_ROOM_SPEC: JSON.stringify(spec),
        },
      })
      child.stdin.end(JSON.stringify(spec))
      const line = await new Promise((resolve, reject) => {
        let out = ''
        let err = ''
        const timer = setTimeout(() => reject(new Error('room runner start timed out')), startTimeoutMs)
        child.stdout.on('data', (b) => {
          out += b
          const i = out.indexOf('\n')
          if (i >= 0) {
            clearTimeout(timer)
            resolve(out.slice(0, i))
          }
        })
        child.stderr.on('data', (b) => { err += b.toString().slice(0, 1024) })
        child.on('error', (e) => { clearTimeout(timer); reject(e) })
        child.on('exit', (code) => {
          clearTimeout(timer)
          if (!out.trim()) reject(new Error(`room runner exited before ready (${code ?? 'signal'}): ${err.slice(0, 200)}`))
        })
      })
      const ready = JSON.parse(line)
      if (typeof ready.backendHost !== 'string' || !Number.isInteger(ready.backendPort)) {
        throw new Error('room runner did not return backendHost/backendPort')
      }
      return {
        backendHost: ready.backendHost,
        backendPort: ready.backendPort,
        async stop() {
          if (!child.killed) child.kill('SIGTERM')
        },
      }
    },
  }
}

export function createMockRunner() {
  return {
    async start() {
      const relay = createServer((req, res) => {
        if (req.url === '/healthz') { res.writeHead(200).end('ok'); return }
        res.writeHead(404).end()
      })
      relay.on('upgrade', (_req, socket) => {
        socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
      })
      await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve))
      const addr = relay.address()
      return {
        backendHost: '127.0.0.1',
        backendPort: addr.port,
        async stop() {
          await new Promise((resolve) => relay.close(resolve))
        },
      }
    },
  }
}

function runnerFromEnv() {
  const mode = process.env.FLOCK_ROOM_RUNNER ?? 'external'
  if (mode === 'mock') return createMockRunner()
  if (mode === 'external') return createExternalRunner()
  throw new Error(`unknown FLOCK_ROOM_RUNNER: ${mode}`)
}

export function createRoomsApp(opts = {}) {
  const rooms = new Map()
  const runner = opts.runner ?? runnerFromEnv()
  const publicBaseUrl = opts.publicBaseUrl ?? DEFAULT_PUBLIC_BASE_URL
  const rateLimited = createRateLimiter()
  let sweepTimer

  async function stopRoom(id, reason = 'burned') {
    const room = rooms.get(id)
    if (!room) return false
    rooms.delete(id)
    clearTimeout(room.timer)
    try { await room.instance.stop(reason) } catch { /* best-effort teardown */ }
    return true
  }

  async function createRoom(req, res) {
    if (rooms.size >= MAX_ROOMS) { json(res, 503, { error: 'room capacity reached' }); return }
    if (rateLimited(req)) { json(res, 429, { error: 'too many rooms from this connection; try again later' }); return }
    let body
    try { body = await parseJsonBody(req) } catch (err) { json(res, err.message === 'request too large' ? 413 : 400, { error: err.message }); return }
    const now = Math.floor(Date.now() / 1000)
    const id = roomId()
    const token = adminToken()
    const clean = sanitizeCreate(body)
    const spec = { id, createdAt: now, expiresAt: now + clean.ttlSeconds, limits: clean.limits }
    let instance
    try {
      instance = await runner.start(spec)
    } catch (err) {
      json(res, 502, { error: `could not start relay room: ${err.message ?? err}` })
      return
    }
    const room = {
      ...spec,
      adminDigest: hashSecret(token),
      relayUrl: publicRelayUrl(publicBaseUrl, id),
      backendHost: instance.backendHost,
      backendPort: instance.backendPort,
      instance,
      timer: setTimeout(() => { void stopRoom(id, 'expired') }, Math.max(1, spec.expiresAt - now) * 1000),
    }
    rooms.set(id, room)
    json(res, 201, {
      roomId: id,
      relayUrl: room.relayUrl,
      expiresAt: room.expiresAt,
      ttlSeconds: room.expiresAt - now,
      adminToken: token,
      burnUrl: new URL(`/rooms/${id}`, publicBaseUrl).toString(),
    })
  }

  async function burnRoom(req, res, id) {
    const room = rooms.get(id)
    if (!room) { noStore(res, 404); return }
    if (!sameSecret(bearer(req), room.adminDigest)) { noStore(res, 403); return }
    await stopRoom(id, 'burned')
    noStore(res, 204)
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    res.setHeader('x-content-type-options', 'nosniff')
    if (req.method === 'GET' && url.pathname === '/healthz') {
      json(res, 200, { ok: true, activeRooms: rooms.size })
      return
    }
    if (req.method === 'POST' && url.pathname === '/rooms') {
      void createRoom(req, res)
      return
    }
    const id = roomPath(url.pathname)
    if (req.method === 'DELETE' && id) {
      void burnRoom(req, res, id)
      return
    }
    noStore(res, 404)
  })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const id = roomPath(url.pathname)
    const room = id ? rooms.get(id) : null
    if (!room) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    const upstream = net.connect(room.backendPort, room.backendHost)
    upstream.on('connect', () => {
      const headers = { ...req.headers, host: `${room.backendHost}:${room.backendPort}` }
      delete headers['x-forwarded-for']
      delete headers['x-real-ip']
      const lines = [`${req.method} / HTTP/${req.httpVersion}`]
      for (const [k, v] of Object.entries(headers)) {
        if (Array.isArray(v)) for (const each of v) lines.push(`${k}: ${each}`)
        else if (v !== undefined) lines.push(`${k}: ${v}`)
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    upstream.on('error', () => {
      socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
      socket.destroy()
    })
  })

  async function close() {
    clearInterval(sweepTimer)
    await Promise.all([...rooms.keys()].map((id) => stopRoom(id, 'shutdown')))
    await new Promise((resolve) => server.close(resolve))
  }

  function listen(port = DEFAULT_PORT, host = DEFAULT_HOST) {
    sweepTimer = setInterval(() => {
      const now = Math.floor(Date.now() / 1000)
      for (const room of rooms.values()) if (room.expiresAt <= now) void stopRoom(room.id, 'expired')
    }, 30_000)
    server.listen(port, host, () => {
      console.error(`flock relay rooms on ${host}:${port} (runner=${process.env.FLOCK_ROOM_RUNNER ?? 'external'}, maxRooms=${MAX_ROOMS})`)
    })
    return server
  }

  return { server, rooms, listen, close, stopRoom }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createRoomsApp().listen()
}
