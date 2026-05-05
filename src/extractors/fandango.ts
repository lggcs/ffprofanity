/**
 * Fandango At Home (Vudu) Site Extractor
 * Handles subtitle detection for athome.fandango.com and related domains
 *
 * ARCHITECTURE:
 * Fandango At Home (formerly Vudu) uses a Shaka Player-based player
 * ("asteroid") inside a dedicated player iframe (#contentPlayerFrame).
 *
 * Subtitles are served as VTT files from cc.vudu.com and loaded via
 * <track kind="metadata"> elements on the video element in the player frame.
 * The "metadata" kind means traditional textTrack APIs won't surface them
 * as subtitle/caption tracks — the Shaka player reads them programmatically.
 *
 * VTT URL pattern: https://cc.vudu.com/{bucket}/{contentId}/movie/subtitle.{num}.{lang}.vtt
 *
 * The page script (fandango-injected.ts) runs in the player iframe's MAIN world
 * to access both the <track> elements and the Shaka player API.
 */

import { BaseExtractor, DetectedSubtitle } from "./base";

export class FandangoExtractor extends BaseExtractor {
  name = "fandango";
  patterns = [
    /athome\.fandango\.com/i,
    /fandangoathome\.[a-z]+/i,
    /vudu\.com/i,
    /cc\.vudu\.com/i,
  ];

  /**
   * Extract subtitle info from cc.vudu.com network responses
   */
  extractFromResponse?(url: string, responseText: string): DetectedSubtitle[] {
    const subs: DetectedSubtitle[] = [];

    // Detect VTT subtitle files from cc.vudu.com
    if (/cc\.vudu\.com.*\.vtt(\?|$)/i.test(url) && responseText.includes("-->")) {
      const lang = this.extractLanguage(url);
      subs.push({
        url,
        language: lang,
        label: this.getLanguageName(lang),
        source: "cc-vudu-network",
      });
    }

    return subs;
  }

  /**
   * Get the injected script for Fandango player detection
   * This runs in the page context with access to Shaka Player and DOM
   */
  getInjectedScript?(): string {
    // The page script uses shared modules via esbuild bundling,
    // so no inline script is needed — the bundled page script handles it
    return "";
  }
}

// Singleton instance
export const fandangoExtractor = new FandangoExtractor();