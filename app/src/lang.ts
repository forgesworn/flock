// Map label language. The offline vector basemap can render place/road labels in
// any language the tiles carry a `name:<lang>` for, falling back to the local `name`
// otherwise. We pick the language from the device locale so people see the names they
// actually know — München on a German phone, Munich on a British one, Praha on a
// Czech one — rather than a single hard-coded language.
//
// Constraint: only choose a language whose script our self-hosted glyphs cover, else
// fall back to English. We ship Noto Sans ranges 0–2047 + punctuation
// (scripts/fetch-basemap-assets.mjs) — i.e. **Latin, Greek and Cyrillic**. A locale
// outside that set (CJK, Arabic, Hebrew, Indic, Thai…) would ask for a glyph range we
// don't host and render as tofu boxes, so we serve it English instead. Local names
// still surface via the tiles' `name` fallback, so this degrades gracefully.

// Latin-script European languages (covers the initial launch markets — en/de/cs/es/
// ca/pt — plus common neighbours). Extend as flock adds markets; Greek (el) and the
// Cyrillic languages are also glyph-covered and safe to add. Do NOT add CJK/Arabic/
// Hebrew/Indic until their fonts ship, or their labels will tofu.
const LABEL_LANGS = new Set([
  'en', 'de', 'cs', 'es', 'ca', 'pt', 'fr', 'it', 'nl', 'pl', 'sk',
  'da', 'sv', 'nb', 'nn', 'fi', 'hu', 'ro', 'hr', 'sl', 'gl', 'eu',
])

/** Preferred map-label language derived from the device locale, constrained to the
 *  scripts we ship glyphs for (English otherwise). Pass a `nav` in tests; in the
 *  browser it reads `navigator`. Unknown locales degrade to English, and local names
 *  still show via the tiles' `name` fallback — never tofu. */
export function preferredMapLang(nav?: { language?: string } | null): string {
  const source = nav ?? (typeof navigator !== 'undefined' ? navigator : null)
  const base = (source?.language ?? 'en').split('-')[0].toLowerCase()
  return LABEL_LANGS.has(base) ? base : 'en'
}

// A group abroad is mixed-nationality, and each map renders per-device — so by default
// everyone sees labels in their own language (`device`). But someone physically in a
// foreign town may prefer the **local** names that match the street signs (and that are
// identical on every member's map), so we let them switch. `local` renders the tiles'
// native `name` with no translation.
export type MapLabelMode = 'device' | 'local'

/** The label language for a mode: `null` = local/native names (Protomaps renders the
 *  tiles' `name` when no lang is applied); otherwise the glyph-safe device language. */
export function mapLabelLang(mode: MapLabelMode, nav?: { language?: string } | null): string | null {
  return mode === 'local' ? null : preferredMapLang(nav)
}

const LABEL_MODE_KEY = 'flock.maplabels'

/** The user's persisted label mode (default `device`). Browser-only; safe elsewhere. */
export function mapLabelMode(): MapLabelMode {
  try { return localStorage.getItem(LABEL_MODE_KEY) === 'local' ? 'local' : 'device' } catch { return 'device' }
}

/** Persist the user's label mode. */
export function setMapLabelMode(mode: MapLabelMode): void {
  try { localStorage.setItem(LABEL_MODE_KEY, mode) } catch { /* ignore — pref is best-effort */ }
}

/** The label language to apply right now: the persisted mode over the device locale.
 *  `null` = local/native names. Used as `pmtilesStyle`'s default. */
export function activeMapLabelLang(nav?: { language?: string } | null): string | null {
  return mapLabelLang(mapLabelMode(), nav)
}
