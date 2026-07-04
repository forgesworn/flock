import { afterEach, describe, expect, it } from 'vitest'
import { createMockRunner, createRoomsApp } from './rooms.mjs'

const apps = []

async function startApp() {
  const app = createRoomsApp({ runner: createMockRunner(), publicBaseUrl: 'https://rooms.example' })
  apps.push(app)
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  const addr = app.server.address()
  return { app, base: `http://127.0.0.1:${addr.port}` }
}

afterEach(async () => {
  while (apps.length) await apps.pop().close()
})

describe('relay rooms service', () => {
  it('creates short-lived rooms without persisting creator identity', async () => {
    const { app, base } = await startApp()
    const res = await fetch(`${base}/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ttlSeconds: 120 }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.roomId).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(body.adminToken).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(body.relayUrl).toBe(`wss://rooms.example/r/${body.roomId}`)
    const room = app.rooms.get(body.roomId)
    expect(room).toMatchObject({ relayUrl: body.relayUrl })
    expect(room.adminToken).toBeUndefined()
    expect(Buffer.isBuffer(room.adminDigest)).toBe(true)
  })

  it('burns a room only with the admin token', async () => {
    const { app, base } = await startApp()
    const created = await (await fetch(`${base}/rooms`, { method: 'POST' })).json()

    const denied = await fetch(`${base}/rooms/${created.roomId}`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer wrong' },
    })
    expect(denied.status).toBe(403)
    expect(app.rooms.has(created.roomId)).toBe(true)

    const burned = await fetch(`${base}/rooms/${created.roomId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${created.adminToken}` },
    })
    expect(burned.status).toBe(204)
    expect(app.rooms.has(created.roomId)).toBe(false)
  })

  it('reports only aggregate health', async () => {
    const { base } = await startApp()
    await fetch(`${base}/rooms`, { method: 'POST' })
    const health = await (await fetch(`${base}/healthz`)).json()
    expect(health).toEqual({ ok: true, activeRooms: 1 })
  })

  it('handles malformed create requests without starting a room', async () => {
    const { app, base } = await startApp()
    const res = await fetch(`${base}/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid JSON' })
    expect(app.rooms.size).toBe(0)
  })
})
