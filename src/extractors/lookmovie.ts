/**
 * LookMovie Site Extractor
 * Handles subtitle detection for lookmovie.to and variants
 *
 * RESEARCH FINDINGS (March 2026):
 * - LookMovie uses VideoJS player (player-*.js)
 * - VideoJS uses VHS (Video.js HTTP Streaming) for HLS
 * - Subtitles may be in:
 *   1. HLS manifest (EXT-X-MEDIA:TYPE=SUBTITLES)
 *   2. VideoJS remoteTextTrackEls() - accessible via player object
 *   3. Legacy movie_storage.text_tracks (may be deprecated)
 *
 * APPROACH:
 * 1. Try VideoJS player instance for remoteTextTrackEls()
 * 2. Intercept HLS manifest responses for subtitle tracks
 * 3. Intercept direct .vtt/.srt file requests
 * 4. Fallback to movie_storage.text_tracks
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
   * Uses multiple detection strategies for robustness
   */
  getInjectedScript(): string {
    return `
      // LookMovie Subtitle Extractor - Multi-strategy detection
      // Strategy 1: VideoJS player remoteTextTrackEls()
      // Strategy 2: HLS manifest subtitle tracks
      // Strategy 3: Direct .vtt/.srt URL interception
      // Strategy 4: Legacy movie_storage.text_tracks

      (function() {
        'use strict';

        const EXTRACTOR_ID = 'lookmovie';
        const sentSubtitles = new Set();
        let lastTracksHash = '';

        // Debug logging helper
        function log(...args) {
          console.log('[LookMovie]', ...args);
        }

        function sendSubtitles(subs, source) {
          if (!subs || subs.length === 0) return;

          // Deduplicate by content hash
          const key = JSON.stringify(subs);
          if (sentSubtitles.has(key)) return;
          sentSubtitles.add(key);

          log('Sending', subs.length, 'subtitles from', source);
          window.postMessage({
            type: 'FFPROFANITY_SUBTITLES_DETECTED',
            source: source,
            subtitles: subs
          }, '*');
        }

        // ========================================
        // Strategy 1: VideoJS Player Detection
        // ========================================
        function extractFromVideoJS() {
          const subs = [];

          try {
            // Method 1a: Check for videojs global - MUST check typeof first
            if (typeof window.videojs !== 'undefined' && window.videojs) {
              log('VideoJS found, checking for players...');
              
              // Safely get players
              const getPlayerIds = window.videojs.getPlayerIds;
              if (typeof getPlayerIds === 'function') {
                const players = getPlayerIds.call(window.videojs) || [];
                log('VideoJS player IDs:', players);

                for (const playerId of players) {
                  const getPlayer = window.videojs.getPlayer;
                  if (typeof getPlayer !== 'function') continue;

                  const player = getPlayer.call(window.videojs, playerId);
                  if (!player) {
                    log('No player for ID:', playerId);
                    continue;
                  }
                  log('Got player for:', playerId, 'has remoteTextTrackEls:', typeof player.remoteTextTrackEls);

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
                        // Try to find URL from various sources
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

            // Method 1b: Check for 'player' global variable (some sites use this)
            if (window.player && typeof window.player === 'object') {
              const player = window.player;
              log('Found window.player global');
              if (typeof player.remoteTextTrackEls === 'function') {
                const trackEls = player.remoteTextTrackEls() || [];
                for (let i = 0; i < trackEls.length; i++) {
                  const trackEl = trackEls[i];
                  if (trackEl && trackEl.src) {
                    subs.push({
                      url: trackEl.src,
                      language: trackEl.getAttribute?.('srclang') || 'unknown',
                      label: trackEl.getAttribute?.('label') || 'Unknown'
                    });
                    log('Found player global track:', trackEl.src);
                  }
                }
              }
            }
            
            // Method 1c: Check videojs.players object directly
            if (window.videojs && window.videojs.players) {
              const playerIds = Object.keys(window.videojs.players);
              log('videojs.players keys:', playerIds);

              for (const playerId of playerIds) {
                const playerData = window.videojs.players[playerId];
                if (playerData && typeof playerData === 'object') {
                  log('Checking player data for:', playerId);
                  // Check if playerData is the player instance itself
                  if (typeof playerData.remoteTextTrackEls === 'function') {
                    const trackEls = playerData.remoteTextTrackEls() || [];
                    log('Found', trackEls.length, 'track elements in players object');
                    for (let i = 0; i < trackEls.length; i++) {
                      const trackEl = trackEls[i];
                      if (trackEl && trackEl.src) {
                        // Extract language from URL if not in attributes (e.g., en_3dda8f7b...vtt)
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
            }
          } catch (e) {
            log('VideoJS extraction error:', e.message || e);
          }

          return subs;
        }

        // ========================================
        // Strategy 2: Legacy movie_storage.text_tracks
        // ========================================
        function extractFromMovieStorage() {
          const tracks = window.movie_storage?.text_tracks;
          
          if (!tracks || !Array.isArray(tracks) || tracks.length === 0) {
            // Try alternative property names
            const altTracks = window.movie_storage?.subs || 
                             window.movie_storage?.subtitles || 
                             window.movie_storage?.cc ||
                             window.movie_storage?.captions;
            if (altTracks && Array.isArray(altTracks) && altTracks.length > 0) {
              log('Found', altTracks.length, 'tracks in alternative movie_storage property');
              return altTracks.map(t => ({
                url: t.file || t.url || t.src || t.downloadLink || t.path || t.src,
                language: t.language || t.lang || t.code || 'unknown',
                label: t.label || t.name || t.language || 'Unknown'
              })).filter(s => s.url);
            }
            return [];
          }

          log('Found', tracks.length, 'tracks in movie_storage.text_tracks');

          return tracks.map(t => ({
            url: t.file || t.url || t.src || t.downloadLink || t.path,
            language: t.language || t.lang || t.code || 'unknown',
            label: t.label || t.name || t.language || 'Unknown'
          })).filter(s => s.url);
        }

        // ========================================
        // Deep watch movie_storage.text_tracks array changes
        // Use polling only - property interceptors break page initialization
        // ========================================
        let lastTextTracksJson = '';
        let textTracksCheckInterval = null;

        function setupTextTracksWatcher() {
          // Poll for text_tracks changes
          textTracksCheckInterval = setInterval(() => {
            const tracks = window.movie_storage?.text_tracks;
            if (tracks && Array.isArray(tracks)) {
              const tracksJson = JSON.stringify(tracks);
              if (tracksJson !== lastTextTracksJson && tracksJson !== '[]' && tracksJson !== '') {
                lastTextTracksJson = tracksJson;
                log('text_tracks changed, length:', tracks.length);
                checkAndSendTracks('lookmovie.text_tracks_poll');
              }
            }
          }, 500);
        }

        // ========================================
        // Strategy 3: Video Element Track Elements
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

            // Check textTracks API
            for (const textTrack of video.textTracks) {
              if (textTrack.kind === 'subtitles' || textTrack.kind === 'captions') {
                // Try to get URL from cues if available
                if (textTrack.cues && textTrack.cues.length > 0) {
                  // Track is loaded but we can't get URL from cues
                  // Still mark it as available
                  log('Found loaded textTrack:', textTrack.label, textTrack.language);
                }
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

          // Strategy 2: movie_storage (legacy)
          const storageSubs = extractFromMovieStorage();
          allSubs.push(...storageSubs);

          // Strategy 3: Video elements
          const videoSubs = extractFromVideoElements();
          allSubs.push(...videoSubs);

          if (allSubs.length > 0) {
            sendSubtitles(allSubs, source);
          }
        }

        // ========================================
        // Watch for VideoJS player initialization
        // Use polling and events only - property interceptors break page initialization
        // ========================================
        function watchForVideoJS() {
          // Check if VideoJS is already loaded
          if (typeof window.videojs !== 'undefined') {
            log('VideoJS already available');
            setTimeout(() => checkAndSendTracks('lookmovie.videojs-ready'), 100);
            setTimeout(() => checkAndSendTracks('lookmovie.videojs-delayed'), 2000);
          }

          // Poll for videojs becoming available
          let videojsCheckCount = 0;
          const videojsCheckInterval = setInterval(() => {
            videojsCheckCount++;
            if (typeof window.videojs !== 'undefined') {
              clearInterval(videojsCheckInterval);
              log('VideoJS detected via polling');
              setTimeout(() => checkAndSendTracks('lookmovie.videojs-polled'), 100);
              setTimeout(() => checkAndSendTracks('lookmovie.videojs-polled-delayed'), 2000);
            } else if (videojsCheckCount > 200) {
              clearInterval(videojsCheckInterval);
            }
          }, 100);

          // Watch for player element creation
          const playerObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
              for (const node of mutation.addedNodes) {
                if (node instanceof HTMLVideoElement) {
                  log('Video element added');
                  setTimeout(() => checkAndSendTracks('lookmovie.video-added'), 200);
                  setTimeout(() => checkAndSendTracks('lookmovie.video-added-delayed'), 1000);
                }
              }
            }
          });
          playerObserver.observe(document.body, { childList: true, subtree: true });
        }

        // ========================================
        // Hijack XHR for HLS manifest and subtitle files
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

              // Check if responseText is accessible (only for '' or 'text' responseType)
              const canReadResponseText = xhr.responseType === '' || xhr.responseType === 'text';

              // Strategy 2a: HLS Manifest subtitle extraction
              if (canReadResponseText && (reqUrl.includes('.m3u8') || reqUrl.includes('master') || reqUrl.includes('playlist'))) {
                try {
                  const content = xhr.responseText;
                  const subs = parseHLSManifest(content, reqUrl);
                  if (subs.length > 0) {
                    log('Found', subs.length, 'subs in HLS manifest:', reqUrl.substring(0, 60));
                    sendSubtitles(subs, 'lookmovie.hls');
                  }
                } catch (e) { /* Not valid HLS */ }
              }

              // Strategy 3: Direct subtitle URLs (.vtt, .srt, .ass)
              if (/\\.(vtt|srt|ass|ssa)/i.test(reqUrl) && !reqUrl.includes('blob:')) {
                log('Intercepted subtitle URL:', reqUrl);
                const lang = extractLanguageFromUrl(reqUrl);
                sendSubtitles([{
                  url: reqUrl,
                  language: lang,
                  label: getLanguageName(lang)
                }], 'lookmovie.xhr-subtitle');
              }

              // JSON responses may contain subtitle data
              if (canReadResponseText && xhr.responseText && (reqUrl.includes('/api/') || reqUrl.includes('subtitle'))) {
                try {
                  const data = JSON.parse(xhr.responseText);
                  const subs = findSubtitlesRecursive(data);
                  if (subs.length > 0) {
                    log('Found', subs.length, 'subs in JSON:', reqUrl.substring(0, 60));
                    sendSubtitles(subs, 'lookmovie.json');
                  }
                } catch (e) { /* Not JSON */ }
              }
            });

            return originalXHRSend.apply(this, arguments);
          };
        }

        // ========================================
        // Hijack fetch API
        // ========================================
        function interceptFetch() {
          const originalFetch = window.fetch;

          window.fetch = function(input, init) {
            const url = typeof input === 'string' ? input : (input.url || '');

            return originalFetch.apply(this, arguments).then(response => {
              // Direct subtitle URLs
              if (/\\.(vtt|srt|ass|ssa)/i.test(url)) {
                log('Fetch subtitle URL:', url);
                const lang = extractLanguageFromUrl(url);
                sendSubtitles([{
                  url: url,
                  language: lang,
                  label: getLanguageName(lang)
                }], 'lookmovie.fetch-subtitle');
              }

              // HLS manifests
              if (url.includes('.m3u8') || url.includes('master') || url.includes('playlist')) {
                response.clone().text().then(content => {
                  const subs = parseHLSManifest(content, url);
                  if (subs.length > 0) {
                    sendSubtitles(subs, 'lookmovie.fetch-hls');
                  }
                }).catch(() => {});
              }

              return response;
            });
          };
        }

        // ========================================
        // Helper: Parse HLS manifest for subtitles
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
        // Helper: Extract language from URL
        // ========================================
        function extractLanguageFromUrl(url) {
          const patterns = [
            /[?&]lang=([a-z]{2,3})/i,
            /\\/([a-z]{2,3})_[a-f0-9]+\\.vtt$/i,
            /\\/([a-z]{2,3})\\/[^/]+\\.vtt$/i,
            /[_\\-\\.]([a-z]{2,3})\\.(vtt|srt|ass)$/i
          ];
          for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match) return match[1].toLowerCase();
          }
          return 'unknown';
        }

        // ========================================
        // Helper: Language code to name
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
          const urlKeys = ['file', 'url', 'src', 'downloadLink', 'path'];
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
                setTimeout(() => checkAndSendTracks('lookmovie.cc-click'), 200);
                setTimeout(() => checkAndSendTracks('lookmovie.cc-click-delayed'), 1000);
                setTimeout(() => checkAndSendTracks('lookmovie.cc-click-slow'), 3000);
                break;
              }
            }
          }, true);
        }

        // ========================================
        // Watch for video player changes (ads -> main content)
        // LookMovie plays 10-second ads before the main video
        // ========================================
        function watchForPlayerTransition() {
          log('Watching for player transitions (ad -> content)');

          // Watch for video element source changes
          let lastSrc = '';
          const checkVideoSrc = () => {
            const video = document.querySelector('video');
            if (video && video.src && video.src !== lastSrc) {
              lastSrc = video.src;
              log('Video source changed:', video.src.substring(0, 60));
              // Re-check for subtitles when video source changes
              setTimeout(() => checkAndSendTracks('lookmovie.video-src-change'), 500);
              setTimeout(() => checkAndSendTracks('lookmovie.video-src-delayed'), 2000);
              setTimeout(() => checkAndSendTracks('lookmovie.video-src-slow'), 5000);
            }
          };

          // Poll for video src changes
          setInterval(checkVideoSrc, 1000);

          // Also watch for video element events
          document.addEventListener('playing', function(e) {
            if (e.target instanceof HTMLVideoElement) {
              log('Video playing event');
              checkVideoSrc();
              setTimeout(() => checkAndSendTracks('lookmovie.video-playing'), 500);
            }
          }, true);

          // Watch for player ready state
          document.addEventListener('loadedmetadata', function(e) {
            if (e.target instanceof HTMLVideoElement) {
              log('Video loadedmetadata event');
              setTimeout(() => checkAndSendTracks('lookmovie.video-metadata'), 200);
            }
          }, true);
        }

        // ========================================
        // Initialize
        // ========================================
        function init() {
          log('Extractor initializing');

          // Setup interceptors
          interceptXHR();
          interceptFetch();

          // Setup watchers
          watchForVideoJS();
          setupCCButtonDetection();
          watchForPlayerTransition();

          // Setup movie_storage watcher (polling + property intercept)
          if (window.movie_storage) {
            setupTextTracksWatcher();
            // Initial check
            const tracks = window.movie_storage.text_tracks;
            if (tracks && tracks.length > 0) {
              checkAndSendTracks('lookmovie.storage-initial');
            }
          } else {
            // Poll for movie_storage to appear
            let attempts = 0;
            const checkInterval = setInterval(() => {
              attempts++;
              if (window.movie_storage) {
                clearInterval(checkInterval);
                setupTextTracksWatcher();
                const tracks = window.movie_storage.text_tracks;
                if (tracks && tracks.length > 0) {
                  checkAndSendTracks('lookmovie.storage-found');
                }
              } else if (attempts > 100) {
                clearInterval(checkInterval);
              }
            }, 200);
          }

          // Delayed checks for dynamic content (including after ad playback)
          setTimeout(() => checkAndSendTracks('lookmovie.init-500'), 500);
          setTimeout(() => checkAndSendTracks('lookmovie.init-2000'), 2000);
          setTimeout(() => checkAndSendTracks('lookmovie.init-5000'), 5000);
          // Extra delayed check for ad-supported sites like LookMovie
          setTimeout(() => checkAndSendTracks('lookmovie.init-10000'), 10000);
          setTimeout(() => checkAndSendTracks('lookmovie.init-15000'), 15000);
          setTimeout(() => checkAndSendTracks('lookmovie.init-20000'), 20000);

          log('Extractor ready');
        }

        // Run
        init();
      })();
    `;
  }
}

export const lookMovieExtractor = new LookMovieExtractor();