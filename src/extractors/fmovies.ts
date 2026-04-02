/**
 * fmovies.gd Site Extractor
 * Handles subtitle detection for fmovies streaming sites
 *
 * ARCHITECTURE:
 * fmovies uses dynamic subtitle loading from sub.wyzie.io API.
 * Subtitles are fetched on-demand when user selects a language.
 * The sources API (api.videasy.net) returns encrypted data with subtitle IDs.
 *
 * ANTI-DEBUGGING NOTE:
 * fmovies has anti-debugging protection that triggers debugger statements
 * when DevTools are open. This extractor uses passive detection strategies
 * to avoid triggering those protections.
 *
 * CSP BYPASS:
 * fmovies blocks inline scripts via CSP, so extraction is handled by
 * page-scripts/fmovies-injected.ts which is injected via browser.scripting.executeScript
 * with world: 'MAIN' to bypass CSP restrictions.
 *
 * SUBTITLE DETECTION STRATEGIES:
 * 1. Intercept fetch/XHR to sub.wyzie.io for subtitle URLs
 * 2. Monitor video textTracks for dynamically loaded subtitles
 * 3. Auto-select English CC track when subtitle modal opens
 */

import { BaseExtractor, DetectedSubtitle } from "./base";

export class FMoviesExtractor extends BaseExtractor {
  name = "fmovies";
  patterns = [
    /fmovies\.[a-z]+/i,
    /fmovies\d*\.[a-z]+/i,
    /fmovie\.[a-z]+/i,
  ];

  /**
   * No inline script needed - fmovies extraction is handled by fmovies-injected.ts
   * which is injected via background scripting API with world: 'MAIN'
   * to bypass CSP restrictions.
   */
  getInjectedScript(): string {
    return '';
  }
}

// Singleton instance
export const fmoviesExtractor = new FMoviesExtractor();