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
