/**
 * Shared helpers for page scripts injected into MAIN world
 *
 * These are bundled into each page script IIFE by esbuild, so imports
 * are inlined at build time — no runtime module loading needed.
 */

/**
 * Common language code → name map (canonical, matches lib/language.ts)
 */
export const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  ru: "Russian",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
  ar: "Arabic",
  hi: "Hindi",
  nl: "Dutch",
  pl: "Polish",
  sv: "Swedish",
  da: "Danish",
  fi: "Finnish",
  no: "Norwegian",
  tr: "Turkish",
  id: "Indonesian",
  th: "Thai",
  vi: "Vietnamese",
  uk: "Ukrainian",
  cs: "Czech",
  hu: "Hungarian",
  ro: "Romanian",
  el: "Greek",
  he: "Hebrew",
  bg: "Bulgarian",
  hr: "Croatian",
  sk: "Slovak",
  sl: "Slovenian",
  ms: "Malay",
  ta: "Tamil",
  te: "Telugu",
  ml: "Malayalam",
  bn: "Bengali",
  ur: "Urdu",
  fa: "Persian",
  lt: "Lithuanian",
  lv: "Latvian",
  et: "Estonian",
};

/**
 * Extract language code from subtitle URL
 */
export function extractLanguageFromUrl(url: string): string {
  const patterns = [
    /[?&]lang=([a-z]{2,3}(?:-[a-z]{2,3})?)/i,
    /[?&]language=([a-z]{2,3})/i,
    /\/([a-z]{2,3})_[a-f0-9]+\.vtt$/i,
    /\/([a-z]{2,3})\/[^/]+\.(vtt|srt|ass)$/i,
    /[_\-\.]([a-z]{2,3})\.(vtt|srt|ass|ssa)$/i,
    /[_\-\.]([a-z]{2,3}(?:-[a-z]{2,3})?)\.(vtt|srt|ass|ssa)$/i,
    /[_\-]([a-z]{2,3})[._]/i,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) return match[1].toLowerCase();
  }
  return "unknown";
}

/**
 * Convert language code to display name
 */
export function getLanguageName(code: string): string {
  const normalized = code.toLowerCase().slice(0, 5);
  return LANGUAGE_NAMES[normalized] || LANGUAGE_NAMES[normalized.slice(0, 2)] || code.toUpperCase();
}

/**
 * Format seconds as VTT timestamp (HH:MM:SS.mmm)
 */
export function formatVTTTime(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return (
    String(hrs).padStart(2, "0") +
    ":" +
    String(mins).padStart(2, "0") +
    ":" +
    String(secs).padStart(2, "0") +
    "." +
    String(ms).padStart(3, "0")
  );
}

/**
 * Recursively find subtitle URLs in any object
 */
export function findSubtitlesRecursive(
  obj: unknown,
  excludePatterns?: RegExp[],
): Array<{ url: string; language: string; label: string }> {
  const subs: Array<{ url: string; language: string; label: string }> = [];
  if (!obj || typeof obj !== "object") return subs;

  const objRecord = obj as Record<string, unknown>;

  // Check if this object looks like a subtitle entry
  const urlKeys = ["file", "url", "src", "downloadLink", "path", "link"];
  for (const key of urlKeys) {
    if (typeof objRecord[key] === "string" && /\.(vtt|srt|ass|ssa)/i.test(objRecord[key] as string)) {
      const url = objRecord[key] as string;
      // Skip URLs matching exclusion patterns (e.g., .mjs files)
      if (excludePatterns && excludePatterns.some((p) => p.test(url))) continue;
      subs.push({
        url,
        language:
          (objRecord.language as string) ||
          (objRecord.lang as string) ||
          (objRecord.code as string) ||
          extractLanguageFromUrl(url),
        label:
          (objRecord.label as string) ||
          (objRecord.name as string) ||
          "Detected",
      });
    }
  }

  // Recurse into arrays and objects
  if (Array.isArray(obj)) {
    for (const item of obj) {
      subs.push(...findSubtitlesRecursive(item, excludePatterns));
    }
  } else {
    const priorityKeys = [
      "subtitles",
      "subs",
      "captions",
      "cc",
      "text_tracks",
      "tracks",
    ];
    for (const key of priorityKeys) {
      if (objRecord[key]) {
        subs.push(...findSubtitlesRecursive(objRecord[key], excludePatterns));
      }
    }
  }

  return subs;
}

/**
 * Check if a URL looks like a subtitle file
 */
export function isValidSubtitleUrl(url: string): boolean {
  if (!url) return false;
  const lowerUrl = url.toLowerCase();

  // Exclude font files
  const fontExtensions = [".otf", ".ttf", ".woff", ".woff2", ".eot"];
  if (fontExtensions.some((ext) => lowerUrl.endsWith(ext))) {
    return false;
  }

  // Include subtitle extensions
  const subtitleExtensions = [".vtt", ".srt", ".ass", ".ssa", ".sub"];
  if (subtitleExtensions.some((ext) => lowerUrl.includes(ext))) {
    return true;
  }

  // Include HLS manifests
  if (lowerUrl.includes(".m3u8")) {
    return true;
  }

  // Check query parameters
  try {
    const urlObj = new URL(url);
    if (
      urlObj.searchParams.has("subtitle") ||
      urlObj.searchParams.has("subs") ||
      urlObj.searchParams.has("captions")
    ) {
      return true;
    }
  } catch { /* ignore */ }

  return false;
}