// Member display: local petnames (private, offline, default) + optional public
// kind:0 profiles (names/avatars) fetched from public relays only when the user
// opts in. Petnames always win — your own label for someone beats any public one.
//
// Privacy: petnames never leave the device. kind:0 profiles ARE public Nostr
// metadata, but querying for them tells public relays which pubkeys you care
// about — hence opt-in, and confined to the public PROFILE_RELAYS set.

import { subscribeProfiles } from './services'
import { PROFILE_RELAYS } from './relays'

export interface Profile { name?: string; picture?: string }

const CACHE_KEY = 'flock:profiles:v1'
const cache = new Map<string, Profile>()
let loaded = false

function loadCache(): void {
  if (loaded) return
  loaded = true
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (raw) for (const [pk, p] of Object.entries(JSON.parse(raw) as Record<string, Profile>)) cache.set(pk, p)
  } catch { /* ignore corrupt cache */ }
}

function saveCache(): void {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(cache))) } catch { /* quota */ }
}

/** Cached public profile for a pubkey, if we've fetched one. */
export function getProfile(pk: string): Profile | undefined {
  loadCache()
  return cache.get(pk)
}

function parseProfile(content: string): Profile | null {
  try {
    const o = JSON.parse(content) as Record<string, unknown>
    const name = typeof o.display_name === 'string' && o.display_name.trim()
      ? o.display_name.trim()
      : typeof o.name === 'string' ? o.name.trim() : ''
    const picture = typeof o.picture === 'string' && /^https?:\/\//.test(o.picture) ? o.picture : ''
    if (!name && !picture) return null
    return { ...(name ? { name } : {}), ...(picture ? { picture } : {}) }
  } catch { return null }
}

/**
 * Fetch public profiles for `pubkeys` we don't already have, caching results.
 * Calls `onUpdate` whenever a new profile lands. No-op for keys already cached.
 * Auto-closes the relay subscription after a short collection window.
 */
export function fetchProfiles(pubkeys: string[], onUpdate: () => void): void {
  loadCache()
  const missing = [...new Set(pubkeys)].filter((pk) => /^[0-9a-f]{64}$/.test(pk) && !cache.has(pk))
  if (!missing.length) return
  // Mark as attempted so we don't refetch in a tight render loop; a real hit overwrites.
  for (const pk of missing) cache.set(pk, {})
  let changed = false
  const stop = subscribeProfiles(PROFILE_RELAYS, missing, (e) => {
    const p = parseProfile(e.content)
    if (!p) return
    cache.set(e.pubkey, p)
    changed = true
    saveCache()
    onUpdate()
  })
  window.setTimeout(() => { stop(); if (changed) onUpdate() }, 6000)
}
