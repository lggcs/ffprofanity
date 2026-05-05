/**
 * Cinebto Site Extractor
 * Handles subtitle detection for cinebto.com and related streaming sites
 *
 * ARCHITECTURE:
 * cinebto.com uses iframe-embedded video players from multiple sources.
 * The site provides video servers via ?server= URL parameter.
 * The primary server we handle is 111movies (FastStreamClient/FluidPlayer).
 *
 * When ?server=111movies is used:
 * - cinebto.com loads an iframe pointing to 111movies.net (or 111movies.com)
 * - 111movies uses a Next.js app with FastStreamClient player
 * - FastStreamClient has a SubtitlesManager that manages subtitle tracks
 * - Subtitles are rendered in div.fluid_subtitles_container (not <track> elements)
 * - Subtitle files (.vtt) are served from CDNs like cca.megafiles.store
 * - The video element is dynamically created inside div.video-container
 *
 * SUBTITLE DETECTION STRATEGIES:
 * 1. XHR/fetch interception for .vtt/.srt/.ass URLs (caught by injected script)
 * 2. FastStreamClient SubtitlesManager access via MAIN world injection
 * 3. Video element <track> elements (fallback)
 * 4. Network-level .vtt URL detection via background webRequest listener
 *
 * KNOWN SERVERS:
 * - 111movies (FastStreamClient/FluidPlayer)
 * - vidsrc (various domains)
 * - vidzee, vidrock, smashystream, etc. (handled by 123chill extractor)
 *
 * MIME TYPE FILTERING:
 * SubtitlesManager.mjs must not be treated as a subtitle URL. This extractor
 * helps the detection pipeline by only reporting genuine subtitle files.
 */

import { BaseExtractor, DetectedSubtitle } from "./base";

/**
 * Known video servers on cinebto.com that use FastStreamClient/FluidPlayer
 * These servers embed iframes that the page script needs to handle
 */
const FASTSTREAM_SERVERS: Record<string, { embedPattern: RegExp; priority: number }> = {
  "111movies": { embedPattern: /111movies/i, priority: 1 },
  // Additional FastStream-based servers can be added here
};

export class CinebtoExtractor extends BaseExtractor {
  name = "cinebto";
  patterns = [
    /cinebto\.[a-z]+/i,
    /cineb\.[a-z]+/i,
    /111movies\.[a-z]+/i,
    /111movies/i,
    /twasmerelyhers\.[a-z]+/i,
  ];

  /**
   * Get the server parameter from URL (cinebto.com specific)
   */
  getCurrentServer(url: string): string | null {
    try {
      const urlObj = new URL(url);
      return urlObj.searchParams.get("server");
    } catch {
      return null;
    }
  }

  /**
   * Check if URL is a FastStream-based server
   */
  isFastStreamServer(url: string): boolean {
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname.toLowerCase();

      for (const [_name, config] of Object.entries(FASTSTREAM_SERVERS)) {
        if (config.embedPattern.test(hostname) || config.embedPattern.test(url)) {
          return true;
        }
      }

      // Also check the ?server= parameter for cinebto URLs
      if (hostname.includes("cinebto") || hostname.includes("cineb")) {
        const server = urlObj.searchParams.get("server");
        if (server && FASTSTREAM_SERVERS[server]) {
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Extract from network responses (called by background script)
   * Filters out false positives like SubtitlesManager.mjs
   */
  extractFromResponse?(url: string, responseText: string): DetectedSubtitle[] {
    // Filter out .mjs files - they are JS modules, not subtitles
    if (/\.mjs(\?|$)/i.test(url)) {
      return [];
    }

    const subs: DetectedSubtitle[] = [];
    return subs;
  }

  /**
   * Get the injected script for FastStreamClient subtitle detection
   * This runs in the page context with access to window.FastStreamClient etc.
   */
  getInjectedScript(): string {
    return `
      // Cinebto / 111movies Subtitle Extractor
      // Detects subtitles from FastStreamClient/FluidPlayer players
      (function() {
        'use strict';

        const EXTRACTOR_ID = 'cinebto';
        const sentSubtitles = new Set();

        function log(...args) {
          console.log('[FFProfanity][cinebto]', ...args);
        }

        function sendSubtitles(subs, source) {
          if (!subs || subs.length === 0) return;

          const uniqueSubs = subs.filter(s => {
            if (!s.url) return false;
            // Filter out .mjs files (SubtitlesManager, etc.)
            if (/\\.mjs(\\?|$)/i.test(s.url)) return false;
            if (sentSubtitles.has(s.url)) return false;
            sentSubtitles.add(s.url);
            return true;
          });

          if (uniqueSubs.length === 0) return;

          log('Sending', uniqueSubs.length, 'subtitles from', source);

          window.postMessage({
            type: 'FFPROFANITY_SUBTITLES_DETECTED',
            source: source,
            subtitles: uniqueSubs.map(s => ({
              url: s.url,
              language: s.language || 'unknown',
              label: s.label || 'Unknown'
            }))
          }, '*');
        }

        // Strategy 1: FastStreamClient SubtitlesManager
        function extractFromFastStreamClient() {
          const subs = [];

          try {
            const fsc = window.FastStreamClient || window.fastStreamClient;
            if (fsc) {
              log('FastStreamClient found');

              const sm = fsc.subtitlesManager || fsc.SubtitlesManager;
              if (sm && typeof sm.getTracks === 'function') {
                const tracks = sm.getTracks();
                for (const track of tracks) {
                  if (track.url || track.src || track.file) {
                    subs.push({
                      url: track.url || track.src || track.file,
                      language: track.language || track.lang || track.code || 'unknown',
                      label: track.label || track.name || 'Unknown'
                    });
                  }
                }
              }

              if (fsc.player) {
                const player = fsc.player;
                if (player.subtitles && typeof player.subtitles.getTracks === 'function') {
                  const tracks = player.subtitles.getTracks();
                  for (const track of tracks) {
                    if (track.url || track.src || track.file) {
                      subs.push({
                        url: track.url || track.src || track.file,
                        language: track.language || 'unknown',
                        label: track.label || 'Unknown'
                      });
                    }
                  }
                }
              }
            }
          } catch (e) {
            log('FastStreamClient extraction error:', e.message || e);
          }

          return subs;
        }

        // Strategy 2: Video Element Track Detection
        function extractFromVideoElements() {
          const subs = [];
          const videos = document.querySelectorAll('video');

          for (const video of videos) {
            const trackElements = video.querySelectorAll('track[kind="subtitles"], track[kind="captions"]');
            for (const track of trackElements) {
              const url = track.src;
              if (url && !/\\.mjs(\\?|$)/i.test(url)) {
                subs.push({
                  url: url,
                  language: track.srclang || 'unknown',
                  label: track.label || 'Unknown'
                });
                log('Found video track element:', url);
              }
            }
          }

          return subs;
        }

        // Strategy 3: FluidPlayer Subtitle Detection
        function extractFromFluidPlayer() {
          const subs = [];

          try {
            if (window.fluidPlayerInstances && Array.isArray(window.fluidPlayerInstances)) {
              for (const instance of window.fluidPlayerInstances) {
                if (instance && instance.options && instance.options.subtitles) {
                  for (const sub of instance.options.subtitles) {
                    if (sub.url) {
                      subs.push({
                        url: sub.url,
                        language: sub.language || 'unknown',
                        label: sub.label || 'Unknown'
                      });
                    }
                  }
                }
              }
            }

            const wrappers = document.querySelectorAll('.fluid_video_wrapper, .mainplayer');
            for (const wrapper of wrappers) {
              const video = wrapper.querySelector('video');
              if (video) {
                const fpConfig = video.dataset.fluidPlayerConfig;
                if (fpConfig) {
                  try {
                    const config = JSON.parse(fpConfig);
                    if (config.subtitles) {
                      for (const sub of config.subtitles) {
                        subs.push({
                          url: sub.url,
                          language: sub.language || 'unknown',
                          label: sub.label || 'Unknown'
                        });
                      }
                    }
                  } catch (e) { /* Not valid JSON */ }
                }
              }
            }
          } catch (e) {
            log('FluidPlayer extraction error:', e.message || e);
          }

          return subs;
        }

        // Strategy 4: XHR/Fetch Interception
        function interceptNetworkRequests() {
          const originalXHROpen = XMLHttpRequest.prototype.open;
          const originalXHRSend = XMLHttpRequest.prototype.send;

          XMLHttpRequest.prototype.open = function(method, url) {
            this._ffprofanity_url = url;
            return originalXHROpen.apply(this, arguments);
          };

          XMLHttpRequest.prototype.send = function() {
            const xhr = this;
            const url = xhr._ffprofanity_url || '';

            // Check for subtitle URLs (but not .mjs modules URLs)
            if (/\\.(vtt|srt|ass|ssa)(\\?|$)/i.test(url) && !/\\.mjs(\\?|$)/i.test(url)) {
              log('XHR subtitle URL:', url);
              const lang = extractLanguageFromUrl(url);
              sendSubtitles([{
                url: url,
                language: lang,
                label: getLanguageName(lang)
              }], 'cinebto.xhr-subtitle');
            }

            return originalXHRSend.apply(this, arguments);
          };

          const originalFetch = window.fetch;

          window.fetch = function(input, init) {
            const url = typeof input === 'string' ? input : (input.url || '');

            if (/\\.(vtt|srt|ass|ssa)(\\?|$)/i.test(url) && !/\\.mjs(\\?|$)/i.test(url)) {
              log('Fetch subtitle URL:', url);
              const lang = extractLanguageFromUrl(url);
              sendSubtitles([{
                url: url,
                language: lang,
                label: getLanguageName(lang)
              }], 'cinebto.fetch-subtitle');
            }

            if (url.includes('subtitle') || url.includes('sub') || url.includes('caption')) {
              return originalFetch.apply(this, arguments).then(response => {
                const cloned = response.clone();
                cloned.text().then(text => {
                  try {
                    const data = JSON.parse(text);
                    const found = findSubtitlesRecursive(data);
                    if (found.length > 0) {
                      const filtered = found.filter(s => !/\\.mjs(\\?|$)/i.test(s.url));
                      sendSubtitles(filtered, 'cinebto.fetch-json');
                    }
                  } catch (e) { /* Not JSON */ }
                }).catch(() => {});
                return response;
              });
            }

            return originalFetch.apply(this, arguments);
          };
        }

        // Strategy 5: Monitor __NEXT_DATA__ for subtitle info
        function extractFromNextData() {
          const subs = [];

          try {
            const nextDataEl = document.getElementById('__NEXT_DATA__');
            if (nextDataEl) {
              const data = JSON.parse(nextDataEl.textContent || '{}');
              const found = findSubtitlesRecursive(data);
              const filtered = found.filter(s => !/\\.mjs(\\?|$)/i.test(s.url));
              subs.push(...filtered);
            }
          } catch (e) {
            // Not a Next.js page or no subtitle data
          }

          return subs;
        }

        // Helpers
        function extractLanguageFromUrl(url) {
          const patterns = [
            /[?&]lang=([a-z]{2,3})/i,
            /\\/([a-z]{2,3})_[a-f0-9]+\\.vtt$/i,
            /\\/([a-z]{2,3})\\/[^/]+\\.vtt$/i,
            /[_\\-\\.]([a-z]{2,3})\\.(vtt|srt|ass)$/i,
            /[_\\-]([a-z]{2,3})[._]/i,
          ];
          for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match) return match[1].toLowerCase();
          }
          return 'unknown';
        }

        function getLanguageName(code) {
          const names = {
            en: 'English', es: 'Spanish', fr: 'French', de: 'German',
            it: 'Italian', pt: 'Portuguese', ru: 'Russian', ja: 'Japanese',
            ko: 'Korean', zh: 'Chinese', ar: 'Arabic', hi: 'Hindi',
            nl: 'Dutch', pl: 'Polish', sv: 'Swedish', da: 'Danish',
            fi: 'Finnish', no: 'Norwegian', tr: 'Turkish', id: 'Indonesian',
            th: 'Thai', vi: 'Vietnamese', uk: 'Ukrainian', cs: 'Czech'
          };
          return names[code.toLowerCase()] || code.toUpperCase();
        }

        function findSubtitlesRecursive(obj) {
          const subs = [];
          if (!obj || typeof obj !== 'object') return subs;

          const urlKeys = ['file', 'url', 'src', 'downloadLink', 'path', 'link'];
          for (const key of urlKeys) {
            if (typeof obj[key] === 'string' && /\\.(vtt|srt|ass|ssa)/i.test(obj[key])) {
              if (/\\.mjs(\\?|$)/i.test(obj[key])) continue;
              subs.push({
                url: obj[key],
                language: obj.language || obj.lang || obj.code || extractLanguageFromUrl(obj[key]),
                label: obj.label || obj.name || 'Detected'
              });
            }
          }

          if (Array.isArray(obj)) {
            for (const item of obj) {
              subs.push(...findSubtitlesRecursive(item));
            }
          } else {
            const priorityKeys = ['subtitles', 'subs', 'captions', 'cc', 'text_tracks', 'tracks'];
            for (const key of priorityKeys) {
              if (obj[key]) {
                subs.push(...findSubtitlesRecursive(obj[key]));
              }
            }
          }

          return subs;
        }

        // Initialize
        function init() {
          log('Cinebto extractor initializing on:', window.location.hostname);

          const subs = [
            ...extractFromFastStreamClient(),
            ...extractFromVideoElements(),
            ...extractFromFluidPlayer(),
            ...extractFromNextData(),
          ];
          if (subs.length > 0) {
            sendSubtitles(subs, 'cinebto.init');
          }

          interceptNetworkRequests();

          // Watch for dynamically added video elements
          const videoObserver = new MutationObserver((mutations) => {
            let foundNew = false;
            for (const mutation of mutations) {
              for (const node of mutation.addedNodes) {
                if (node instanceof HTMLVideoElement) {
                  foundNew = true;
                } else if (node instanceof HTMLElement) {
                  if (node.querySelector('video')) {
                    foundNew = true;
                  }
                }
              }
            }
            if (foundNew) {
              const newSubs = [
                ...extractFromVideoElements(),
                ...extractFromFluidPlayer(),
              ];
              if (newSubs.length > 0) {
                sendSubtitles(newSubs, 'cinebto.video-added');
              }
            }
          });
          videoObserver.observe(document.body, { childList: true, subtree: true });

          // Periodically check for FastStreamClient (may load after page)
          let checks = 0;
          const checkInterval = setInterval(() => {
            checks++;
            const fscSubs = extractFromFastStreamClient();
            if (fscSubs.length > 0) {
              sendSubtitles(fscSubs, 'cinebto.faststream-poll');
            }
            if (checks >= 20) {
              clearInterval(checkInterval);
            }
          }, 500);
        }

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
export const cinebtoExtractor = new CinebtoExtractor();