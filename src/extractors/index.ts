/**
 * Site Extractor Manager
 * Routes subtitle extraction to site-specific extractors
 */

import type { SiteExtractor, DetectedSubtitle } from "./base";
import { LookMovieExtractor } from "./lookmovie";
import { YouTubeExtractor } from "./youtube";
import { OneTwoThreeChillExtractor } from "./123chill";
import { PlutoTVExtractor } from "./plutotv";
import { FMoviesExtractor } from "./fmovies";
import { extractLanguageFromUrl as extractLanguageFromUrlImpl } from "../lib/language";

// All available extractors
const extractors: SiteExtractor[] = [
  new LookMovieExtractor(),
  new YouTubeExtractor(),
  new OneTwoThreeChillExtractor(),
  new PlutoTVExtractor(),
  new FMoviesExtractor(),
  // Add more extractors here as they're created
];

/**
 * Get the extractor for the current page
 */
export function getExtractorForUrl(url: string): SiteExtractor | null {
  for (const extractor of extractors) {
    if (extractor.matches(url)) {
      return extractor;
    }
  }
  return null;
}

/**
 * Get all extractors that match the URL
 */
export function getAllMatchingExtractors(url: string): SiteExtractor[] {
  return extractors.filter((e) => e.matches(url));
}

/**
 * Get the injected script for all matching extractors
 */
export function getInjectedScripts(url: string): string {
  const matching = getAllMatchingExtractors(url);
  if (matching.length === 0) return "";

  const scripts = matching
    .map((e) => e.getInjectedScript?.() || "")
    .filter((s) => s.length > 0);

  if (scripts.length === 0) return "";

  return `
    // Site-specific extractors
    (function() {
      ${scripts.join("\n\n")}
    })();
  `;
}

/**
 * Process a network response with matching extractors
 */
export function processResponse(
  url: string,
  responseText: string,
): DetectedSubtitle[] {
  const subs: DetectedSubtitle[] = [];

  for (const extractor of getAllMatchingExtractors(url)) {
    if (extractor.extractFromResponse) {
      const extracted = extractor.extractFromResponse(url, responseText);
      subs.push(...extracted);
    }
  }

  return subs;
}

/**
 * Check if URL is a direct subtitle file
 */
export function isSubtitleUrl(url: string): boolean {
  return /\.(vtt|srt|ass|ssa)(\?|$)/i.test(url);
}

/**
 * Extract language from subtitle URL
 * Re-exports from shared language utilities
 */
export { extractLanguageFromUrlImpl as extractLanguageFromUrl };

// Export everything
export { SiteExtractor, DetectedSubtitle, BaseExtractor } from "./base";
export { lookMovieExtractor } from "./lookmovie";
export { youTubeExtractor } from "./youtube";
export { oneTwoThreeChillExtractor } from "./123chill";
export { plutotvExtractor } from "./plutotv";
export { fmoviesExtractor } from "./fmovies";
