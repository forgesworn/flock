import { describe, it, expect, vi, afterEach } from 'vitest'
import { deliveredCount, RELAY_TIMEOUT, currentPosition, pollLocation } from './services'

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

describe('currentPosition', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('resolves a Fix from the browser geolocation (seconds, not millis)', async () => {
    vi.stubGlobal('navigator', {
      geolocation: {
        getCurrentPosition: (success: PositionCallback) =>
          success({ coords: { latitude: 51.5, longitude: -0.12, accuracy: 12 }, timestamp: 1_700_000_000_000 } as GeolocationPosition),
      },
    })
    // No heading/speed on a stationary/coarse fix → null, never a fabricated 0.
    expect(await currentPosition()).toEqual({ lat: 51.5, lon: -0.12, accuracy: 12, at: 1_700_000_000, heading: null, speed: null })
  })

  it('captures a valid GPS course + speed but rejects non-finite/negative sentinels', async () => {
    vi.stubGlobal('navigator', {
      geolocation: {
        getCurrentPosition: (success: PositionCallback) =>
          success({ coords: { latitude: 51.5, longitude: -0.12, accuracy: 8, heading: 200, speed: 6 }, timestamp: 1_700_000_000_000 } as GeolocationPosition),
      },
    })
    expect(await currentPosition()).toEqual({ lat: 51.5, lon: -0.12, accuracy: 8, at: 1_700_000_000, heading: 200, speed: 6 })

    vi.stubGlobal('navigator', {
      geolocation: {
        getCurrentPosition: (success: PositionCallback) =>
          success({ coords: { latitude: 51.5, longitude: -0.12, accuracy: 8, heading: NaN, speed: -1 }, timestamp: 1_700_000_000_000 } as GeolocationPosition),
      },
    })
    const f = await currentPosition()
    expect(f?.heading).toBeNull()
    expect(f?.speed).toBeNull()
  })

  it('resolves null (never rejects) when permission is denied', async () => {
    vi.stubGlobal('navigator', {
      geolocation: { getCurrentPosition: (_: PositionCallback, error: PositionErrorCallback) => error({ code: 1, message: 'denied' } as GeolocationPositionError) },
    })
    expect(await currentPosition()).toBeNull()
  })

  it('resolves null when geolocation is unavailable', async () => {
    vi.stubGlobal('navigator', {})
    expect(await currentPosition()).toBeNull()
  })
})

describe('pollLocation', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

  const stubGeo = (getCurrentPosition: Geolocation['getCurrentPosition']): void => {
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } })
  }

  it('keeps polling after a transient error instead of stopping forever', async () => {
    vi.useFakeTimers()
    let calls = 0
    const fixes: unknown[] = []
    const errors: string[] = []
    // First fix times out (a transient error), then subsequent fixes succeed.
    stubGeo((success, error) => {
      calls += 1
      if (calls === 1) { (error as PositionErrorCallback)({ code: 3, message: 'timeout' } as GeolocationPositionError); return }
      success({ coords: { latitude: 51.5, longitude: -0.12, accuracy: 20 }, timestamp: 1_700_000_000_000 } as GeolocationPosition)
    })

    const stop = pollLocation((f) => fixes.push(f), (msg) => errors.push(msg), { nextDelayMs: () => 60_000 })

    // The immediate first sample errored — before this fix the loop would end here.
    expect(calls).toBe(1)
    expect(errors).toHaveLength(1)
    expect(fixes).toHaveLength(0)

    // After the error-retry cadence the poll must fire again and get a fix.
    await vi.advanceTimersByTimeAsync(15_000)
    expect(calls).toBe(2)
    expect(fixes).toHaveLength(1)
    stop()
  })

  it('does not reschedule after stop()', async () => {
    vi.useFakeTimers()
    let calls = 0
    stubGeo((_success, error) => { calls += 1; (error as PositionErrorCallback)({ code: 3, message: 'timeout' } as GeolocationPositionError) })

    const stop = pollLocation(() => {}, () => {}, { nextDelayMs: () => 60_000 })
    expect(calls).toBe(1)
    stop() // permanent teardown — the pending retry must not fire
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toBe(1)
  })
})
