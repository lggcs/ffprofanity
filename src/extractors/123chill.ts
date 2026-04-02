/**
 * 123chill.uk Site Extractor
 * Handles subtitle detection for 123chill.uk streaming site
 *
 * ARCHITECTURE:
 * 123chill.uk uses iframe-embedded video players from multiple sources.
 * The site provides 20+ video servers accessible via ?server= URL parameter.
 * Default server is vidsrc.mov (vidsrcto).
 *
 * SUBTITLE DETECTION STRATEGIES:
 * 1. VideoJS player remoteTextTrackEls() - works for VideoJS-based players
 * 2. HLS manifest parsing (EXT-X-MEDIA:TYPE=SUBTITLES)
 * 3. Video element <track> elements
 * 4. XHR/fetch interception for direct .vtt/.srt/.ass URLs
 * 5. JSON subtitle objects in network responses
 * 6. Iframe message passing for cross-origin player detection
 *
 * SERVERS SUPPORTED:
 * - vidsrcto (vidsrc.mov) - DEFAULT, highest priority
 * - vidzee, vidrock, vidsrc-wtf-1/2/3, vidnest, riveembed
 * - smashystream, 111movies, videasy, vidlink, vidfast
 * - embedsu, 2embed, moviesapi, autoembed, multiembed
 * - vidsrc-xyz, primewire, warezcdn, superflix, vidup
 */

import { BaseExtractor, DetectedSubtitle } from "./base";

/**
 * Known video servers on 123chill.uk
 * Maps server parameter to embed URL pattern
 */
const VIDEO_SERVERS: Record<
  string,
  { embedPattern: RegExp; priority: number }
> = {
  // Primary server (recommended)
  vidsrcto: { embedPattern: /vidsrc\.mov\/embed/i, priority: 1 },

  // Secondary reliable servers
  "vidsrc-wtf-1": { embedPattern: /vidsrc\.[a-z]+\/embed/i, priority: 2 },
  "vidsrc-wtf-2": { embedPattern: /vidsrc\.[a-z]+\/embed/i, priority: 3 },
  "vidsrc-wtf-3": { embedPattern: /vidsrc\.[a-z]+\/embed/i, priority: 4 },
  vidzee: { embedPattern: /vidzee/i, priority: 5 },
  vidrock: { embedPattern: /vidrock/i, priority: 6 },

  // Tertiary servers
  vidnest: { embedPattern: /vidnest/i, priority: 7 },
  riveembed: { embedPattern: /riveembed/i, priority: 8 },
  smashystream: { embedPattern: /smashystream/i, priority: 9 },
  "111movies": { embedPattern: /111movies/i, priority: 10 },
  videasy: { embedPattern: /videasy/i, priority: 11 },
  vidlink: { embedPattern: /vidlink/i, priority: 12 },
  vidfast: { embedPattern: /vidfast/i, priority: 13 },
  embedsu: { embedPattern: /embed\.su/i, priority: 14 },
  "2embed": { embedPattern: /2embed/i, priority: 15 },
  moviesapi: { embedPattern: /moviesapi/i, priority: 16 },
  autoembed: { embedPattern: /autoembed/i, priority: 17 },
  multiembed: { embedPattern: /multiembed/i, priority: 18 },
  "vidsrc-xyz": { embedPattern: /vidsrc\.xyz/i, priority: 19 },
  primewire: { embedPattern: /primewire/i, priority: 20 },
  warezcdn: { embedPattern: /warezcdn/i, priority: 21 },
  superflix: { embedPattern: /superflix/i, priority: 22 },
  vidup: { embedPattern: /vidup/i, priority: 23 },
};

export class OneTwoThreeChillExtractor extends BaseExtractor {
  name = "123chill";
  patterns = [
    /123chill\.uk/i,
    /123chill\.[a-z]+/i,
    /123movies\.uk/i, // Common alias
  ];

  /**
   * Extract TMDB ID from 123chill URL
   */
  extractTmdbId(url: string): string | null {
    try {
      const urlObj = new URL(url);
      // Pattern: /watch/movie/{tmdb_id} or /watch/tv/{tmdb_id}/season/{s}/episode/{e}
      const movieMatch = urlObj.pathname.match(/\/watch\/movie\/(\d+)/i);
      if (movieMatch) return movieMatch[1];

      const tvMatch = urlObj.pathname.match(/\/watch\/tv\/(\d+)/i);
      if (tvMatch) return tvMatch[1];

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Extract content type from URL
   */
  extractContentType(url: string): "movie" | "tv" | null {
    try {
      const urlObj = new URL(url);
      if (urlObj.pathname.includes("/movie/")) return "movie";
      if (urlObj.pathname.includes("/tv/")) return "tv";
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Get current server from URL parameter
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
   * Get the injected script for 123chill-specific extraction
   * This script runs in the page context with access to XHR, fetch, and window objects
   */
  getInjectedScript(): string {
    return `
      // 123chill.uk Subtitle Extractor - Multi-strategy detection
      // Strategy 1: VideoJS player remoteTextTrackEls()
      // Strategy 2: HLS manifest subtitle tracks
      // Strategy 3: Video element <track> elements
      // Strategy 4: XHR/fetch interception for direct subtitle files
      // Strategy 5: Iframe message monitoring
      // Strategy 6: Network response parsing

      (function() {
        'use strict';

        const EXTRACTOR_ID = '123chill';
        const sentSubtitles = new Set();
        const currentServer = new URLSearchParams(window.location.search).get('server') || 'vidsrcto';

        // Debug logging helper
        function log(...args) {
          console.log('[123chill]', ...args);
        }

        // Send detected subtitles to content script
        function sendSubtitles(subs, source) {
          if (!subs || subs.length === 0) return;

          // Deduplicate by URL
          const uniqueSubs = subs.filter(s => {
            if (!s.url) return false;
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
              label: s.label || 'Unknown',
              server: currentServer
            }))
          }, '*');
        }

        // ========================================
        // Strategy 1: VideoJS Player Detection
        // ========================================
        function extractFromVideoJS() {
          const subs = [];

          try {
            // Check for videojs global
            if (typeof window.videojs !== 'undefined' && window.videojs) {
              log('VideoJS found, checking for players...');

              // Get player instances
              const getPlayerIds = window.videojs.getPlayerIds;
              if (typeof getPlayerIds === 'function') {
                const players = getPlayerIds.call(window.videojs) || [];
                log('VideoJS player IDs:', players);

                for (const playerId of players) {
                  const getPlayer = window.videojs.getPlayer;
                  if (typeof getPlayer !== 'function') continue;

                  const player = getPlayer.call(window.videojs, playerId);
                  if (!player) continue;

                  // Get remote text track elements (these have .src URLs)
                  if (typeof player.remoteTextTrackEls === 'function') {
                    const trackEls = player.remoteTextTrackEls() || [];
                    for (let i = 0; i < trackEls.length; i++) {
                      const trackEl = trackEls[i];
                      if (trackEl && trackEl.src) {
                        const track = (typeof player.textTracks === 'function' && player.textTracks()[i]) || null;
                        subs.push({
                          url: trackEl.src,
                          language: track?.language || trackEl.getAttribute?.('srclang') || 'unknown',
                          label: track?.label || trackEl.getAttribute?.('label') || 'Unknown'
                        });
                        log('Found VideoJS remote track:', trackEl.src);
                      }
                    }
                  }

                  // Also check textTracks directly
                  if (typeof player.textTracks === 'function') {
                    const textTracks = player.textTracks() || [];
                    for (let i = 0; i < textTracks.length; i++) {
                      const track = textTracks[i];
                      if (track.kind === 'subtitles' || track.kind === 'captions') {
                        const remoteEls = typeof player.remoteTextTrackEls === 'function' ? player.remoteTextTrackEls() : [];
                        const trackEl = remoteEls[i];
                        const url = trackEl?.src;
                        if (url && !subs.some(s => s.url === url)) {
                          subs.push({
                            url: url,
                            language: track.language || 'unknown',
                            label: track.label || 'Unknown'
                          });
                          log('Found VideoJS text track:', url);
                        }
                      }
                    }
                  }
                }
              }
            }

            // Check videojs.players object directly
            if (window.videojs && window.videojs.players) {
              const playerIds = Object.keys(window.videojs.players);
              log('videojs.players keys:', playerIds);

              for (const playerId of playerIds) {
                const playerData = window.videojs.players[playerId];
                if (playerData && typeof playerData.remoteTextTrackEls === 'function') {
                  const trackEls = playerData.remoteTextTrackEls() || [];
                  for (let i = 0; i < trackEls.length; i++) {
                    const trackEl = trackEls[i];
                    if (trackEl && trackEl.src) {
                      const urlLang = extractLanguageFromUrl(trackEl.src);
                      const lang = trackEl.getAttribute?.('srclang') || urlLang || 'unknown';
                      const label = trackEl.getAttribute?.('label') || getLanguageName(lang) || 'Unknown';
                      subs.push({
                        url: trackEl.src,
                        language: lang,
                        label: label
                      });
                      log('Found track via players object:', trackEl.src);
                    }
                  }
                }
              }
            }
          } catch (e) {
            log('VideoJS extraction error:', e.message || e);
          }

          return subs;
        }

        // ========================================
        // Strategy 2: Video Element Track Elements
        // ========================================
        function extractFromVideoElements() {
          const subs = [];
          const videos = document.querySelectorAll('video');

          for (const video of videos) {
            // Check <track> elements
            const trackElements = video.querySelectorAll('track[kind="subtitles"], track[kind="captions"]');
            for (const track of trackElements) {
              const url = track.src;
              if (url) {
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

        // ========================================
        // Strategy 3: Iframe Player Monitoring
        // For iframe-embedded players, we need to monitor the iframe
        // ========================================
        function monitorIframePlayer() {
          const playerFrame = document.getElementById('playerFrame');
          if (!playerFrame) {
            log('No playerFrame found, watching for iframe...');
            watchForIframe();
            return;
          }

          log('Found playerFrame iframe:', playerFrame.src);

          // Monitor for iframe source changes (server switches)
          let lastSrc = playerFrame.src;
          const checkInterval = setInterval(() => {
            if (playerFrame.src !== lastSrc) {
              lastSrc = playerFrame.src;
              log('Iframe source changed to:', playerFrame.src);
              // Re-scan for subtitles after server switch
              setTimeout(() => checkAndSendTracks('123chill.iframe-change'), 500);
              setTimeout(() => checkAndSendTracks('123chill.iframe-change-delayed'), 2000);
            }
          }, 1000);

          // Try to communicate with iframe (may fail due to cross-origin)
          try {
            const iframeWindow = playerFrame.contentWindow;
            if (iframeWindow) {
              // Listen for messages from iframe
              window.addEventListener('message', (event) => {
                // Check for subtitle data from iframe
                if (event.data && event.data.type === 'SUBTITLES_DETECTED') {
                  log('Received subtitles from iframe:', event.data.subtitles);
                  sendSubtitles(event.data.subtitles, '123chill.iframe-message');
                }
              });
            }
          } catch (e) {
            log('Cannot access iframe content (cross-origin):', e.message);
          }
        }

        // ========================================
        // Watch for iframe creation
        // ========================================
        function watchForIframe() {
          const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
              for (const node of mutation.addedNodes) {
                if (node instanceof HTMLIFrameElement) {
                  if (node.id === 'playerFrame' || node.src?.includes('vidsrc') || node.src?.includes('embed')) {
                    log('Player iframe detected');
                    setTimeout(() => checkAndSendTracks('123chill.iframe-created'), 200);
                    setTimeout(() => checkAndSendTracks('123chill.iframe-created-delayed'), 1000);
                  }
                }
              }
            }
          });
          observer.observe(document.body, { childList: true, subtree: true });
        }

        // ========================================
        // Strategy 4: HLS Manifest Parsing
        // ========================================
        function parseHLSManifest(content, baseUrl) {
          const subs = [];
          const lines = content.split('\\n');
          let currentSub = null;

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            // #EXT-X-MEDIA:TYPE=SUBTITLES
            if (line.startsWith('#EXT-X-MEDIA:TYPE=SUBTITLES')) {
              currentSub = { type: 'subtitles' };

              // Parse attributes
              const langMatch = line.match(/LANGUAGE="([^"]+)"/i);
              const nameMatch = line.match(/NAME="([^"]+)"/i);
              const groupIdMatch = line.match(/GROUP-ID="([^"]+)"/i);

              if (langMatch) currentSub.language = langMatch[1].toLowerCase();
              if (nameMatch) currentSub.label = nameMatch[1];
              if (groupIdMatch) currentSub.groupId = groupIdMatch[1];
            }

            // URI line after EXT-X-MEDIA
            if (currentSub && !line.startsWith('#') && line.length > 0) {
              const subUrl = new URL(line, baseUrl).href;
              subs.push({
                url: subUrl,
                language: currentSub.language || 'unknown',
                label: currentSub.label || currentSub.language || 'Unknown'
              });
              currentSub = null;
            }
          }

          return subs;
        }

        // ========================================
        // Strategy 5: XHR/Fetch Interception
        // ========================================
        function interceptXHR() {
          const originalXHROpen = XMLHttpRequest.prototype.open;
          const originalXHRSend = XMLHttpRequest.prototype.send;

          XMLHttpRequest.prototype.open = function(method, url) {
            this._ffprofanity_url = url;
            return originalXHROpen.apply(this, arguments);
          };

          XMLHttpRequest.prototype.send = function() {
            const xhr = this;

            xhr.addEventListener('load', function() {
              const reqUrl = xhr._ffprofanity_url || '';
              const canReadResponseText = xhr.responseType === '' || xhr.responseType === 'text';

              // HLS Manifest subtitle extraction
              if (canReadResponseText && (reqUrl.includes('.m3u8') || reqUrl.includes('master') || reqUrl.includes('playlist'))) {
                try {
                  const content = xhr.responseText;
                  const subs = parseHLSManifest(content, reqUrl);
                  if (subs.length > 0) {
                    log('Found', subs.length, 'subs in HLS manifest:', reqUrl.substring(0, 60));
                    sendSubtitles(subs, '123chill.hls');
                  }
                } catch (e) { /* Not valid HLS */ }
              }

              // Direct subtitle URLs (.vtt, .srt, .ass)
              if (/\\.(vtt|srt|ass|ssa)(\\?|$)/i.test(reqUrl)) {
                log('Intercepted subtitle URL:', reqUrl);
                const lang = extractLanguageFromUrl(reqUrl);
                sendSubtitles([{
                  url: reqUrl,
                  language: lang,
                  label: getLanguageName(lang)
                }], '123chill.xhr-subtitle');
              }

              // JSON responses with subtitle data
              if (canReadResponseText && xhr.responseText) {
                try {
                  const data = JSON.parse(xhr.responseText);
                  const subs = findSubtitlesRecursive(data);
                  if (subs.length > 0) {
                    log('Found', subs.length, 'subs in JSON:', reqUrl.substring(0, 60));
                    sendSubtitles(subs, '123chill.json');
                  }
                } catch (e) { /* Not JSON */ }
              }
            });

            return originalXHRSend.apply(this, arguments);
          };
        }

        // ========================================
        // Strategy 6: Fetch Interception
        // ========================================
        function interceptFetch() {
          const originalFetch = window.fetch;

          window.fetch = function(input, init) {
            const url = typeof input === 'string' ? input : (input.url || '');

            return originalFetch.apply(this, arguments).then(response => {
              // Direct subtitle URLs
              if (/\\.(vtt|srt|ass|ssa)(\\?|$)/i.test(url)) {
                log('Fetch subtitle URL:', url);
                const lang = extractLanguageFromUrl(url);
                sendSubtitles([{
                  url: url,
                  language: lang,
                  label: getLanguageName(lang)
                }], '123chill.fetch-subtitle');
              }

              // HLS manifests
              if (url.includes('.m3u8') || url.includes('master') || url.includes('playlist')) {
                response.clone().text().then(content => {
                  const subs = parseHLSManifest(content, url);
                  if (subs.length > 0) {
                    sendSubtitles(subs, '123chill.fetch-hls');
                  }
                }).catch(() => {});
              }

              // JSON responses with subtitle data
              if (url.includes('subtitle') || url.includes('caption') || url.includes('tracks')) {
                response.clone().json().then(data => {
                  const subs = findSubtitlesRecursive(data);
                  if (subs.length > 0) {
                    sendSubtitles(subs, '123chill.fetch-json');
                  }
                }).catch(() => {});
              }

              return response;
            });
          };
        }

        // ========================================
        // Helper: Extract language from URL
        // NOTE: Duplicated from lib/language.ts for injected script context
        // ========================================
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

        // ========================================
        // Helper: Language code to name
        // NOTE: Duplicated from lib/language.ts for injected script context
        // ========================================
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

        // ========================================
        // Helper: Recursively find subtitles in objects
        // ========================================
        function findSubtitlesRecursive(obj) {
          const subs = [];
          if (!obj || typeof obj !== 'object') return subs;

          // Check for subtitle-like objects
          const urlKeys = ['file', 'url', 'src', 'downloadLink', 'path', 'link'];
          for (const key of urlKeys) {
            if (typeof obj[key] === 'string' && /\\.(vtt|srt|ass|ssa)/i.test(obj[key])) {
              subs.push({
                url: obj[key],
                language: obj.language || obj.lang || obj.code || extractLanguageFromUrl(obj[key]),
                label: obj.label || obj.name || 'Detected'
              });
            }
          }

          // Recurse into arrays and objects
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

        // ========================================
        // Combine all strategies
        // ========================================
        function checkAndSendTracks(source) {
          const allSubs = [];

          // Strategy 1: VideoJS
          const videojsSubs = extractFromVideoJS();
          allSubs.push(...videojsSubs);

          // Strategy 2: Video elements
          const videoSubs = extractFromVideoElements();
          allSubs.push(...videoSubs);

          if (allSubs.length > 0) {
            sendSubtitles(allSubs, source);
          }
        }

        // ========================================
        // CC button click detection
        // ========================================
        function setupCCButtonDetection() {
          document.addEventListener('click', function(e) {
            const ccSelectors = [
              '[class*="cc"]', '[class*="caption"]', '[class*="subtitle"]',
              '[aria-label*="subtitle"]', '[aria-label*="caption"]', '[aria-label*="cc"]',
              '.ytp-subtitles-button', '.cc-button', '.vjs-subtitles-button',
              '.vjs-captions-button', '[data-testid="cc-button"]',
              '.vjs-subs-caps-button', '.vjs-texttrack-settings'
            ];
            const target = e.target;
            for (const sel of ccSelectors) {
              if (target.matches && (target.matches(sel) || target.closest?.(sel))) {
                log('CC button clicked');
                setTimeout(() => checkAndSendTracks('123chill.cc-click'), 200);
                setTimeout(() => checkAndSendTracks('123chill.cc-click-delayed'), 1000);
                setTimeout(() => checkAndSendTracks('123chill.cc-click-slow'), 3000);
                break;
              }
            }
          }, true);
        }

        // ========================================
        // Server switch detection
        // ========================================
        function watchForServerSwitch() {
          let lastUrl = location.href;

          // Watch for URL changes (server switches via ?server= param)
          const originalPushState = history.pushState;
          const originalReplaceState = history.replaceState;

          if (originalPushState) {
            history.pushState = function(...args) {
              originalPushState.apply(this, args);
              if (location.href !== lastUrl) {
                lastUrl = location.href;
                log('URL changed (server switch?):', location.href);
                sentSubtitles.clear();
                setTimeout(() => checkAndSendTracks('123chill.url-change'), 500);
                setTimeout(() => checkAndSendTracks('123chill.url-change-delayed'), 2000);
              }
            };
          }

          if (originalReplaceState) {
            history.replaceState = function(...args) {
              originalReplaceState.apply(this, args);
              if (location.href !== lastUrl) {
                lastUrl = location.href;
                log('URL changed (server switch?):', location.href);
                sentSubtitles.clear();
                setTimeout(() => checkAndSendTracks('123chill.url-change'), 500);
                setTimeout(() => checkAndSendTracks('123chill.url-change-delayed'), 2000);
              }
            };
          }

          window.addEventListener('popstate', () => {
            if (location.href !== lastUrl) {
              lastUrl = location.href;
              log('Popstate URL change');
              sentSubtitles.clear();
              setTimeout(() => checkAndSendTracks('123chill.popstate'), 500);
            }
          });
        }

        // ========================================
        // Initialize
        // ========================================
        function init() {
          log('Extractor initializing for server:', currentServer);

          // Setup interceptors
          interceptXHR();
          interceptFetch();

          // Setup watchers
          setupCCButtonDetection();
          watchForServerSwitch();
          monitorIframePlayer();

          // Initial checks with delays for dynamic content
          setTimeout(() => checkAndSendTracks('123chill.init-500'), 500);
          setTimeout(() => checkAndSendTracks('123chill.init-2000'), 2000);
          setTimeout(() => checkAndSendTracks('123chill.init-5000'), 5000);
          setTimeout(() => checkAndSendTracks('123chill.init-10000'), 10000);

          log('Extractor ready');
        }

        // Run on DOM ready
        if (document.readyState === 'complete' || document.readyState === 'interactive') {
          init();
        } else {
          document.addEventListener('DOMContentLoaded', init);
        }
      })();
    `;
  }
}

export const oneTwoThreeChillExtractor = new OneTwoThreeChillExtractor();
