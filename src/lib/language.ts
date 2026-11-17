/**
 * Language utilities for subtitle processing
 * Shared across extractors, content script, and page scripts
 */

/**
 * Common language code to name mappings
 */
export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  ru: 'Russian',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  'zh-cn': 'Chinese (Simplified)',
  'zh-tw': 'Chinese (Traditional)',
  ar: 'Arabic',
  hi: 'Hindi',
  nl: 'Dutch',
  pl: 'Polish',
  sv: 'Swedish',
  da: 'Danish',
  fi: 'Finnish',
  no: 'Norwegian',
  tr: 'Turkish',
  id: 'Indonesian',
  th: 'Thai',
  vi: 'Vietnamese',
  cs: 'Czech',
  hu: 'Hungarian',
  ro: 'Romanian',
  el: 'Greek',
  he: 'Hebrew',
  uk: 'Ukrainian',
  bg: 'Bulgarian',
  hr: 'Croatian',
  mk: 'Macedonian',
  sr: 'Serbian',
  sk: 'Slovak',
  sl: 'Slovenian',
  ms: 'Malay',
  ta: 'Tamil',
  te: 'Telugu',
  ml: 'Malayalam',
  bn: 'Bengali',
  ur: 'Urdu',
  fa: 'Persian',
  lt: 'Lithuanian',
  lv: 'Latvian',
  et: 'Estonian',
  // ISO 639-2/B and regional code forms that relay language fields and
  // hashed caption URLs actually deliver; missing keys would be masked as
  // uppercase codes ("SCC") or truncate into the wrong language.
  scc: 'Serbian (Cyrillic)',
  sc: 'Serbian (Cyrillic)',
  scr: 'Croatian',
  slk: 'Slovak',
  slo: 'Slovak',
  rum: 'Romanian',
  ell: 'Greek',
  gre: 'Greek',
  eng: 'English',
  spa: 'Spanish',
  fre: 'French',
  fra: 'French',
  ger: 'German',
  deu: 'German',
  por: 'Portuguese',
  ita: 'Italian',
  jpn: 'Japanese',
  chi: 'Chinese',
  nld: 'Dutch',
  dut: 'Dutch',
  pol: 'Polish',
  swe: 'Swedish',
  tur: 'Turkish',
  ind: 'Indonesian',
  per: 'Persian',
  bul: 'Bulgarian',
  ces: 'Czech',
  cze: 'Czech',
  sq: 'Albanian',
  sqi: 'Albanian',
  alb: 'Albanian',
  bs: 'Bosnian',
  bos: 'Bosnian',
  is: 'Icelandic',
  ice: 'Icelandic',
  isl: 'Icelandic',
  ka: 'Georgian',
  kat: 'Georgian',
  hy: 'Armenian',
  hye: 'Armenian',
  arm: 'Armenian',
  be: 'Belarusian',
  bel: 'Belarusian',
  ca: 'Catalan',
  cat: 'Catalan',
  eu: 'Basque',
  eus: 'Basque',
  baq: 'Basque',
  gl: 'Galician',
  glg: 'Galician',
  ga: 'Irish',
  gle: 'Irish',
  cy: 'Welsh',
  cym: 'Welsh',
  nb: 'Norwegian',
  nn: 'Norwegian (Nynorsk)',
  nno: 'Norwegian (Nynorsk)',
  fil: 'Filipino',
  srp: 'Serbian',
  hrv: 'Croatian',
  mkd: 'Macedonian',
  hun: 'Hungarian',
  ron: 'Romanian',
  ukr: 'Ukrainian',
  ara: 'Arabic',
  tha: 'Thai',
  vie: 'Vietnamese',
  rus: 'Russian',
};

// Full-word lookup by display name: relay language fields sometimes carry
// the name itself ("Croatian", "Slovak") instead of a code, where 2-char
// truncation would miss the word entirely or hit the wrong language
// ("Slovak" → "sl" → Slovenian).
const LANGUAGE_NAME_BY_FORM = new Map<string, string>();
for (const name of Object.values(LANGUAGE_NAMES)) {
  if (!LANGUAGE_NAME_BY_FORM.has(name.toLowerCase())) {
    LANGUAGE_NAME_BY_FORM.set(name.toLowerCase(), name);
  }
}

/**
 * Extract language code from subtitle URL or data object
 */
export function extractLanguageFromUrl(
  url: string,
  data?: Record<string, unknown>,
): string {
  // URL patterns for language extraction
  const patterns = [
    /[?&]lang=([a-z]{2,3}(?:-[a-z]{2,3})?)/i,
    /\/([a-z]{2,3})_[a-f0-9]+\.vtt$/i, // LookMovie format
    /\/([a-z]{2,3})\/[^/]+\.(vtt|srt|ass)$/i, // Path format
    /[_\-\.]([a-z]{2,3})\.(vtt|srt|ass|ssa)$/i, // Suffix format
    /[_\-\.]([a-z]{2,3}(?:-[a-z]{2,3})?)\.(vtt|srt|ass|ssa)$/i, // Extended suffix
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1].toLowerCase();
    }
  }

  // Check data object for language keys
  if (data) {
    const langKeys = ['language', 'lang', 'code', 'lc', 'srclang'];
    for (const key of langKeys) {
      if (typeof data[key] === 'string') {
        const val = (data[key] as string).toLowerCase();
        // Handle codes like "en-US" -> "en"
        return val.slice(0, 3).replace(/-.*$/, '');
      }
    }
  }

  return 'unknown';
}

/**
 * Convert language code to display name
 */
export function getLanguageName(code: string): string {
  return languageDisplayName(code) || code.toUpperCase();
}

/**
 * Display name for a language code, or null when the code is unknown.
 * Unlike getLanguageName, unknown codes are not masked as an uppercase
 * code — callers use null as "leave the existing label alone".
 * Lookup order: direct map key (2–3 letter codes and their ISO 639-2/B
 * forms), then the 2-char prefix — gated to code-shaped inputs so a full
 * word like "Slovak" does not truncate into "sl" and hit Slovenian — and
 * finally the reverse lookup for relays that carry the name itself.
 */
export function languageDisplayName(code: string | undefined): string | null {
  if (!code) return null;
  const normalized = code.toLowerCase().slice(0, 5);
  const direct = LANGUAGE_NAMES[normalized];
  if (direct) return direct;
  if (code.length <= 3 || code.includes('-')) {
    const prefix = LANGUAGE_NAMES[normalized.slice(0, 2)];
    if (prefix) return prefix;
  }
  return LANGUAGE_NAME_BY_FORM.get(code.toLowerCase().trim()) ?? null;
}

/**
 * Check if a language code matches a preferred language
 */
export function languageMatches(code: string, preferred: string): boolean {
  const normalizedCode = code.toLowerCase().slice(0, 2);
  const normalizedPref = preferred.toLowerCase().slice(0, 2);
  return normalizedCode === normalizedPref;
}