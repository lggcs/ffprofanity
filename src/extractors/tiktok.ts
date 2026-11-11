/**
 * TikTok Site Extractor
 * Handles subtitle detection for tiktok.com feed videos
 *
 * ARCHITECTURE (verified live):
 * The player is xgplayer; the video plays via MSE (blob: src) and exposes
 * NO native textTracks. Captions are WEBVTT files on pre-signed CDN URLs
 * published in the hydration JSON (captionInfos[]) and feed API payloads
 * (captionInfos[]/subtitleInfos[]). TikTok's strict CSP (script-src without
 * 'unsafe-inline') blocks the generic inline interceptor, so detection is
 * handled by src/page-scripts/tiktok-injected.ts, injected via
 * browser.scripting.executeScript with world: 'MAIN'. It fetches the
 * WEBVTT in page context and relays raw content as
 * FFPROFANITY_SUBTITLE_CONTENT (extension-less URLs would fail the
 * generic URL gates).
 */

import { BaseExtractor } from "./base";

export class TikTokExtractor extends BaseExtractor {
  name = "tiktok";
  patterns = [
    /tiktok\.[a-z.]+/i,
  ];

  /**
   * No inline script — TikTok's CSP blocks inline <script> injection.
   * Extraction runs from tiktok-injected.ts (MAIN world via
   * scripting.executeScript from background/index.ts).
   */
  getInjectedScript(): string {
    return '';
  }
}

export const tiktokExtractor = new TikTokExtractor();
