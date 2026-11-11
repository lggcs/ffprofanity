/**
 * CineLite Site Extractor
 * Handles subtitle detection for cinelite.xyz and its embed player
 *
 * ARCHITECTURE (verified live):
 * cinelite.xyz/watch/{id} embeds its in-house player from
 * embed.cinelite.xyz/{id} ("Cinema Embed"), a custom React-style player
 * with server buttons (Viper/ViperCast), an "Audio & Subs" menu, and a
 * Cloudflare Turnstile gate. The <video> element exists as a stub until
 * playback starts.
 *
 * SUBTITLE DETECTION STRATEGIES:
 * 1. XHR/fetch interception for .vtt/.srt/.ass URLs
 * 2. JSON API responses scanned recursively for subtitle file URLs
 * 3. Video element <track> elements and native textTracks cues
 * 4. Network-level .vtt URL detection via background webRequest listener
 */

import { BaseExtractor, DetectedSubtitle } from "./base";

export class CineLiteExtractor extends BaseExtractor {
  name = "cinelite";
  patterns = [
    /cinelite\.[a-z.]+/i,
  ];

  /**
   * Extract from network responses (called by background script)
   */
  extractFromResponse?(url: string, responseText: string): DetectedSubtitle[] {
    if (/\.mjs(\?|$)/i.test(url)) {
      return [];
    }

    const subs: DetectedSubtitle[] = [];

    // JSON responses may embed subtitle file URLs
    if (/\.m3u8(\?|$)/i.test(url) === false &&
        (responseText.trim().startsWith("{") || responseText.trim().startsWith("["))) {
      try {
        const data = JSON.parse(responseText);
        subs.push(
          ...this.findSubtitlesRecursive(data, 'cinelite.json').filter(
            (s) => s.url && !/\.mjs(\?|$)/i.test(s.url),
          ),
        );
      } catch {
        // Not JSON
      }
    }

    return subs;
  }

  /**
   * Get the injected script for CineLite subtitle detection
   * Runs in every matching frame (top page and embed.cinelite.xyz)
   */
  getInjectedScript(): string {
    return `
      // CineLite Subtitle Extractor
      // Detects subtitles from the Cinema Embed player (embed.cinelite.xyz)
      (function() {
        'use strict';

        const EXTRACTOR_ID = 'cinelite';
        const sentSubtitles = new Set();

        function log(...args) {
          console.log('[FFProfanity][' + EXTRACTOR_ID + ']', ...args);
        }

        function isSubtitleFileUrl(url) {
          return /\\.(vtt|srt|ass|ssa)(\\?|$)/i.test(url) && !/\\.mjs(\\?|$)/i.test(url);
        }

        function isValidUrl(url) {
          if (!url || typeof url !== 'string') return false;
          if (url.startsWith('blob:') || url.startsWith('about:') ||
              url.startsWith('data:') || url.startsWith('javascript:')) return false;
          return true;
        }

        function sendSubtitles(subs, source) {
          if (!subs || subs.length === 0) return;

          const uniqueSubs = subs.filter(function(s) {
            if (!s.url || !isValidUrl(s.url) || !isSubtitleFileUrl(s.url)) return false;
            if (sentSubtitles.has(s.url)) return false;
            sentSubtitles.add(s.url);
            return true;
          });

          if (uniqueSubs.length === 0) return;

          log('Sending', uniqueSubs.length, 'subtitles from', source);

          window.postMessage({
            type: 'FFPROFANITY_SUBTITLES_DETECTED',
            source: source,
            subtitles: uniqueSubs.map(function(s) {
              return {
                url: s.url,
                language: s.language || 'unknown',
                label: s.label || 'Unknown'
              };
            })
          }, '*');
        }

        // Strategy 1: Video element track detection
        function extractFromVideoElements() {
          const subs = [];
          const videos = document.querySelectorAll('video');

          for (const video of videos) {
            const trackElements = video.querySelectorAll('track[kind="subtitles"], track[kind="captions"]');
            for (const track of trackElements) {
              const url = track.src;
              if (url && isSubtitleFileUrl(url)) {
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

        // Strategy 2: JSON data scan for subtitle file URLs
        function findSubtitlesRecursive(obj) {
          const subs = [];
          if (!obj || typeof obj !== 'object') return subs;

          const urlKeys = ['file', 'url', 'src', 'link', 'path', 'downloadUrl'];
          for (const key of urlKeys) {
            if (typeof obj[key] === 'string' && isSubtitleFileUrl(obj[key])) {
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
            const priorityKeys = ['subtitles', 'subs', 'captions', 'tracks', 'text_tracks', 'cc'];
            for (const key of priorityKeys) {
              if (obj[key]) {
                subs.push(...findSubtitlesRecursive(obj[key]));
              }
            }
          }

          return subs;
        }

        // Strategy 3: XHR/Fetch Interception
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

            if (isSubtitleFileUrl(url)) {
              log('XHR subtitle URL:', url);
              const lang = extractLanguageFromUrl(url);
              sendSubtitles([{
                url: url,
                language: lang,
                label: getLanguageName(lang)
              }], EXTRACTOR_ID + '.xhr-subtitle');
            }

            xhr.addEventListener('load', function() {
              if (xhr.responseType !== '' && xhr.responseType !== 'text') return;
              try {
                const responseText = xhr.responseText || '';
                if (responseText.trim().startsWith('{') || responseText.trim().startsWith('[')) {
                  const data = JSON.parse(responseText);
                  const found = findSubtitlesRecursive(data);
                  if (found.length > 0) {
                    log('Found subtitles in XHR JSON:', url.substring(0, 100));
                    sendSubtitles(found, EXTRACTOR_ID + '.xhr-json');
                  }
                }
              } catch (e) { /* Not JSON */ }
            });

            return originalXHRSend.apply(this, arguments);
          };

          const originalFetch = window.fetch;

          window.fetch = function(input, init) {
            let url = '';
            if (typeof input === 'string') {
              url = input;
            } else if (input && typeof input.url === 'string') {
              url = input.url;
            }

            if (isSubtitleFileUrl(url)) {
              log('Fetch subtitle URL:', url);
              const lang = extractLanguageFromUrl(url);
              sendSubtitles([{
                url: url,
                language: lang,
                label: getLanguageName(lang)
              }], EXTRACTOR_ID + '.fetch-subtitle');
            }

            return originalFetch.apply(this, arguments).then(function(response) {
              if (url && !isSubtitleFileUrl(url)) {
                const clone = response.clone();
                clone.text().then(function(text) {
                  try {
                    const data = JSON.parse(text);
                    const found = findSubtitlesRecursive(data);
                    if (found.length > 0) {
                      log('Found subtitles in fetch JSON:', url.substring(0, 100));
                      sendSubtitles(found, EXTRACTOR_ID + '.fetch-json');
                    }
                  } catch (e) { /* Not JSON */ }
                }).catch(function() {});
              }
              return response;
            });
          };
        }

        // Helpers
        function extractLanguageFromUrl(url) {
          const patterns = [
            /[?&]lang=([a-z]{2,3})/i,
            /\\/([a-z]{2,3})_[a-f0-9]+\\.vtt$/i,
            /\\/([a-z]{2,3})\\/[^/]+\\.vtt$/i,
            /[_\\-\\.]([a-z]{2,3})\\.(vtt|srt|ass)$/i,
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

        // Initialize
        function init() {
          log(EXTRACTOR_ID + ' extractor initializing on:', window.location.hostname);

          interceptNetworkRequests();

          const scan = function(source) {
            const subs = extractFromVideoElements();
            if (subs.length > 0) {
              sendSubtitles(subs, EXTRACTOR_ID + '.' + source);
            }
          };
          scan('init');

          // Watch for video/track additions - the player stub video is
          // replaced with the real playback element when playback starts
          const observer = new MutationObserver(function(mutations) {
            let foundNew = false;
            for (const mutation of mutations) {
              for (const node of mutation.addedNodes) {
                if (node instanceof HTMLVideoElement || node instanceof HTMLTrackElement) {
                  foundNew = true;
                } else if (node instanceof HTMLElement && node.querySelector('video')) {
                  foundNew = true;
                }
              }
            }
            if (foundNew) {
              scan('dom-added');
            }
          });
          observer.observe(document.documentElement, { childList: true, subtree: true });

          // Periodically re-scan: the player boots and loads subtitle
          // tracks only after a source is selected and playback starts
          let checks = 0;
          const checkInterval = setInterval(function() {
            checks++;
            scan('poll');
            if (checks >= 25) {
              clearInterval(checkInterval);
            }
          }, 600);
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
export const cineliteExtractor = new CineLiteExtractor();
