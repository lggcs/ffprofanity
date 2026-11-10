/**
 * BingeWatch Site Extractor
 * Handles subtitle detection for bingewatch.one and its player frames
 *
 * ARCHITECTURE (verified live):
 * bingewatch.one is a streaming site whose player lives in a third-party
 * iframe chain: bingewatch.one → 0123movie.space → mfw*.org
 *
 * - mfw*.org runs JW Player behind a captcha gate (.captcha-gate__play).
 *   Clicking the gate boots JW with the stream as a blob video.
 * - The subtitle token is passed to the player frame as a URL parameter:
 *     ?sub.info=https%3A%2F%2Fqqqcdn.cloud%2Fsubtitles%2Ffs%2Ftoken%2F{id}.json
 *   (a FastStream-style token endpoint whose payload is a JSON array of
 *   subtitle file entries; empty array when no subtitles are published)
 * - The mfw09 player itself cannot resolve the token: it sends a credentialed
 *   request and the CDN answers `Access-Control-Allow-Origin: *`, which the
 *   browser rejects whenever credentials are present. Uncredentialed fetches
 *   work, so this extractor resolves the token itself.
 * - Native captions render in .jw-captions; the content script hides them
 *   via the 'bingewatch' hideSelectors entry.
 *
 * SUBTITLE DETECTION STRATEGIES:
 * 1. sub.* URL parameters: direct subtitle files, and .json tokens resolved
 *    recursively for subtitle file URLs (fetched without credentials)
 * 2. XHR/fetch interception for .vtt/.srt/.ass URLs (JW captions load)
 * 3. JW Player config inspection (window.jwplayer playlist tracks/captions)
 * 4. Video element <track> elements (fallback)
 *
 * Sprite/timeslider thumbnail VTT tracks (JW hover previews) are filtered out.
 */

import { BaseExtractor, DetectedSubtitle } from "./base";

export class BingeWatchExtractor extends BaseExtractor {
  name = "bingewatch";
  patterns = [
    /bingewatch\.[a-z.]+/i,
    /mfw\d+\.[a-z]+/i,
    /0123movie\.[a-z]+/i,
  ];

  /**
   * Extract from network responses (called by background script)
   * Filters out false positives like SubtitlesManager.mjs
   */
  extractFromResponse?(url: string, responseText: string): DetectedSubtitle[] {
    if (/\.mjs(\?|$)/i.test(url)) {
      return [];
    }
    return [];
  }

  /**
   * Get the injected script for BingeWatch subtitle detection
   * This runs in both the top page frame (bingewatch.one) and the player
   * frames (mfw*.org) — each frame contributes what it can see.
   */
  getInjectedScript(): string {
    return `
      // BingeWatch Subtitle Extractor
      // Detects subtitles passed via sub.* URL params and JW Player tracks
      (function() {
        'use strict';

        const EXTRACTOR_ID = 'bingewatch';
        const SUB_FILE_RE = /\\.(vtt|srt|ass|ssa)(\\?|$)/i;
        // JW sprite-thumbnail tracks: not dialogue subtitles
        const JUNK_URL_RE = /timeslider|thumbs?|sprite|preview|storyboard|\\.(jpe?g|png|webp)(\\?|$)/i;

        // URL parameter names that may carry a subtitle URL or token
        const SUB_PARAM_NAMES = ['sub.info', 'sub_url', 'suburl', 'subtitle_url'];

        // Tokens currently being resolved (retry until subtitle files are
        // found, because the video element often appears only after the
        // captcha gate is clicked, well after the first resolution)
        const pendingTokens = new Set();

        function log(...args) {
          console.log('[FFProfanity][' + EXTRACTOR_ID + ']', ...args);
        }

        function isValidUrl(url) {
          if (!url || typeof url !== 'string') return false;
          if (url.startsWith('blob:') || url.startsWith('about:') ||
              url.startsWith('data:') || url.startsWith('javascript:')) return false;
          if (/\\.mjs(\\?|$)/i.test(url)) return false;
          return true;
        }

        function isReasonableSubtitleUrl(url) {
          if (!isValidUrl(url)) return false;
          if (JUNK_URL_RE.test(url)) return false;
          if (!SUB_FILE_RE.test(url) && !/subtitles?|captions?/i.test(url)) return false;
          return true;
        }

        function labelFromUrl(url) {
          try {
            const u = new URL(url, location.href);
            const segs = u.pathname.split('/').filter(Boolean);
            const last = segs[segs.length - 1];
            if (last) return last.replace(/\\.(vtt|srt|ass|ssa)$/i, '');
          } catch (e) { /* relative or malformed */ }
          return 'Embedded';
        }

        function sendSubtitles(subs, source) {
          if (!subs || subs.length === 0) return;

          const uniqueSubs = [];
          const seen = new Set();
          for (const s of subs) {
            if (!s.url || !isReasonableSubtitleUrl(s.url)) continue;
            if (seen.has(s.url)) continue;
            seen.add(s.url);
            uniqueSubs.push(s);
          }

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

        // Resolve a FastStream-style token endpoint into subtitle file URLs.
        // Retries on later scans while unresolved: the payload can be empty
        // until the site publishes subtitles, and the player video (needed
        // for the content script to adopt a track) may not exist yet either.
        function resolveTokenSubtitle(tokenUrl, source) {
          if (pendingTokens.has(tokenUrl)) return;
          pendingTokens.add(tokenUrl);

          fetch(tokenUrl, { credentials: 'omit' })
            .then(function(r) { return r.text(); })
            .then(function(text) {
              let data;
              try {
                data = JSON.parse(text);
              } catch (e) {
                log('Token is not JSON, dropping:', tokenUrl.slice(0, 90));
                pendingTokens.delete(tokenUrl);
                return;
              }

              const found = [];
              (function walk(node) {
                if (!node || typeof node !== 'object') return;
                if (Array.isArray(node)) {
                  for (const item of node) walk(item);
                  return;
                }
                for (const key of ['file', 'url', 'src', 'link', 'path']) {
                  if (typeof node[key] === 'string' && SUB_FILE_RE.test(node[key]) &&
                      !JUNK_URL_RE.test(node[key])) {
                    const labelVal = typeof node.label === 'string' && node.label ||
                                     typeof node.name === 'string' && node.name ||
                                     typeof node.title === 'string' && node.title;
                    found.push({
                      url: node[key],
                      language: (typeof node.lang === 'string' && node.lang) ||
                                (typeof node.language === 'string' && node.language) ||
                                extractLanguageFromUrl(node[key]),
                      label: labelVal || labelFromUrl(node[key])
                    });
                  }
                }
                for (const key in node) {
                  if (node[key] && typeof node[key] === 'object') walk(node[key]);
                }
              })(data);

              if (found.length > 0) {
                pendingTokens.delete(tokenUrl);
                log('Resolved', found.length, 'subtitle files from token');
                sendSubtitles(found, EXTRACTOR_ID + '.token-' + source);
              } else {
                log('Token has no subtitle files yet, will retry:', tokenUrl.slice(0, 90));
                pendingTokens.delete(tokenUrl);
              }
            })
            .catch(function(e) {
              log('Token fetch failed:', (e && e.message) || e);
              pendingTokens.delete(tokenUrl);
            });
        }

        // Strategy 1: sub.* URL parameters on our own URL and every iframe src
        function extractFromUrlParams() {
          const subs = [];
          const urlsToCheck = [window.location.href];

          for (const iframe of document.querySelectorAll('iframe')) {
            const src = iframe.getAttribute('src');
            if (src) urlsToCheck.push(src);
          }

          for (const raw of urlsToCheck) {
            let urlObj;
            try {
              urlObj = new URL(raw, location.href);
            } catch (e) { continue; }

            for (const paramName of SUB_PARAM_NAMES) {
              const val = urlObj.searchParams.get(paramName);
              if (!val || !isValidUrl(val)) continue;

              if (/\\.json(\\?|$)/i.test(val)) {
                resolveTokenSubtitle(val, 'url-param');
                continue;
              }

              if (!isReasonableSubtitleUrl(val)) continue;

              const lang = urlObj.searchParams.get('sub.lang') ||
                           urlObj.searchParams.get('sub_lang');
              subs.push({
                url: val,
                language: lang || extractLanguageFromUrl(val),
                label: (lang ? getLanguageName(lang) : null) || labelFromUrl(val)
              });
              log('Found subtitle in URL param', paramName, ':', val.substring(0, 100));
            }
          }

          return subs;
        }

        // Strategy 2: JW Player config inspection
        function extractFromJwPlayer() {
          const subs = [];

          try {
            if (window.jwplayer && typeof window.jwplayer === 'function') {
              let players = [];
              try {
                players = window.jwplayer() ? [window.jwplayer()] : [];
              } catch (e) { players = []; }

              for (const player of players) {
                if (!player || typeof player.getConfig !== 'function') continue;
                const config = player.getConfig();
                if (!config) continue;

                const trackLists = [];
                if (Array.isArray(config.tracks)) trackLists.push(...config.tracks);
                for (const item of (config.playlist || [])) {
                  if (Array.isArray(item.tracks)) trackLists.push(...item.tracks);
                  if (Array.isArray(item.captions)) trackLists.push(...item.captions);
                }
                for (const track of trackLists) {
                  const url = track.file || track.url || track.src;
                  if (url && isReasonableSubtitleUrl(url)) {
                    subs.push({
                      url: url,
                      language: track.language || track.lang || 'unknown',
                      label: track.label || 'Unknown'
                    });
                    log('Found JW Player track:', url.substring(0, 100));
                  }
                }
              }
            }
          } catch (e) {
            log('JW Player extraction error:', e.message || e);
          }

          return subs;
        }

        // Strategy 3: Video Element Track Detection
        function extractFromVideoElements() {
          const subs = [];
          const videos = document.querySelectorAll('video');

          for (const video of videos) {
            const trackElements = video.querySelectorAll('track[kind="subtitles"], track[kind="captions"]');
            for (const track of trackElements) {
              const url = track.src;
              if (url && isReasonableSubtitleUrl(url)) {
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

            if (SUB_FILE_RE.test(url) && !JUNK_URL_RE.test(url) && !/\\.mjs(\\?|$)/i.test(url)) {
              log('XHR subtitle URL:', url);
              const lang = extractLanguageFromUrl(url);
              sendSubtitles([{
                url: url,
                language: lang,
                label: getLanguageName(lang)
              }], EXTRACTOR_ID + '.xhr-subtitle');
            }

            return originalXHRSend.apply(this, arguments);
          };

          const originalFetch = window.fetch;

          window.fetch = function(input, init) {
            const url = typeof input === 'string' ? input : (input.url || '');

            if (SUB_FILE_RE.test(url) && !JUNK_URL_RE.test(url) && !/\\.mjs(\\?|$)/i.test(url)) {
              log('Fetch subtitle URL:', url);
              const lang = extractLanguageFromUrl(url);
              sendSubtitles([{
                url: url,
                language: lang,
                label: getLanguageName(lang)
              }], EXTRACTOR_ID + '.fetch-subtitle');
            }

            return originalFetch.apply(this, arguments);
          };
        }

        // Helpers
        function extractLanguageFromUrl(url) {
          const patterns = [
            /[?&]lang=([a-z]{2,3})/i,
            /[?&]sub_lang=([a-z]{2,3})/i,
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
            const subs = [
              ...extractFromUrlParams(),
              ...extractFromJwPlayer(),
              ...extractFromVideoElements(),
            ];
            if (subs.length > 0) {
              sendSubtitles(subs, EXTRACTOR_ID + '.' + source);
            }
          };
          scan('init');

          // Watch for player frame / video additions (server switches load
          // a fresh iframe chain and a fresh sub.info parameter)
          const observer = new MutationObserver(function(mutations) {
            let foundNew = false;
            for (const mutation of mutations) {
              for (const node of mutation.addedNodes) {
                if (node instanceof HTMLIFrameElement || node instanceof HTMLVideoElement) {
                  foundNew = true;
                } else if (node instanceof HTMLElement &&
                           (node.querySelector('iframe') || node.querySelector('video'))) {
                  foundNew = true;
                }
              }
            }
            if (foundNew) {
              scan('dom-added');
            }
          });
          observer.observe(document.documentElement, { childList: true, subtree: true });

          // Periodically re-scan: JW Player config only becomes readable
          // after the captcha gate is clicked and the player boots, and a
          // track sent before the video element exists must be re-sent
          let checks = 0;
          const checkInterval = setInterval(function() {
            checks++;
            scan('poll');
            if (checks >= 40) {
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
export const bingewatchExtractor = new BingeWatchExtractor();
