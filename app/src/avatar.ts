// Who-is-who at a glance: initials from the member's chosen name and a stable,
// distinct tint derived from their pubkey. Pure — app.ts resolves the name
// (petname → announced handle → opted-in profile) and passes it in.

/** A member's stable hue (0–359) from their pubkey hex — deterministic, so the
 *  same person is the same colour on every device and every screen. */
export function memberHue(pk: string): number {
  const n = parseInt(pk.slice(0, 8), 16)
  return Number.isFinite(n) ? n % 360 : 210
}

/**
 * Avatar initials from a display name: first letters of the first two words
 * ("Amy Winter" → "AW"), or the first two characters of a single word
 * ("Rover" → "RO"). With NO real name, fall back to the caller's per-member
 * fallback (the pubkey pair) — never derive initials from a placeholder like
 * "Member r52d", or every unnamed member would collapse into the same "ME".
 */
export function nameInitials(name: string, fallback: string): string {
  const t = name.trim()
  if (!t) return fallback
  const words = t.split(/\s+/).filter(Boolean)
  const two = words.length >= 2 ? `${words[0][0]}${words[1][0]}` : t.slice(0, 2)
  return two.toLocaleUpperCase()
}
