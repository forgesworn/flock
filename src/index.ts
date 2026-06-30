// @forgesworn/flock — barrel re-export.
//
// flock extends canary-kit (which extends spoken-token) with location-aware
// safety primitives. The whole canary-kit surface is re-exported so consumers
// have one import for groups, beacons, duress alerts, Nostr builders, etc.

// --- canary-kit (groups, beacons, duress, encoding) ---
export * from 'canary-kit'
// --- canary-kit Nostr transport builders (separate subpath in canary-kit) ---
export * from 'canary-kit/nostr'

// --- flock additions ---
export * from './geofence.js'
export * from './policy.js'
export * from './signals.js'
export * from './nightout.js'
export * from './checkin.js'
