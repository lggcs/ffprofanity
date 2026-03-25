/**
 * fmovies.gd Site Extractor
 * Handles subtitle detection for fmovies streaming sites
 *
 * ARCHITECTURE:
 * fmovies uses dynamic subtitle loading - <track> elements exist but src is
 * set dynamically via JavaScript after user interaction or playback start.
 *
 * ANTI-DEBUGGING NOTE:
 * fmovies has anti-debugging protection that triggers debugger statements
 * when DevTools are open. This extractor uses passive detection strategies
 * to avoid triggering those protections.
 *
 * SUBTITLE DETECTION STRATEGIES:
 * 1. Video element <track> src monitoring (passive)
 * 2. VideoJS player remoteTextTrackEls() detection
 * 3. Periodic scanning for new track URLs
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
   * Get the injected script for fmovies-specific extraction
   * This script runs in the page context with access to XHR, fetch, and window objects
   */
  getInjectedScript(): string {
    return `
      // fmovies Subtitle Extractor - Passive detection (anti-debugging safe)
      (function() {
        'use strict';

        const EXTRACTOR_ID = 'fmovies';
        const sentSubtitles = new Set();
        let checkInterval = null;

        // Send detected subtitles to content script
        function sendSubtitles(subs, source) {
          if (!subs || subs.length === 0) return;

          try {
            const uniqueSubs = subs.filter(s => {
              if (sentSubtitles.has(s.url)) return false;
              sentSubtitles.add(s.url);
              return true;
            });

            if (uniqueSubs.length === 0) return;

            console.log('[FMovies] Found', uniqueSubs.length, 'subtitles from', source);
            window.postMessage({
              type: 'FFPROFANITY_SUBTITLES_DETECTED',
              source: EXTRACTOR_ID + '.' + source,
              subtitles: uniqueSubs
            }, '*');
          } catch (e) {
            // Ignore errors to avoid triggering anti-debugging
          }
        }

        // Extract language from URL
        function extractLanguage(url) {
          const patterns = [
            /[?&]lang=([a-z]{2,3})/i,
            /[_\\-\\.]([a-z]{2,3})\\.(vtt|srt|ass|ssa)/i,
            /\\/([a-z]{2,3})_[a-f0-9]+\\.vtt/i,
            /\\/([a-z]{2,3})\\/[^/]+\\.vtt/i,
          ];
          for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match) return match[1].toLowerCase();
          }
          return 'en';
        }

        // Strategy 1: Scan video elements for tracks with src
        function scanVideoTracks() {
          try {
            const videos = document.querySelectorAll('video');
            for (const video of videos) {
              const tracks = video.querySelectorAll('track');
              for (const track of tracks) {
                const src = track.getAttribute('src');
                if (src && !src.startsWith('blob:') && !sentSubtitles.has(src)) {
                  const label = track.label || 'Unknown';
                  const lang = track.srclang || extractLanguage(src);
                  sendSubtitles([{
                    url: src,
                    language: lang,
                    label: label,
                    source: 'video-track'
                  }], 'video-track');
                }
              }
            }
          } catch (e) {}
        }

        // Strategy 2: Check VideoJS players for text tracks
        function scanVideoJS() {
          try {
            if (typeof window.videojs === 'undefined') return;
            const players = window.videojs.players;
            if (!players) return;

            for (const playerId of Object.keys(players)) {
              const player = players[playerId];
              if (!player) continue;

              // Try remoteTextTrackEls
              try {
                const tracks = player.remoteTextTrackEls ? player.remoteTextTrackEls() : [];
                for (const track of tracks) {
                  const trackEl = track.track || track;
                  const src = trackEl.src || track.src;
                  if (src && !src.startsWith('blob:') && !sentSubtitles.has(src)) {
                    const label = trackEl.label || track.label || 'Unknown';
                    const lang = trackEl.language || track.language || extractLanguage(src);
                    sendSubtitles([{
                      url: src,
                      language: lang,
                      label: label,
                      source: 'videojs'
                    }], 'videojs');
                  }
                }
              } catch (e) {}

              // Try textTracks
              try {
                const textTracks = player.textTracks ? player.textTracks() : [];
                for (let i = 0; i < textTracks.length; i++) {
                  const track = textTracks[i];
                  if (track.kind === 'subtitles' || track.kind === 'captions') {
                    // Some players store URL in custom properties
                    const src = track.src || track.url;
                    if (src && !src.startsWith('blob:') && !sentSubtitles.has(src)) {
                      sendSubtitles([{
                        url: src,
                        language: track.language || 'en',
                        label: track.label || 'Unknown',
                        source: 'videojs-texttrack'
                      }], 'videojs-texttrack');
                    }
                  }
                }
              } catch (e) {}
            }
          } catch (e) {}
        }

        // Strategy 3: Watch for video element additions and mutations
        function observeVideos() {
          try {
            const observer = new MutationObserver((mutations) => {
              for (const mutation of mutations) {
                // Check added nodes
                for (const node of mutation.addedNodes) {
                  if (node.nodeName === 'VIDEO') {
                    scanVideoTracks();
                    scanVideoJS();
                  }
                  if (node.querySelectorAll) {
                    const videos = node.querySelectorAll('video');
                    if (videos.length > 0) {
                      scanVideoTracks();
                      scanVideoJS();
                    }
                  }
                }
                // Check attribute changes on track elements
                if (mutation.type === 'attributes' && mutation.target.nodeName === 'TRACK') {
                  const src = mutation.target.getAttribute('src');
                  if (src && !src.startsWith('blob:')) {
                    sendSubtitles([{
                      url: src,
                      language: mutation.target.srclang || extractLanguage(src),
                      label: mutation.target.label || 'Unknown',
                      source: 'track-mutation'
                    }], 'track-mutation');
                  }
                }
              }
            });

            observer.observe(document.body, {
              childList: true,
              subtree: true,
              attributes: true,
              attributeFilter: ['src'],
              attributeOldValue: false
            });
          } catch (e) {}
        }

        // Strategy 4: Periodic scanning (fallback for dynamic loading)
        function startPeriodicScan() {
          if (checkInterval) return;
          checkInterval = setInterval(() => {
            scanVideoTracks();
            scanVideoJS();
          }, 2000);

          // Stop after 60 seconds
          setTimeout(() => {
            if (checkInterval) {
              clearInterval(checkInterval);
              checkInterval = null;
            }
          }, 60000);
        }

        // Initialize
        function init() {
          // Initial scan
          scanVideoTracks();
          scanVideoJS();

          // Set up observers
          observeVideos();

          // Periodic scanning for dynamic content
          startPeriodicScan();

          console.log('[FMovies] Extractor loaded');
        }

        // Run when ready
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', init);
        } else {
          init();
        }
      })();
    `;
  }
}

// Singleton instance
export const fmoviesExtractor = new FMoviesExtractor();