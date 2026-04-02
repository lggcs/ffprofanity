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
};

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
  const normalized = code.toLowerCase().slice(0, 5);
  return LANGUAGE_NAMES[normalized] || LANGUAGE_NAMES[normalized.slice(0, 2)] || code.toUpperCase();
}

/**
 * Check if a language code matches a preferred language
 */
export function languageMatches(code: string, preferred: string): boolean {
  const normalizedCode = code.toLowerCase().slice(0, 2);
  const normalizedPref = preferred.toLowerCase().slice(0, 2);
  return normalizedCode === normalizedPref;
}