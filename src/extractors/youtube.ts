/**
 * YouTube Site Extractor
 * Handles subtitle detection for youtube.com and youtu.be
 *
 * Key implementation notes:
 * - YouTube provides signed URLs with expire/signature params - use them directly
 * - Default format is JSON3; add &fmt=vtt to get WebVTT format
 * - ytInitialPlayerResponse is available on page load (inline JS)
 * - Subtitle URLs need page-level cookies, so fetch must happen in injected script
 */

import { BaseExtractor, DetectedSubtitle } from './base';

export class YouTubeExtractor extends BaseExtractor {
  name = 'youtube';
  patterns = [
    /youtube\.com/i,
    /youtu\.be/i,
    /youtube-nocookie\.com/i,
  ];

  /**
   * Get the injected script for YouTube-specific extraction
   * IMPORTANT: Fetches subtitles in page context to use page's cookies/credentials
   */
  getInjectedScript(): string {
    return `
      // YouTube Subtitle Extractor - Fetches in page context with credentials
      (function() {
        'use strict';

        const EXTRACTOR_ID = 'youtube-ytInitialPlayerResponse';
        const sentSubtitleUrls = new Set();

        /**
         * Convert subtitle URL to WebVTT format
         */
        function ensureVttFormat(url) {
          if (!url) return null;

          try {
            const urlObj = new URL(url);
            const params = urlObj.searchParams;

            // YouTube supports: vtt, json3, srv1, srv2, srv3, ttml
            // We need VTT for our parser
            if (params.get('fmt') !== 'vtt') {
              params.set('fmt', 'vtt');
            }

            return urlObj.toString();
          } catch {
            // Fallback: simple string replacement
            if (url.includes('fmt=')) {
              return url.replace(/fmt=[^&]+/, 'fmt=vtt');
            }
            return url + (url.includes('?') ? '&' : '?') + 'fmt=vtt';
          }
        }

        /**
         * Extract language info from track object
         */
        function getTrackLanguage(track) {
          return track.languageCode || track.lang || 'unknown';
        }

        /**
         * Extract label from track object
         */
        function getTrackLabel(track) {
          if (track.name) {
            if (typeof track.name === 'string') return track.name;
            if (track.name.simpleText) return track.name.simpleText;
            if (track.name.runs && track.name.runs[0]) return track.name.runs[0].text;
          }

          const lang = getTrackLanguage(track);
          const langNames = {
            en: 'English', es: 'Spanish', fr: 'French', de: 'German',
            it: 'Italian', pt: 'Portuguese', ru: 'Russian', ja: 'Japanese',
            ko: 'Korean', zh: 'Chinese', ar: 'Arabic', hi: 'Hindi',
            nl: 'Dutch', pl: 'Polish', sv: 'Swedish', da: 'Danish',
            fi: 'Finnish', no: 'Norwegian', tr: 'Turkish', id: 'Indonesian',
            th: 'Thai', vi: 'Vietnamese', uk: 'Ukrainian', cs: 'Czech'
          };
          return langNames[lang] || String(lang).toUpperCase();
        }

        /**
         * Fetch subtitle content from URL (in page context with cookies)
         * This is needed because YouTube timedtext API requires page-level credentials
         */
        async function fetchSubtitleContent(url, language, label) {
          try {
            console.log('[FFProfanity-YouTube] Fetching subtitle:', language, url.substring(0, 80) + '...');

            const response = await fetch(url, {
              credentials: 'include',
              headers: {
                'Accept': 'text/vtt,application/vtt,text/plain'
              }
            });

            if (!response.ok) {
              console.warn('[FFProfanity-YouTube] Fetch failed:', response.status, response.statusText);
              return null;
            }

            const text = await response.text();

            if (!text || text.length < 10) {
              console.warn('[FFProfanity-YouTube] Empty or too short response');
              return null;
            }

            console.log('[FFProfanity-YouTube] Fetched', text.length, 'bytes for', language);

            // Send the actual subtitle content back
            window.postMessage({
              type: 'FFPROFANITY_SUBTITLE_CONTENT',
              source: EXTRACTOR_ID,
              language: language,
              label: label,
              content: text
            }, '*');

            return text;
          } catch (error) {
            console.error('[FFProfanity-YouTube] Fetch error:', error);
            return null;
          }
        }

        /**
         * Send detected subtitle tracks to content script
         */
        function sendSubtitleTracks(tracks) {
          if (!tracks || tracks.length === 0) return;

          // Deduplicate by URL
          const uniqueTracks = tracks.filter(t => {
            if (!t.url) return false;
            if (sentSubtitleUrls.has(t.url)) return false;
            sentSubtitleUrls.add(t.url);
            return true;
          });

          if (uniqueTracks.length === 0) return;

          console.log('[FFProfanity-YouTube] Found', uniqueTracks.length, 'caption tracks');

          // Send track metadata first
          window.postMessage({
            type: 'FFPROFANITY_SUBTITLES_DETECTED',
            source: EXTRACTOR_ID,
            subtitles: uniqueTracks.map(t => ({
              url: t.url,
              language: t.language,
              label: t.label,
              isAsr: t.isAsr
            }))
          }, '*');

          // Auto-fetch the first English track, or first track
          const englishTrack = uniqueTracks.find(t => t.language === 'en') || uniqueTracks[0];
          if (englishTrack) {
            fetchSubtitleContent(englishTrack.url, englishTrack.language, englishTrack.label);
          }
        }

        /**
         * Extract caption tracks from ytInitialPlayerResponse
         */
        function extractFromInitialPlayerResponse() {
          try {
            const ypr = window.ytInitialPlayerResponse;

            if (!ypr) {
              console.log('[FFProfanity-YouTube] No ytInitialPlayerResponse found');
              return;
            }

            const captionTracks = ypr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

            if (!captionTracks || !Array.isArray(captionTracks)) {
              console.log('[FFProfanity-YouTube] No captionTracks found');
              return;
            }

            console.log('[FFProfanity-YouTube] Found', captionTracks.length, 'caption tracks in page');

            const subtitles = captionTracks.map(track => {
              const rawUrl = track.baseUrl || track.url;
              const vttUrl = ensureVttFormat(rawUrl);

              const isAsr = track.kind === 'asr' ||
                           (track.captionTrack && track.captionTrack.kind === 'asr') ||
                           track.trackName === 'auto-generated';

              return {
                url: vttUrl,
                language: getTrackLanguage(track),
                label: getTrackLabel(track) + (isAsr ? ' (Auto)' : ''),
                isAsr: isAsr
              };
            }).filter(s => s.url);

            sendSubtitleTracks(subtitles);
          } catch (e) {
            console.warn('[FFProfanity-YouTube] Error extracting:', e);
          }
        }

        // Run immediately if ready
        if (document.readyState === 'complete' || document.readyState === 'interactive') {
          extractFromInitialPlayerResponse();
        } else {
          document.addEventListener('DOMContentLoaded', extractFromInitialPlayerResponse);
        }

        // Retry after delays for dynamic content
        setTimeout(extractFromInitialPlayerResponse, 500);
        setTimeout(extractFromInitialPlayerResponse, 2000);

        // Handle SPA navigation (less aggressive - use history API instead of MutationObserver)
        let lastUrl = location.href;
        const checkForNavigation = () => {
          if (location.href !== lastUrl) {
            lastUrl = location.href;
            console.log('[FFProfanity-YouTube] Navigation detected');
            sentSubtitleUrls.clear();
            setTimeout(extractFromInitialPlayerResponse, 500);
            setTimeout(extractFromInitialPlayerResponse, 2000);
          }
        };

        // Override pushState/replaceState to detect navigation
        const originalPushState = history.pushState;
        const originalReplaceState = history.replaceState;

        if (originalPushState) {
          history.pushState = function(...args) {
            originalPushState.apply(this, args);
            checkForNavigation();
          };
        }

        if (originalReplaceState) {
          history.replaceState = function(...args) {
            originalReplaceState.apply(this, args);
            checkForNavigation();
          };
        }

        // Also listen for popstate
        window.addEventListener('popstate', checkForNavigation);

        console.log('[FFProfanity-YouTube] Extractor initialized');
      })();
    `;
  }

  /**
   * Check if URL is a YouTube video page
   */
  isVideoPage(url: string): boolean {
    try {
      const urlObj = new URL(url);
      return /\/watch\?|\/embed\/|\/v\//.test(urlObj.pathname) ||
             /^https?:\/\/(www\.)?youtu\.be\//i.test(url);
    } catch {
      return false;
    }
  }
}

export const youTubeExtractor = new YouTubeExtractor();