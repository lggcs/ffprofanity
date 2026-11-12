/**
 * PeerTube Site Extractor
 * Handles subtitle detection for PeerTube instances (peertube.tv,
 * framatube.org, tilvids.com, ... — federated, so instances cannot be
 * enumerated by hostname).
 *
 * ARCHITECTURE (verified live on peertube.tv):
 * Watch URLs carry the video id in the path (/w/{shortId}, /videos/watch/
 * {uuid}) and embeds use /videos/embed/{uuid}; the video id works directly
 * against the instance's public captions API:
 *   GET /api/v1/videos/{id}/captions
 *   -> { data: [{ language: {id, label}, automaticallyGenerated,
 *               captionPath, fileUrl, m3u8Url }] }
 * fileUrl serves the raw WEBVTT (text/vtt) with access-control-allow-origin *,
 * so the content pipeline can fetch it itself — the extractor only relays
 * track metadata (FFPROFANITY_SUBTITLES_DETECTED, source 'peertube').
 *
 * matches() is path-shape based and self-validating: the inline script only
 * acts when the captions API answers with JSON caption entries, so a stray
 * match on a non-PeerTube site is a harmless 404. PeerTube ships no CSP by
 * default (verified on peertube.tv), so detection runs from the generic
 * inline interceptor (getInjectedScript) like CineLite/Cinebto — the
 * MAIN-world page-script convention is not usable here because its
 * background injection gate is hostname-regex based.
 */

import { BaseExtractor, DetectedSubtitle } from "./base";

export class PeertubeExtractor extends BaseExtractor {
  name = "peertube";
  patterns = [/peertube/i];

  matches(url: string): boolean {
    try {
      const { pathname } = new URL(url);
      if (/^\/videos\/(watch|embed)\/[^/?;]+/.test(pathname)) return true;
      // Captions API responses are seen by the background webRequest
      // listener with this path; extractFromResponse validates the body
      // shape, so a lookalike path on another site stays harmless.
      if (/^\/api\/v1\/videos\/[^/]+\/captions/.test(pathname)) return true;
      return /^\/w\/[\w-]{6,}/.test(pathname);
    } catch {
      return false;
    }
  }

  extractFromResponse(url: string, responseText: string): DetectedSubtitle[] {
    if (!/\/api\/v1\/videos\/[^/]+\/captions(\?|$)/.test(url)) return [];

    try {
      const data = JSON.parse(responseText) as {
        data?: Array<Record<string, any>>;
      };
      const list = Array.isArray(data.data) ? data.data : [];
      if (list.length === 0) return [];

      let origin = "";
      try {
        origin = new URL(url).origin;
      } catch {
        origin = "";
      }

      const subs: DetectedSubtitle[] = [];
      for (const c of list) {
        const rawUrl =
          typeof c.fileUrl === "string" && c.fileUrl
            ? c.fileUrl
            : typeof c.captionPath === "string" && c.captionPath
              ? origin + c.captionPath
              : null;
        if (!rawUrl) continue;

        const lang = (c.language && c.language.id) || "unknown";
        let label = (c.language && c.language.label) || String(lang).toUpperCase();
        if (c.automaticallyGenerated) label += " (Auto)";

        subs.push({ url: rawUrl, language: lang, label, source: this.name });
      }
      return subs;
    } catch {
      return [];
    }
  }

  getInjectedScript(): string {
    return `
      // PeerTube Subtitle Extractor (inline - no default CSP on instances)
      (function() {
        'use strict';
        if (window.__ffprofanityPeertubeHooked) return;
        window.__ffprofanityPeertubeHooked = true;

        var EXTRACTOR_ID = 'peertube';
        var sentUrls = {};

        function log() {
          var args = Array.prototype.slice.call(arguments);
          console.log('[FFProfanity][' + EXTRACTOR_ID + ']', args.join(' '));
        }

        function extractVideoId() {
          var m = location.pathname.match(/^\\/w\\/([^\\/?;]+)/);
          if (m && m[1]) return m[1];
          m = location.pathname.match(/^\\/videos\\/(?:watch|embed)\\/([^\\/?;]+)/);
          if (m && m[1]) return m[1];
          return null;
        }

        function relayCaptions(videoId) {
          fetch(location.origin + '/api/v1/videos/' + videoId + '/captions',
                { credentials: 'same-origin' })
            .then(function(r) {
              if (!r.ok) return null;
              var ct = r.headers.get('content-type') || '';
              return ct.indexOf('json') !== -1 ? r.json() : null;
            })
            .then(function(data) {
              if (!data || !data.data || !data.data.length) return;
              var subs = [];
              for (var i = 0; i < data.data.length; i++) {
                var c = data.data[i];
                var url = (typeof c.fileUrl === 'string' && c.fileUrl)
                  ? c.fileUrl
                  : (typeof c.captionPath === 'string' && c.captionPath)
                    ? location.origin + c.captionPath
                    : null;
                if (!url || sentUrls[url]) continue;
                sentUrls[url] = true;
                var lang = (c.language && c.language.id) || 'unknown';
                var label = (c.language && c.language.label) || String(lang).toUpperCase();
                if (c.automaticallyGenerated) label += ' (Auto)';
                subs.push({ url: url, language: lang, label: label });
              }
              if (!subs.length) return;
              log('Relaying', subs.length, 'caption track(s) for', videoId);
              window.postMessage({
                type: 'FFPROFANITY_SUBTITLES_DETECTED',
                source: EXTRACTOR_ID,
                subtitles: subs
              }, '*');
            })
            .catch(function() { /* not a PeerTube page or API hiccup - stay quiet */ });
        }

        function probe() {
          var id = extractVideoId();
          if (id) relayCaptions(id);
        }

        // The captions API is server-rendered per video; short retries cover
        // a late-settling SPA router.
        probe();
        setTimeout(probe, 1500);
        setTimeout(probe, 4000);

        // SPA navigation swaps videos in-document; /w/ transitions do not
        // reload the page, so watch the path.
        var lastPath = location.pathname;
        function onNav() {
          if (location.pathname === lastPath) return;
          lastPath = location.pathname;
          setTimeout(probe, 400);
          setTimeout(probe, 2000);
        }
        var ps = history.pushState;
        if (ps) history.pushState = function() { ps.apply(this, arguments); onNav(); };
        var rs = history.replaceState;
        if (rs) history.replaceState = function() { rs.apply(this, arguments); onNav(); };
        window.addEventListener('popstate', onNav);
        setInterval(onNav, 3000);
      })();
    `;
  }
}

export const peertubeExtractor = new PeertubeExtractor();
