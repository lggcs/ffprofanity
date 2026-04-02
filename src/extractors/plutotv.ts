/**
 * PlutoTV Site Extractor
 * Handles subtitle detection for plutotv.com and pluto.tv
 *
 * ARCHITECTURE:
 * PlutoTV is a free ad-supported streaming (FAST) service using:
 * - HLS streaming (.m3u8 manifests)
 * - WebVTT subtitle format with X-TIMESTAMP-MAP headers
 * - Custom web player (not VideoJS/JWPlayer)
 * - JWT token authentication for streams
 * - SPA architecture with dynamic content loading
 *
 * SUBTITLE DETECTION STRATEGIES:
 * 1. HLS manifest parsing (EXT-X-MEDIA:TYPE=SUBTITLES)
 * 2. XHR/fetch interception for direct .vtt/.srt URLs
 * 3. Video element <track> element detection
 * 4. video.textTracks API inspection
 * 5. Network response parsing for JSON subtitle data
 *
 * URL PATTERNS:
 * - pluto.tv/us/live-tv/{channel_id} - Live TV channels
 * - pluto.tv/us/on-demand/movies/{slug} - VOD movies
 * - pluto.tv/us/on-demand/series/{slug} - VOD series
 * - plutotv.com - Alternate domain
 */

import { BaseExtractor, DetectedSubtitle } from "./base";

export class PlutoTVExtractor extends BaseExtractor {
  name = "plutotv";
  patterns = [
    /pluto\.tv/i,
    /plutotv\.com/i,
    /pluto\.tv\/live-tv/i,
    /pluto\.tv\/on-demand/i,
  ];

  /**
   * Get the injected script for PlutoTV-specific extraction
   * Runs in page context to intercept network requests and detect subtitles
   */
  getInjectedScript(): string {
    return `
      // PlutoTV Subtitle Extractor - Multi-strategy detection
      // Strategy 1: HLS manifest parsing (EXT-X-MEDIA:TYPE=SUBTITLES)
      // Strategy 2: XHR/fetch interception for subtitle URLs
      // Strategy 3: Video element track detection
      // Strategy 4: Network response parsing
      // Strategy 5: SPA navigation handling

      (function() {
        'use strict';

        const EXTRACTOR_ID = 'plutotv';
        const sentSubtitles = new Set();

        const FONT_EXTENSIONS = ['.otf', '.ttf', '.woff', '.woff2', '.eot'];
        const SUBTITLE_EXTENSIONS = ['.vtt', '.srt', '.ass', '.ssa', '.sub'];

        function log(...args) {
          console.log('[PlutoTV]', ...args);
        }

        function isValidSubtitleUrl(url) {
          if (!url) return false;
          const lowerUrl = url.toLowerCase();
          
          if (FONT_EXTENSIONS.some(ext => lowerUrl.endsWith(ext))) {
            return false;
          }
          
          if (SUBTITLE_EXTENSIONS.some(ext => lowerUrl.includes(ext))) {
            return true;
          }
          
          if (lowerUrl.includes('.m3u8')) {
            return true;
          }
          
          try {
            const urlObj = new URL(url);
            if (urlObj.searchParams.has('subtitle') || 
                urlObj.searchParams.has('subs') || 
                urlObj.searchParams.has('captions')) {
              return true;
            }
          } catch (e) {}
          
          return false;
        }

        function sendSubtitles(subs, source) {
          if (!subs || subs.length === 0) return;

          const uniqueSubs = subs.filter(s => {
            if (!s.url) return false;
            if (!isValidSubtitleUrl(s.url)) {
              log('Rejecting non-subtitle URL:', s.url.substring(0, 80));
              return false;
            }
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

        // ========================================
        // Fetch subtitle content in page context (has cookies/JWT)
        // PlutoTV requires cookies/JWT tokens that content script can't access
        // ========================================
        async function fetchSubtitleContent(url, language, label, isHLSManifest) {
          try {
            if (!isValidSubtitleUrl(url)) {
              log('Skipping non-subtitle URL:', url.substring(0, 80));
              return null;
            }

            log('Fetching subtitle:', language, isHLSManifest ? '(HLS manifest)' : '', url.substring(0, 80) + '...');

            if (isHLSManifest) {
              return await fetchHLSManifestContent(url, language, label);
            }

            const response = await fetch(url, {
              credentials: 'include',
              headers: { 'Accept': 'text/vtt,application/vtt,text/plain' }
            });

            if (!response.ok) {
              log('Fetch failed:', response.status, response.statusText);
              return null;
            }

            const text = await response.text();
            if (!text || text.length < 10) {
              log('Empty or too short response');
              return null;
            }

            log('Fetched', text.length, 'bytes for', language);

            // Send content directly to content script
            window.postMessage({
              type: 'FFPROFANITY_SUBTITLE_CONTENT',
              source: 'plutotv-page-context',
              language: language,
              label: label,
              content: text
            }, '*');

            return text;
          } catch (error) {
            log('Fetch error:', error.message || error);
            return null;
          }
        }

        // ========================================
        // Fetch HLS manifest and extract VTT segments
        // PlutoTV uses nested HLS manifests: master.m3u8 -> subtitle.m3u8 -> .vtt segments
        // ========================================
        async function fetchHLSManifestContent(manifestUrl, language, label) {
          try {
            // Fetch the subtitle manifest
            const response = await fetch(manifestUrl, {
              credentials: 'include',
              headers: { 'Accept': 'application/vnd.apple.mpegurl,application/x-mpegurl,text/plain' }
            });

            if (!response.ok) {
              log('HLS manifest fetch failed:', response.status);
              return null;
            }

            const manifestText = await response.text();
            log('Got HLS manifest:', manifestText.length, 'bytes');

            // Parse the manifest to find VTT segment URLs
            const lines = manifestText.split('\n');
            const vttUrls = [];

            for (let i = 0; i < lines.length; i++) {
              const line = lines[i].trim();
              // Skip comments and empty lines, but note discontinuity markers
              if (line.startsWith('#') || line.length === 0) continue;

              // It's a segment URL (relative or absolute)
              // PlutoTV VTT segments are typically like: /webvtt/marker_00000.vtt
              if (line.includes('.vtt') || line.includes('/webvtt/') || line.includes('webvtt')) {
                const absoluteUrl = new URL(line, manifestUrl).href;
                vttUrls.push(absoluteUrl);
              } else {
                // Could be any segment - try to build VTT URL
                const absoluteUrl = new URL(line, manifestUrl).href;
                vttUrls.push(absoluteUrl);
              }
            }

            if (vttUrls.length === 0) {
              log('No VTT URLs found in manifest');
              return null;
            }

            log('Found', vttUrls.length, 'segments in HLS manifest');

            // Only fetch first few segments (Live TV subtitles are often repeated)
            // For Live TV, we get segments that update in real-time, so just get recent ones
            const maxSegments = Math.min(vttUrls.length, 3);
            const segmentsToFetch = vttUrls.slice(-maxSegments); // Get most recent

            let combinedContent = '';
            const seenCues = new Set(); // Deduplicate cues

            for (const vttUrl of segmentsToFetch) {
              try {
                const vttResponse = await fetch(vttUrl, {
                  credentials: 'include',
                  headers: { 'Accept': 'text/vtt,application/vtt,text/plain' }
                });

                if (!vttResponse.ok) continue;

                const vttText = await vttResponse.text();

                // Combine VTT content, avoiding duplicates
                // Extract just the cues (skip WEBVTT header)
                const cueLines = vttText.split('\n');
                let inCue = false;
                let currentCue = '';

                for (const line of cueLines) {
                  // Skip WEBVTT header and X-TIMESTAMP-MAP
                  if (line.startsWith('WEBVTT') || line.startsWith('X-TIMESTAMP-MAP')) {
                    continue;
                  }

                  // Detect cue timing lines (e.g., "00:00:01.000 --> 00:00:04.000")
                  if (line.includes('-->')) {
                    inCue = true;
                    currentCue = line + '\n';
                  } else if (inCue && line.trim().length > 0) {
                    currentCue += line + '\n';
                  } else if (inCue && line.trim().length === 0) {
                    // End of cue
                    if (!seenCues.has(currentCue)) {
                      seenCues.add(currentCue);
                      combinedContent += currentCue + '\n';
                    }
                    inCue = false;
                    currentCue = '';
                  }
                }
              } catch (e) {
                log('Failed to fetch segment:', vttUrl.substring(0, 50));
              }
            }

            if (combinedContent.length < 10) {
              log('No valid subtitle content extracted');
              return null;
            }

            // Prepend WEBVTT header
            const fullContent = 'WEBVTT\n\n' + combinedContent;
            log('Combined', combinedContent.length, 'bytes of VTT content');

            // Send content to content script
            window.postMessage({
              type: 'FFPROFANITY_SUBTITLE_CONTENT',
              source: 'plutotv-hls',
              language: language,
              label: label,
              content: fullContent
            }, '*');

            return fullContent;
          } catch (error) {
            log('HLS manifest processing error:', error.message || error);
            return null;
          }
        }

        // ========================================
        // Strategy 1: HLS Manifest Parsing
        // PlutoTV uses HLS with embedded subtitle tracks
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

              // Parse attributes: LANGUAGE, NAME, GROUP-ID, URI
              const langMatch = line.match(/LANGUAGE="([^"]+)"/i);
              const nameMatch = line.match(/NAME="([^"]+)"/i);
              const groupIdMatch = line.match(/GROUP-ID="([^"]+)"/i);
              const uriMatch = line.match(/URI="([^"]+)"/i);

              if (langMatch) currentSub.language = langMatch[1].toLowerCase();
              if (nameMatch) currentSub.label = nameMatch[1];
              if (groupIdMatch) currentSub.groupId = groupIdMatch[1];
              
              // URI may be in the attribute or on the next line
              if (uriMatch) {
                const subUrl = uriMatch[1];
                try {
                  const absoluteUrl = new URL(subUrl, baseUrl).href;
                  subs.push({
                    url: absoluteUrl,
                    language: currentSub.language || 'unknown',
                    label: currentSub.label || currentSub.language || 'Unknown'
                  });
                } catch (e) {
                  log('Failed to resolve subtitle URL:', subUrl);
                }
                currentSub = null;
              }
            }

            // Subtitle URI on non-tag line (follows EXT-X-MEDIA)
            if (currentSub && !line.startsWith('#') && line.length > 0) {
              try {
                const subUrl = new URL(line, baseUrl).href;
                subs.push({
                  url: subUrl,
                  language: currentSub.language || 'unknown',
                  label: currentSub.label || currentSub.language || 'Unknown'
                });
              } catch (e) {
                log('Failed to resolve subtitle URL:', line);
              }
              currentSub = null;
            }

            // Also check for EXT-X-STREAM-INF with SUBTITLES attribute
            if (line.startsWith('#EXT-X-STREAM-INF')) {
              const subsAttr = line.match(/SUBTITLES="([^"]+)"/i);
              if (subsAttr) {
                // Group-ID reference - subtitle tracks are defined elsewhere
                log('Found SUBTITLES group:', subsAttr[1]);
              }
            }
          }

          return subs;
        }

        // ========================================
        // Strategy 2: Video Element Track Detection
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
                // Try to find URL from cues if available
                if (textTrack.cues && textTrack.cues.length > 0) {
                  log('Found loaded textTrack:', textTrack.label, textTrack.language);
                }
              }
            }
          }

          return subs;
        }

        // ========================================
        // Strategy 3: XHR Interception
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
                    sendSubtitles(subs, 'plutotv.xhr-hls');

                    // Auto-fetch subtitle content for each track
                    // PlutoTV uses nested HLS manifests - the subtitle URL is itself an m3u8
                    for (const sub of subs) {
                      // Check if this looks like a subtitle manifest URL
                      if (sub.url.includes('subtitle') || sub.url.includes('subs') || sub.url.includes('.m3u8')) {
                        fetchSubtitleContent(sub.url, sub.language, sub.label, true);
                      } else {
                        // Direct VTT file
                        fetchSubtitleContent(sub.url, sub.language, sub.label, false);
                      }
                    }
                  }
                } catch (e) { /* Not valid HLS */ }
              }

              // Direct subtitle URLs (.vtt, .srt, .ass)
              if (/\\.(vtt|srt|ass|ssa)(\\?|$)/i.test(reqUrl) && !reqUrl.includes('blob:')) {
                log('Intercepted subtitle URL:', reqUrl);
                const lang = extractLanguageFromUrl(reqUrl);
                const label = getLanguageName(lang);
                sendSubtitles([{
                  url: reqUrl,
                  language: lang,
                  label: label
                }], 'plutotv.xhr-subtitle');
                // Auto-fetch the content
                fetchSubtitleContent(reqUrl, lang, label, false);
              }

              // JSON responses may contain subtitle data
              if (canReadResponseText && xhr.responseText) {
                try {
                  const data = JSON.parse(xhr.responseText);
                  const subs = findSubtitlesRecursive(data);
                  if (subs.length > 0) {
                    log('Found', subs.length, 'subs in JSON:', reqUrl.substring(0, 60));
                    sendSubtitles(subs, 'plutotv.xhr-json');
                  }
                } catch (e) { /* Not JSON */ }
              }
            });

            return originalXHRSend.apply(this, arguments);
          };
        }

        // ========================================
        // Strategy 4: Fetch Interception
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
                const label = getLanguageName(lang);
                sendSubtitles([{
                  url: url,
                  language: lang,
                  label: label
                }], 'plutotv.fetch-subtitle');
                fetchSubtitleContent(url, lang, label, false);
              }

              // HLS manifests
              if (url.includes('.m3u8') || url.includes('master') || url.includes('playlist')) {
                response.clone().text().then(content => {
                  const subs = parseHLSManifest(content, url);
                  if (subs.length > 0) {
                    sendSubtitles(subs, 'plutotv.fetch-hls');
                    for (const sub of subs) {
                      if (sub.url.includes('subtitle') || sub.url.includes('subs') || sub.url.includes('.m3u8')) {
                        fetchSubtitleContent(sub.url, sub.language, sub.label, true);
                      } else {
                        fetchSubtitleContent(sub.url, sub.language, sub.label, false);
                      }
                    }
                  }
                }).catch(() => {});
              }

              // JSON responses with subtitle data
              if (url.includes('subtitle') || url.includes('caption') || url.includes('texttrack') || url.includes('timedtext')) {
                response.clone().json().then(data => {
                  const subs = findSubtitlesRecursive(data);
                  if (subs.length > 0) {
                    sendSubtitles(subs, 'plutotv.fetch-json');
                  }
                }).catch(() => {});
              }

              // PlutoTV VOD API responses
              if (url.includes('/vod/') || url.includes('/live/') || url.includes('pluto.tv')) {
                response.clone().json().then(data => {
                  const subs = findSubtitlesRecursive(data);
                  if (subs.length > 0) {
                    sendSubtitles(subs, 'plutotv.fetch-api');
                  }
                }).catch(() => {});
              }
                  }
                }).catch(() => {});
              }

              return response;
            });
          };
        }

        // ========================================
        // Strategy 5: SPA Navigation Handling
        // PlutoTV is a SPA - detect navigation to re-scan for subtitles
        // ========================================
        let lastUrl = location.href;

        function watchForNavigation() {
          // Override pushState
          const originalPushState = history.pushState;
          if (originalPushState) {
            history.pushState = function(...args) {
              originalPushState.apply(this, args);
              handleNavigation();
            };
          }

          // Override replaceState
          const originalReplaceState = history.replaceState;
          if (originalReplaceState) {
            history.replaceState = function(...args) {
              originalReplaceState.apply(this, args);
              handleNavigation();
            };
          }

          // Listen for popstate
          window.addEventListener('popstate', handleNavigation);

          // Watch for URL changes via MutationObserver (fallback)
          const urlObserver = new MutationObserver(() => {
            if (location.href !== lastUrl) {
              handleNavigation();
            }
          });
          urlObserver.observe(document.body, { childList: true, subtree: true });
        }

        function handleNavigation() {
          if (location.href !== lastUrl) {
            lastUrl = location.href;
            log('Navigation detected:', location.href);
            // Clear sent subtitles on navigation
            sentSubtitles.clear();
            // Re-scan after navigation
            setTimeout(() => checkAndSendTracks('plutotv.nav-500'), 500);
            setTimeout(() => checkAndSendTracks('plutotv.nav-2000'), 2000);
          }
        }

        // ========================================
        // Helper: Extract language from URL
        // PlutoTV may use patterns like /en/subs.vtt or ?lang=en
        // NOTE: Duplicated from lib/language.ts for injected script context
        // ========================================
        function extractLanguageFromUrl(url) {
          const patterns = [
            /[?&]lang=([a-z]{2,3})/i,
            /[?&]language=([a-z]{2,3})/i,
            /\\/([a-z]{2,3})_[a-f0-9]+\\.vtt$/i,
            /\\/([a-z]{2,3})\\/[^/]+\\.vtt$/i,
            /[_\\-\\.]([a-z]{2,3})\\.(vtt|srt|ass|ssa)$/i,
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
          const urlKeys = ['file', 'url', 'src', 'downloadLink', 'path', 'link', 'uri'];
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
            const priorityKeys = ['subtitles', 'subs', 'captions', 'cc', 'text_tracks', 'tracks', 'timedtext', 'textTracks'];
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

          // Strategy 1: Video elements
          const videoSubs = extractFromVideoElements();
          allSubs.push(...videoSubs);

          if (allSubs.length > 0) {
            sendSubtitles(allSubs, source);
          }
        }

        // ========================================
        // CC button click detection
        // PlutoTV may have custom CC controls
        // ========================================
        function setupCCButtonDetection() {
          document.addEventListener('click', function(e) {
            const ccSelectors = [
              '[class*="cc"]', '[class*="caption"]', '[class*="subtitle"]',
              '[aria-label*="subtitle"]', '[aria-label*="caption"]', '[aria-label*="cc"]',
              '[class*="CC"]', '[data-testid*="cc"]', '[data-testid*="caption"]',
              '.pluto-cc', '.pluto-caption', '.pluto-subtitle'
            ];
            const target = e.target;
            for (const sel of ccSelectors) {
              if (target.matches && (target.matches(sel) || target.closest?.(sel))) {
                log('CC button clicked');
                setTimeout(() => checkAndSendTracks('plutotv.cc-click'), 200);
                setTimeout(() => checkAndSendTracks('plutotv.cc-click-delayed'), 1000);
                setTimeout(() => checkAndSendTracks('plutotv.cc-click-slow'), 3000);
                break;
              }
            }
          }, true);
        }

        // ========================================
        // Watch for video source changes (ads -> content)
        // PlutoTV plays ads before/during content
        // ========================================
        function watchForPlayerTransition() {
          log('Watching for player transitions');

          // Watch for video element source changes
          let lastSrc = '';
          const checkVideoSrc = () => {
            const video = document.querySelector('video');
            if (video && video.src && video.src !== lastSrc) {
              lastSrc = video.src;
              log('Video source changed:', video.src.substring(0, 60));
              // Re-check for subtitles when video source changes
              setTimeout(() => checkAndSendTracks('plutotv.video-src-change'), 500);
              setTimeout(() => checkAndSendTracks('plutotv.video-src-delayed'), 2000);
              setTimeout(() => checkAndSendTracks('plutotv.video-src-slow'), 5000);
            }
          };

          // Poll for video src changes
          setInterval(checkVideoSrc, 1000);

          // Also watch for video element events
          document.addEventListener('playing', function(e) {
            if (e.target instanceof HTMLVideoElement) {
              log('Video playing event');
              checkVideoSrc();
              setTimeout(() => checkAndSendTracks('plutotv.video-playing'), 500);
            }
          }, true);

          document.addEventListener('loadedmetadata', function(e) {
            if (e.target instanceof HTMLVideoElement) {
              log('Video loadedmetadata event');
              setTimeout(() => checkAndSendTracks('plutotv.video-metadata'), 200);
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
          watchForNavigation();
          setupCCButtonDetection();
          watchForPlayerTransition();

          // Initial checks with delays for dynamic content
          setTimeout(() => checkAndSendTracks('plutotv.init-500'), 500);
          setTimeout(() => checkAndSendTracks('plutotv.init-2000'), 2000);
          setTimeout(() => checkAndSendTracks('plutotv.init-5000'), 5000);
          // Extra delayed check for ad-supported content
          setTimeout(() => checkAndSendTracks('plutotv.init-10000'), 10000);
          setTimeout(() => checkAndSendTracks('plutotv.init-15000'), 15000);

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

export const plutotvExtractor = new PlutoTVExtractor();
