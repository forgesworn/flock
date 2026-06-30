import { describe, it, expect } from 'vitest'
import * as flock from './index.js'

describe('barrel exports', () => {
  it('re-exports flock geofence helpers', () => {
    expect(typeof flock.isInside).toBe('function')
    expect(typeof flock.isBreach).toBe('function')
    expect(typeof flock.haversineMetres).toBe('function')
  })

  it('re-exports canary-kit primitives', () => {
    // A representative sample of the canary-kit surface flock builds on.
    expect(typeof flock.deriveBeaconKey).toBe('function')
    expect(typeof flock.encryptBeacon).toBe('function')
    expect(typeof flock.buildDuressAlert).toBe('function')
    expect(typeof flock.createGroup).toBe('function')
  })

  it('re-exports canary-kit Nostr builders and flock signals/policy', () => {
    expect(typeof flock.buildSignalEvent).toBe('function')
    expect(typeof flock.decideEmission).toBe('function')
    expect(typeof flock.buildLocationSignal).toBe('function')
    expect(typeof flock.buildHelpSignal).toBe('function')
    expect(typeof flock.signalTypeForReason).toBe('function')
  })

  it('re-exports flock night-out helpers', () => {
    expect(typeof flock.buildNightOutGroupEvent).toBe('function')
    expect(typeof flock.classifyPresence).toBe('function')
    expect(typeof flock.geoOutliers).toBe('function')
  })
})
