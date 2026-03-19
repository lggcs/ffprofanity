/**
 * LookMovie Site Extractor
 * Handles subtitle detection for lookmovie.to and variants
 */

import { BaseExtractor, DetectedSubtitle } from './base';

export class LookMovieExtractor extends BaseExtractor {
  name = 'lookmovie';
  patterns = [
    /lookmovie\d*\.to/i,
    /lookmovie\.[a-z]+/i,
    /lookmovie\d*\.[a-z]+/i,
  ];

  /**
   * Extract from movie_storage global object
   */
  extractFromPageState(): DetectedSubtitle[] {
    const subs: DetectedSubtitle[] = [];

    // Check if movie_storage exists and has text_tracks
    // Note: This runs in the injected script context, not content script
    // The content script will call this via message passing

    return subs;
  }

  /**
   * Process XHR response for LookMovie API endpoints
   */
  extractFromResponse(url: string, responseText: string): DetectedSubtitle[] {
    // LookMovie API endpoints
    if (!url.includes('/api/')) return [];

    try {
      const data = JSON.parse(responseText);

      // Look for subtitles in response
      if (data.subtitles && Array.isArray(data.subtitles)) {
        return data.subtitles.map((s: Record<string, unknown>) => ({
          url: (s.file || s.url || s.downloadLink) as string,
          language: (s.language || s.lang || 'en') as string,
          label: (s.label || s.name || s.language || 'English') as string,
          source: 'lookmovie-api',
        })).filter((s: DetectedSubtitle) => s.url);
      }
    } catch {
      // Not JSON, ignore
    }

    return [];
  }

  /**
   * Get the injected script for LookMovie-specific interception
   */
  getInjectedScript(): string {
    return `
      // LookMovie-specific interception
      (function() {
        const sentSubtitles = new Set();

        function sendSubtitles(subs, source) {
          // Deduplicate
          const key = JSON.stringify(subs);
          if (sentSubtitles.has(key)) return;
          sentSubtitles.add(key);

          window.postMessage({
            type: 'FFPROFANITY_SUBTITLES_DETECTED',
            source: source,
            subtitles: subs
          }, '*');
        }

        // Watch movie_storage.text_tracks
        function watchMovieStorage() {
          if (!window.movie_storage) return;

          let lastLength = 0;
          const pollInterval = setInterval(() => {
            const tracks = window.movie_storage?.text_tracks;
            if (tracks && Array.isArray(tracks) && tracks.length > lastLength) {
              lastLength = tracks.length;
              const subs = tracks.map(t => ({
                url: t.file || t.url || t.src || t.downloadLink,
                language: t.language || t.lang || t.code || 'unknown',
                label: t.label || t.name || t.language || 'Unknown'
              })).filter(s => s.url);
              if (subs.length > 0) {
                console.log('[LookMovie] Found ' + subs.length + ' subtitles in movie_storage.text_tracks');
                sendSubtitles(subs, 'lookmovie.text_tracks');
              }
            }
          }, 500);

          // Cleanup after 2 minutes
          setTimeout(() => clearInterval(pollInterval), 120000);
          console.log('[LookMovie] Watching movie_storage.text_tracks');
        }

        // Watch VTT URLs in XHR
        function interceptVttUrls() {
          const originalOpen = XMLHttpRequest.prototype.open;
          XMLHttpRequest.prototype.open = function(method, url) {
            this._lm_url = url;
            return originalOpen.apply(this, arguments);
          };
        }

        // Initialize
        if (window.movie_storage) {
          watchMovieStorage();
        } else {
          let attempts = 0;
          const checkInterval = setInterval(() => {
            attempts++;
            if (window.movie_storage) {
              clearInterval(checkInterval);
              watchMovieStorage();
            } else if (attempts > 50) {
              clearInterval(checkInterval);
            }
          }, 200);
        }
      })();
    `;
  }
}

export const lookMovieExtractor = new LookMovieExtractor();