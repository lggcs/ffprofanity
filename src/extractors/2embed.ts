/**
 * 2embed Site Extractor
 * Handles subtitle detection for 2embed streaming server iframes
 *
 * 2embed is used as a video server option on sites like cinebto.com.
 * It uses Video.js as its player (not FastStreamClient/FluidPlayer).
 *
 * ARCHITECTURE:
 * - 2embed runs inside an iframe on cinebto.com
 * - Uses Video.js player for video playback
 * - The page script (2embed-injected.ts) runs in MAIN world inside
 *   the 2embed iframe to detect Video.js text tracks
 *
 * DETECTION STRATEGIES (in the page script):
 * 1. Video.js player detection (remoteTextTrackEls, textTracks)
 * 2. XHR/fetch interception for .vtt/.srt/.ass URLs and HLS manifests
 * 3. <track> element detection within video elements
 * 4. Video textTrack monitoring
 * 5. MutationObserver for late-loading video elements
 *
 * This extractor class handles content-script-level detection and
 * routing for 2embed URLs.
 */

import { BaseExtractor } from "./base";

export class TwoEmbedExtractor extends BaseExtractor {
  name = "2embed";
  patterns = [
    /2embed\.(org|cc|dev|io|net|xyz)/i,
    /2embed\.club/i,
    /2embed\.link/i,
    /2embeds?\.[a-z]+/i,
  ];

  /**
   * 2embed uses Video.js player, so subtitle detection happens
   * via the injected page script. This extractor provides URL pattern
   * matching and metadata for the content script pipeline.
   */
}

// Singleton instance
export const twoEmbedExtractor = new TwoEmbedExtractor();