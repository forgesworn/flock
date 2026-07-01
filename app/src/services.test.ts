import { describe, it, expect } from 'vitest'
import { deliveredCount, RELAY_TIMEOUT } from './services'

const ok = (v: unknown): PromiseSettledResult<unknown> => ({ status: 'fulfilled', value: v })
const rej = (r: unknown): PromiseSettledResult<unknown> => ({ status: 'rejected', reason: r })

describe('deliveredCount', () => {
  it('counts a plain fulfilled publish (relay accepted) as delivered', () => {
    expect(deliveredCount([ok(''), ok('accepted')])).toBe(2)
  })

  it('does NOT count a "connection failure" resolution — the pool resolves (not rejects) when a relay is unreachable', () => {
    expect(deliveredCount([ok('connection failure: ws://down.example')])).toBe(0)
  })

  it('does NOT count our timeout sentinel', () => {
    expect(deliveredCount([ok(RELAY_TIMEOUT)])).toBe(0)
  })

  it('does NOT count a rejected publish (relay refused the event)', () => {
    expect(deliveredCount([rej(new Error('blocked: pow required'))])).toBe(0)
  })

  it('counts only the relay that genuinely accepted, in a mixed fan-out', () => {
    expect(deliveredCount([ok(''), ok('connection failure: x'), rej('nope'), ok(RELAY_TIMEOUT)])).toBe(1)
  })

  it('treats an empty/undefined fulfilled value as accepted (relays often ack with no reason)', () => {
    expect(deliveredCount([ok(undefined), ok(null)])).toBe(2)
  })
})
