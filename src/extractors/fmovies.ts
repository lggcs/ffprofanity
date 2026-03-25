/**
 * fmovies.gd Site Extractor
 * Handles subtitle detection for fmovies streaming sites
 *
 * ARCHITECTURE:
 * fmovies uses dynamic subtitle loading from sub.wyzie.io API.
 * Subtitles are fetched on-demand when user selects a language.
 * The sources API (api.videasy.net) returns encrypted data with subtitle IDs.
 *
 * ANTI-DEBUGGING NOTE:
 * fmovies has anti-debugging protection that triggers debugger statements
 * when DevTools are open. This extractor uses passive detection strategies
 * to avoid triggering those protections.
 *
 * SUBTITLE DETECTION STRATEGIES:
 * 1. Intercept fetch/XHR to sub.wyzie.io for subtitle URLs
 * 2. Capture HLS manifest parsing for embedded subtitles
 * 3. Monitor video textTracks for dynamically loaded subtitles
 * 4. Intercept sources API to capture subtitle list data
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
      // fmovies Subtitle Extractor - Network interception based
      (function() {
        'use strict';

        const EXTRACTOR_ID = 'fmovies';
        const sentSubtitles = new Set();
        const sentContent = new Set();

        // Send detected subtitles to content script
        function sendSubtitles(subs, source) {
          if (!subs || subs.length === 0) return;

          try {
            const uniqueSubs = subs.filter(s => {
              const key = s.url || s.content;
              if (!key) return false;
              if (sentSubtitles.has(key)) return false;
              sentSubtitles.add(key);
              return true;
            });

            if (uniqueSubs.length === 0) return;

            window.postMessage({
              type: 'FFPROFANITY_SUBTITLES_DETECTED',
              source: EXTRACTOR_ID + '.' + source,
              subtitles: uniqueSubs
            }, '*');
          } catch (e) {}
        }

        // Send subtitle content directly (for when we capture the actual text)
        // Source name determines timing behavior - use consistent source name
        function sendSubtitleContent(content, language, label) {
          // Use content hash as dedup key instead of first 100 chars
          // This prevents duplicates from slightly different content starts
          const contentHash = content.length + '_' + content.indexOf('-->');
          if (sentContent.has(contentHash)) return;
          sentContent.add(contentHash);

          window.postMessage({
            type: 'FFPROFANITY_SUBTITLE_CONTENT',
            source: EXTRACTOR_ID,  // Always use 'fmovies' as source for proper timing
            content: content,
            language: language,
            label: label
          }, '*');
        }

        // Extract language from URL or response
        function extractLanguageFromUrl(url) {
          const patterns = [
            /[?&]lang=([a-z]{2,3})/i,
            /[?&]language=([a-z]{2,3})/i,
            /[_\\-\\.]([a-z]{2,3})\\.(vtt|srt|ass|ssa)/i,
            /\\/([a-z]{2,3})_[a-f0-9]+\\.vtt/i,
          ];
          for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match) return match[1].toLowerCase();
          }
          return null;
        }

        // Strategy 1: Stealthy fetch interception using Proxy (evades toString detection)
        function interceptFetch() {
          const originalFetch = window.fetch;

          const handler = {
            apply: async function(target, thisArg, args) {
              const urlStr = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';

              try {
                const response = await Reflect.apply(originalFetch, thisArg, args);

                // Only intercept actual subtitle file URLs, not search API
                // Subtitle URLs have format like: /c/{hash}/id/{id}?format=srt
                // Search URLs have: /search?id=...&key=...
                const isSubtitleUrl = urlStr.includes('sub.wyzie.io/c/') && 
                                      (urlStr.includes('format=srt') || urlStr.includes('format=vtt'));
                
                if (isSubtitleUrl) {
                  try {
                    const clone = response.clone();
                    const text = await clone.text();

                    // Only send if it's actual subtitle content (has timestamps)
                    if (text.includes('-->')) {
                      let language = extractLanguageFromUrl(urlStr) || 'en';
                      sendSubtitleContent(text, language, 'Wyzie');
                    }
                  } catch (e) {}
                }

                return response;
              } catch (e) {
                throw e;
              }
            }
          };

          const proxiedFetch = new Proxy(originalFetch, handler);

          try {
            Object.defineProperty(window, 'fetch', {
              value: proxiedFetch,
              writable: true,
              configurable: true,
              enumerable: true
            });
          } catch (e) {
            window.fetch = proxiedFetch;
          }
        }

        // Strategy 2: Stealthy XHR interception
        function interceptXHR() {
          const nativeOpen = XMLHttpRequest.prototype.open;
          const nativeSend = XMLHttpRequest.prototype.send;

          Object.defineProperty(XMLHttpRequest.prototype, 'open', {
            value: function(method, url) {
              this._f = url;
              return nativeOpen.apply(this, arguments);
            },
            writable: true,
            configurable: true
          });

          Object.defineProperty(XMLHttpRequest.prototype, 'send', {
            value: function() {
              const url = this._f || '';
              const xhr = this;

              // Add load listener for subtitle URLs
              if (url.includes('sub.wyzie.io') || url.includes('.vtt') || url.includes('.srt')) {
                xhr.addEventListener('load', function() {
                  try {
                    const responseText = xhr.responseText;
                    if (responseText && responseText.includes('-->')) {
                      const language = extractLanguageFromUrl(url) || 'en';
                      sendSubtitleContent(responseText, language, 'XHR');
                    }
                  } catch (e) {}
                });
              }

              return nativeSend.apply(this, arguments);
            },
            writable: true,
            configurable: true
          });
        }

        // Strategy 3: Monitor video textTracks for dynamically loaded subtitles
        // This is the PRIMARY method - subtitles from textTracks are already synced with video
        function monitorVideoTextTracks() {
          let lastCueCount = 0;
          let lastSource = null;
          
          const checkTextTracks = () => {
            try {
              const videos = document.querySelectorAll('video');
              for (const video of videos) {
                if (video.textTracks && video.textTracks.length > 0) {
                  for (let i = 0; i < video.textTracks.length; i++) {
                    const track = video.textTracks[i];
                    if ((track.kind === 'subtitles' || track.kind === 'captions') && track.cues && track.cues.length > 0) {
                      const cues = Array.from(track.cues);
                      const trackKey = track.label || track.language || String(i);
                      
                      // Only send if this is a new track or has significantly more cues
                      // This prevents duplicate sends while allowing updates
                      if (cues.length > 0 && !sentContent.has(trackKey) && cues.length !== lastCueCount) {
                        sentContent.add(trackKey);
                        lastCueCount = cues.length;
                        lastSource = 'textTracks';
                        
                        // Reconstruct VTT from cues - these are already synced with video
                        let vttContent = 'WEBVTT\\n\\n';
                        cues.forEach((cue, idx) => {
                          const start = formatVTTTime(cue.startTime);
                          const end = formatVTTTime(cue.endTime);
                          vttContent += (idx + 1) + '\\n';
                          vttContent += start + ' --> ' + end + '\\n';
                          vttContent += cue.text + '\\n\\n';
                        });

                        sendSubtitleContent(vttContent, track.language || 'en', track.label || 'Video Track');
                        return; // Stop after sending - prefer textTrack source
                      }
                    }
                  }
                }
              }
            } catch (e) {}
          };
          
          function formatVTTTime(seconds) {
            const hrs = Math.floor(seconds / 3600);
            const mins = Math.floor((seconds % 3600) / 60);
            const secs = Math.floor(seconds % 60);
            const ms = Math.floor((seconds % 1) * 1000);
            return String(hrs).padStart(2, '0') + ':' +
                   String(mins).padStart(2, '0') + ':' +
                   String(secs).padStart(2, '0') + '.' +
                   String(ms).padStart(3, '0');
          }

          // Check more frequently at first, then taper off
          let interval = 1000;
          const check = () => {
            checkTextTracks();
            if (interval < 5000) {
              interval = Math.min(interval * 1.5, 5000);
            }
            setTimeout(check, interval);
          };
          setTimeout(check, 500);
        }

        // Strategy 4: Capture subtitle content from blob URLs
        function monitorBlobSubtitles() {
          const nativeCreateObjectURL = URL.createObjectURL;
          
          Object.defineProperty(URL, 'createObjectURL', {
            value: function(blob) {
              const url = nativeCreateObjectURL.apply(this, arguments);

              // Check if this blob is a subtitle
              if (blob && blob.type && (blob.type.includes('text/vtt') || blob.type.includes('text/srt') || blob.type.includes('text/plain'))) {
                try {
                  const reader = new FileReader();
                  reader.onload = function() {
                    const content = reader.result;
                    if (content && content.includes('-->')) {
                      sendSubtitleContent(content, 'en', 'Blob');
                    }
                  };
                  reader.readAsText(blob);
                } catch (e) {}
              }

              return url;
            },
            writable: true,
            configurable: true
          });
        }

        // Initialize - runs immediately
        function init() {
          interceptFetch();
          interceptXHR();
          monitorVideoTextTracks();
          monitorBlobSubtitles();
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
export const fmoviesExtractor = new FMoviesExtractor();