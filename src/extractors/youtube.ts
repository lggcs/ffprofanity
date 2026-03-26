/**
 * YouTube Site Extractor
 * Handles subtitle detection for youtube.com and youtu.be
 *
 * Key implementation notes:
 * - YouTube provides signed URLs with expire/signature params - use them directly
 * - Default format is JSON3; add &fmt=vtt to get WebVTT format
 * - ytInitialPlayerResponse is accessed via MAIN world script (youtube-injected.ts)
 * - Script injection is done via background scripting API to bypass CSP
 * - Subtitle URLs need page-level cookies, so fetch happens in page context
 */

import { BaseExtractor, DetectedSubtitle } from './base';

export class YouTubeExtractor extends BaseExtractor {
  name = 'youtube';
  patterns = [
    /youtube\.com/i,
    /youtu\.be/i,
    /youtube-nocookie\.com/i,
  ];

  /**
   * No inline script needed - YouTube extraction is handled by youtube-injected.ts
   * which is injected via browser.scripting.executeScript with world: 'MAIN'
   * to bypass CSP restrictions.
   */
  getInjectedScript(): string {
    // Return empty string - the actual extraction is handled by the page script
    // injected via background/index.ts using scripting.executeScript
    return '';
  }

  /**
   * Check if URL is a YouTube video page
   */
  isVideoPage(url: string): boolean {
    try {
      const urlObj = new URL(url);
      return /\/watch\?|\/embed\/|\/v\//.test(urlObj.pathname) ||
             /^https?:\/\/(www\.)?youtu\.be\//i.test(url);
    } catch {
      return false;
    }
  }
}

export const youTubeExtractor = new YouTubeExtractor();