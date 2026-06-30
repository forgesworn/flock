// @forgesworn/flock — barrel re-export.
//
// flock extends canary-kit (which extends spoken-token) with location-aware
// safety primitives. The whole canary-kit surface is re-exported so consumers
// have one import for groups, beacons, duress alerts, Nostr builders, etc.

// --- canary-kit (groups, beacons, duress, Nostr transport, encoding) ---
export * from 'canary-kit'

// --- flock additions ---
export * from './geofence.js'
