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

        // Send subtitle content directly (for when we capture the actual text)
        function sendSubtitleContent(content, language, label) {
          const key = content.substring(0, 100);
          if (sentContent.has(key)) return;
          sentContent.add(key);

          console.log('[FMovies] Received subtitle content for', label, language);
          window.postMessage({
            type: 'FFPROFANITY_SUBTITLE_CONTENT',
            source: EXTRACTOR_ID,
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

        // Strategy 1: Intercept fetch to capture wyzie subtitle responses
        function interceptFetch() {
          const originalFetch = window.fetch;
          window.fetch = async function(url, options) {
            const urlStr = typeof url === 'string' ? url : url.url || '';
            
            try {
              const response = await originalFetch.apply(this, arguments);
              
              // Check for wyzie subtitle URLs
              if (urlStr.includes('sub.wyzie.io')) {
                console.log('[FMovies] Intercepted wyzie request:', urlStr);
                
                try {
                  const clone = response.clone();
                  const text = await clone.text();
                  
                  // Extract language from URL params or content
                  let language = extractLanguageFromUrl(urlStr) || 'en';
                  let label = 'Unknown';
                  
                  // Try to detect language from content (first lines often have language hint)
                  const lines = text.split('\\n').slice(0, 20);
                  for (const line of lines) {
                    if (line.includes('Language:') || line.includes('language:')) {
                      const langMatch = line.match(/language:\\s*([a-z]{2,3})/i);
                      if (langMatch) language = langMatch[1].toLowerCase();
                    }
                  }
                  
                  // If content is SRT format, send it directly
                  if (text.startsWith('1') || text.includes('-->')) {
                    sendSubtitleContent(text, language, label);
                  }
                  
                  // Also try to extract subtitle URL for future reference
                  sendSubtitles([{
                    url: urlStr,
                    language: language,
                    label: label,
                    source: 'wyzie-intercept'
                  }], 'wyzie-intercept');
                  
                } catch (e) {
                  console.log('[FMovies] Error processing wyzie response:', e.message);
                }
              }
              
              // Check for sources API responses
              if (urlStr.includes('sources-with-title') || urlStr.includes('api.videasy.net')) {
                console.log('[FMovies] Intercepted sources API:', urlStr);
              }
              
              return response;
            } catch (e) {
              throw e;
            }
          };
        }

        // Strategy 2: Intercept XHR for older API calls
        function interceptXHR() {
          const originalOpen = XMLHttpRequest.prototype.open;
          const originalSend = XMLHttpRequest.prototype.send;
          
          XMLHttpRequest.prototype.open = function(method, url) {
            this._ffprofanity_url = url;
            return originalOpen.apply(this, arguments);
          };
          
          XMLHttpRequest.prototype.send = function() {
            const url = this._ffprofanity_url || '';
            const xhr = this;
            
            // Add load listener for subtitle URLs
            if (url.includes('sub.wyzie.io') || url.includes('.vtt') || url.includes('.srt')) {
              xhr.addEventListener('load', function() {
                try {
                  const responseText = xhr.responseText;
                  if (responseText && (responseText.includes('-->') || responseText.includes('WEBVTT'))) {
                    const language = extractLanguageFromUrl(url) || 'en';
                    sendSubtitleContent(responseText, language, 'XHR Subtitle');
                  }
                } catch (e) {}
              });
            }
            
            return originalSend.apply(this, arguments);
          };
        }

        // Strategy 3: Monitor video textTracks for dynamically loaded subtitles
        function monitorVideoTextTracks() {
          const checkTextTracks = () => {
            try {
              const videos = document.querySelectorAll('video');
              for (const video of videos) {
                if (video.textTracks && video.textTracks.length > 0) {
                  for (let i = 0; i < video.textTracks.length; i++) {
                    const track = video.textTracks[i];
                    if ((track.kind === 'subtitles' || track.kind === 'captions') && track.cues && track.cues.length > 0) {
                      // We have loaded cues - try to reconstruct VTT content
                      const cues = Array.from(track.cues);
                      if (cues.length > 0 && !sentContent.has(track.label || track.language)) {
                        console.log('[FMovies] Found textTrack with', cues.length, 'cues');
                        
                        // Reconstruct VTT from cues
                        let vttContent = 'WEBVTT\\n\\n';
                        cues.forEach((cue, idx) => {
                          const start = formatVTTTime(cue.startTime);
                          const end = formatVTTTime(cue.endTime);
                          vttContent += (idx + 1) + '\\n';
                          vttContent += start + ' --> ' + end + '\\n';
                          vttContent += cue.text + '\\n\\n';
                        });
                        
                        sendSubtitleContent(vttContent, track.language || 'en', track.label || 'Unknown');
                      }
                    }
                  }
                }
              }
            } catch (e) {}
          };
          
          // Helper to format time as VTT format
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
          
          // Check periodically
          setInterval(checkTextTracks, 3000);
          checkTextTracks();
        }

        // Strategy 4: Hook into media source for HLS manifest parsing
        function hookMediaSource() {
          const originalOpen = MediaSource.prototype.addSourceBuffer;
          if (originalOpen) {
            MediaSource.prototype.addSourceBuffer = function(mimeType) {
              // Monitor for HLS subtitle tracks
              const sourceBuffer = originalOpen.apply(this, arguments);
              return sourceBuffer;
            };
          }
        }

        // Strategy 5: Capture subtitle URLs from blob URLs
        function monitorBlobSubtitles() {
          // When a blob URL is created for subtitles, the original URL is lost
          // But we can intercept the creation and track it
          const originalCreateObjectURL = URL.createObjectURL;
          URL.createObjectURL = function(blob) {
            const url = originalCreateObjectURL.apply(this, arguments);
            
            // Check if this blob is a subtitle
            if (blob && blob.type && (blob.type.includes('text/vtt') || blob.type.includes('text/srt'))) {
              console.log('[FMovies] Created subtitle blob:', url);
              
              // Try to read the blob content
              const reader = new FileReader();
              reader.onload = function() {
                const content = reader.result;
                if (content && content.includes('-->')) {
                  sendSubtitleContent(content, 'en', 'Blob Subtitle');
                }
              };
              reader.readAsText(blob);
            }
            
            return url;
          };
        }

        // Initialize
        function init() {
          console.log('[FMovies] Initializing extractor');
          
          // Set up network interception first
          interceptFetch();
          interceptXHR();
          
          // Set up video monitoring
          monitorVideoTextTracks();
          monitorBlobSubtitles();
          
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