/**
 * PlutoTV Page Script - Injected via browser.scripting.executeScript with world: 'MAIN'
 * This script runs in the page context to intercept network requests and detect subtitles
 * It bypasses CSP by being injected by the extension's background script
 */

export function plutoTVPageScript(): void {
  "use strict";

  // Skip execution in iframes - only run in top frame
  if (window.self !== window.top) {
    return;
  }

  const EXTRACTOR_ID = "plutotv";
  const sentSubtitles = new Set<string>();

  const FONT_EXTENSIONS = [".otf", ".ttf", ".woff", ".woff2", ".eot"];
  const SUBTITLE_EXTENSIONS = [".vtt", ".srt", ".ass", ".ssa", ".sub"];

  // Determine if we're on a live TV page (checked once at init)
  const isLiveTVPage = window.location.href.includes("/live-tv/");

  function log(...args: unknown[]): void {
    console.log("[PlutoTV]", ...args);
  }

  function isValidSubtitleUrl(url: string): boolean {
    if (!url) return false;
    const lowerUrl = url.toLowerCase();

    if (FONT_EXTENSIONS.some((ext) => lowerUrl.endsWith(ext))) {
      return false;
    }

    if (SUBTITLE_EXTENSIONS.some((ext) => lowerUrl.includes(ext))) {
      return true;
    }

    if (lowerUrl.includes(".m3u8")) {
      return true;
    }

    try {
      const urlObj = new URL(url);
      if (
        urlObj.searchParams.has("subtitle") ||
        urlObj.searchParams.has("subs") ||
        urlObj.searchParams.has("captions")
      ) {
        return true;
      }
    } catch {}

    return false;
  }

  function sendSubtitles(
    subs: Array<{ url: string; language: string; label: string }>,
    source: string,
  ): void {
    if (!subs || subs.length === 0) return;

    const uniqueSubs = subs.filter((s) => {
      if (!s.url) return false;
      if (!isValidSubtitleUrl(s.url)) {
        log("Rejecting non-subtitle URL:", s.url.substring(0, 80));
        return false;
      }
      if (sentSubtitles.has(s.url)) return false;
      sentSubtitles.add(s.url);
      return true;
    });

    if (uniqueSubs.length === 0) return;

    log("Sending", uniqueSubs.length, "subtitles from", source);

    window.postMessage(
      {
        type: "FFPROFANITY_SUBTITLES_DETECTED",
        source: source,
        subtitles: uniqueSubs.map((s) => ({
          url: s.url,
          language: s.language || "unknown",
          label: s.label || "Unknown",
        })),
      },
      "*",
    );
  }

  // NOTE: extractLanguageFromUrl duplicated from lib/language.ts - must be self-contained for injected script context
  function extractLanguageFromUrl(url: string): string {
    const langMatch = url.match(/[_\-\/]([a-z]{2,3})(?:[_\-\.]|$)/i);
    return langMatch ? langMatch[1].toLowerCase() : "unknown";
  }

  // NOTE: getLanguageName duplicated from lib/language.ts - must be self-contained for injected script context
  function getLanguageName(code: string): string {
    const languageNames: Record<string, string> = {
      en: "English",
      es: "Spanish",
      fr: "French",
      de: "German",
      it: "Italian",
      pt: "Portuguese",
      ru: "Russian",
      ja: "Japanese",
      ko: "Korean",
      zh: "Chinese",
      ar: "Arabic",
      hi: "Hindi",
    };
    return languageNames[code] || code.toUpperCase();
  }

  async function fetchSubtitleContent(
    url: string,
    language: string,
    label: string,
    isHLSManifest: boolean,
  ): Promise<string | null> {
    try {
      if (!isValidSubtitleUrl(url)) {
        log("Skipping non-subtitle URL:", url.substring(0, 80));
        return null;
      }

      log(
        "Fetching subtitle:",
        language,
        isHLSManifest ? "(HLS manifest)" : "",
        url.substring(0, 80) + "...",
      );

      if (isHLSManifest) {
        return await fetchHLSManifestContent(url, language, label);
      }

      // Add 10 second timeout for fetch
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      try {
        const response = await fetch(url, {
          credentials: "include",
          headers: { Accept: "text/vtt,application/vtt,text/plain" },
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          log("Fetch failed:", response.status, response.statusText);
          return null;
        }

        const text = await response.text();
        if (!text || text.length < 10) {
          log("Empty or too short response");
          return null;
        }

        log("Fetched", text.length, "bytes for", language);

        window.postMessage(
          {
            type: "FFPROFANITY_SUBTITLE_CONTENT",
            source: "plutotv-page-context",
            language: language,
            label: label,
            content: text,
            url: url,
          },
          "*",
        );

        return text;
      } catch (fetchError) {
        clearTimeout(timeoutId);
        if ((fetchError as Error).name === 'AbortError') {
          log("Fetch timed out after 10s:", url.substring(0, 60));
        } else {
          throw fetchError;
        }
        return null;
      }
    } catch (error) {
      log("Fetch error:", (error as Error).message || error);
      return null;
    }
  }

  async function fetchHLSManifestContent(
    manifestUrl: string,
    language: string,
    label: string,
  ): Promise<string | null> {
    try {
      // Add 10 second timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      let response: Response;
      try {
        response = await fetch(manifestUrl, {
          credentials: "include",
          headers: {
            Accept:
              "application/vnd.apple.mpegurl,application/x-mpegurl,text/plain",
          },
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
      } catch (fetchError) {
        clearTimeout(timeoutId);
        if ((fetchError as Error).name === 'AbortError') {
          log("HLS manifest fetch timed out after 10s");
        } else {
          throw fetchError;
        }
        return null;
      }

      if (!response.ok) {
        log("HLS manifest fetch failed:", response.status);
        return null;
      }

      const manifestText = await response.text();
      log("Got HLS manifest:", manifestText.length, "bytes");

      const lines = manifestText.split("\n");
      const vttUrls: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith("#") || line.length === 0) continue;

        if (
          line.includes(".vtt") ||
          line.includes("/webvtt/") ||
          line.includes("webvtt")
        ) {
          const absoluteUrl = new URL(line, manifestUrl).href;
          vttUrls.push(absoluteUrl);
        }
      }

      if (vttUrls.length === 0) {
        log("No VTT URLs found in HLS manifest");
        return null;
      }

      log("Found", vttUrls.length, "VTT segments in HLS manifest");

      for (const vttUrl of vttUrls.slice(0, 10)) {
        await fetchSubtitleContent(vttUrl, language, label, false);
      }

      return manifestText;
    } catch (error) {
      log("HLS manifest error:", (error as Error).message || error);
      return null;
    }
  }

  function parseHLSManifest(
    content: string,
    baseUrl: string,
  ): Array<{ url: string; language: string; label: string }> {
    const tracks: Array<{ url: string; language: string; label: string }> = [];
    const lines = content.split("\n");

    let currentInfo: {
      type?: string;
      language?: string;
      label?: string;
      url?: string;
    } = {};

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith("#EXT-X-MEDIA:TYPE=SUBTITLES")) {
        currentInfo = { type: "subtitles" };
        const attrs = line.slice("#EXT-X-MEDIA:".length);
        const langMatch = attrs.match(/LANGUAGE="([^"]+)"/i);
        const nameMatch = attrs.match(/NAME="([^"]+)"/i);

        if (langMatch) currentInfo.language = langMatch[1];
        if (nameMatch) currentInfo.label = nameMatch[1];
      }

      if (
        currentInfo.type === "subtitles" &&
        !line.startsWith("#") &&
        line.length > 0
      ) {
        currentInfo.url = new URL(line, baseUrl).href;

        if (currentInfo.url && currentInfo.language) {
          tracks.push({
            url: currentInfo.url,
            language: currentInfo.language,
            label: currentInfo.label || currentInfo.language,
          });
        }

        currentInfo = {};
      }
    }

    return tracks;
  }

  function interceptXHR(): void {
    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;

    (XMLHttpRequest.prototype as any)._ffprofanity_url = "";

    XMLHttpRequest.prototype.open = function (method: string, url: string) {
      (this as any)._ffprofanity_url = url;
      return originalXHROpen.apply(this, arguments as any);
    };

    XMLHttpRequest.prototype.send = function () {
      const xhr = this;
      const reqUrl = (xhr as any)._ffprofanity_url || "";

      xhr.addEventListener("load", function () {
        const canReadResponseText =
          xhr.responseType === "" || xhr.responseType === "text";

        if (
          canReadResponseText &&
          (reqUrl.includes(".m3u8") ||
            reqUrl.includes("master") ||
            reqUrl.includes("playlist"))
        ) {
          try {
            const content = xhr.responseText;
            const subs = parseHLSManifest(content, reqUrl);

            if (subs.length > 0) {
              log(
                "Found",
                subs.length,
                "subs in HLS manifest:",
                reqUrl.substring(0, 60),
              );
              sendSubtitles(subs, "plutotv.xhr-hls");

              for (const sub of subs) {
                if (
                  sub.url.includes("subtitle") ||
                  sub.url.includes("subs") ||
                  sub.url.includes(".m3u8")
                ) {
                  fetchSubtitleContent(sub.url, sub.language, sub.label, true);
                } else {
                  fetchSubtitleContent(sub.url, sub.language, sub.label, false);
                }
              }
            }
          } catch {}
        }

        if (
          /\.(vtt|srt|ass|ssa)(\?|$)/i.test(reqUrl) &&
          !reqUrl.includes("blob:")
        ) {
          log("Intercepted subtitle URL:", reqUrl);
          const lang = extractLanguageFromUrl(reqUrl);
          const label = getLanguageName(lang);
          sendSubtitles(
            [{ url: reqUrl, language: lang, label }],
            "plutotv.xhr-subtitle",
          );

          // Handle both text and arraybuffer response types
          let content: string | null = null;
          if (canReadResponseText) {
            content = xhr.responseText;
          } else if (xhr.responseType === "arraybuffer" && xhr.response) {
            try {
              const decoder = new TextDecoder("utf-8");
              content = decoder.decode(xhr.response as ArrayBuffer);
            } catch {}
          }

          if (content && content.length > 10) {
            log(
              "Sending intercepted content:",
              content.length,
              "bytes for",
              lang,
            );
            const videoEl = document.querySelector("video");
            // Handle all URL encoding variants: mtp%3D (encoded =), mtp%3A (encoded :), mtp= (unencoded)
            const mtpMatch =
              reqUrl.match(/mtp%3D(\d+)/i) ||
              reqUrl.match(/mtp%3A(\d+)/i) ||
              reqUrl.match(/[&?]mtp=(\d+)/i);
            const mtpTime = mtpMatch ? parseInt(mtpMatch[1], 10) / 1000 : 0;
            const segmentLoadTime =
              mtpTime > 0 ? mtpTime : videoEl ? videoEl.currentTime : 0;
            const streamType = isLiveTVPage ? "live" : "vod";
            window.postMessage(
              {
                type: "FFPROFANITY_SUBTITLE_CONTENT",
                source: "plutotv.xhr-intercepted",
                language: lang,
                label: label,
                content: content,
                url: reqUrl,
                segmentLoadTime: segmentLoadTime,
                streamType: streamType,
              },
              "*",
            );
          }
        }
      });

      return originalXHRSend.apply(this, arguments as any);
    };
  }

  function interceptFetch(): void {
    const originalFetch = window.fetch;

    window.fetch = async function (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;

      try {
        const response = await originalFetch.apply(this, arguments as any);

        if (
          url.includes(".m3u8") ||
          url.includes("master") ||
          url.includes("playlist")
        ) {
          try {
            const clonedResponse = response.clone();
            const content = await clonedResponse.text();
            const subs = parseHLSManifest(content, url);

            if (subs.length > 0) {
              log(
                "Found",
                subs.length,
                "subs in fetch HLS manifest:",
                url.substring(0, 60),
              );
              sendSubtitles(subs, "plutotv.fetch-hls");

              for (const sub of subs) {
                if (
                  sub.url.includes("subtitle") ||
                  sub.url.includes("subs") ||
                  sub.url.includes(".m3u8")
                ) {
                  fetchSubtitleContent(sub.url, sub.language, sub.label, true);
                } else {
                  fetchSubtitleContent(sub.url, sub.language, sub.label, false);
                }
              }
            }
          } catch {}
        }

        if (/\.(vtt|srt|ass|ssa)(\?|$)/i.test(url) && !url.includes("blob:")) {
          log("Intercepted subtitle URL:", url);
          const lang = extractLanguageFromUrl(url);
          const label = getLanguageName(lang);
          sendSubtitles(
            [{ url, language: lang, label }],
            "plutotv.fetch-subtitle",
          );
          try {
            const content = await response.clone().text();
            if (content && content.length > 10) {
              log(
                "Sending intercepted content:",
                content.length,
                "bytes for",
                lang,
              );
              const videoEl = document.querySelector("video");
              const mtpMatch =
                url.match(/mtp%3D(\d+)/i) ||
                url.match(/mtp%3A(\d+)/i) ||
                url.match(/[&?]mtp=(\d+)/i);
              const mtpTime = mtpMatch ? parseInt(mtpMatch[1], 10) / 1000 : 0;
              const segmentLoadTime =
                mtpTime > 0 ? mtpTime : videoEl ? videoEl.currentTime : 0;
              const streamType = isLiveTVPage ? "live" : "vod";
              window.postMessage(
                {
                  type: "FFPROFANITY_SUBTITLE_CONTENT",
                  source: "plutotv.fetch-intercepted",
                  language: lang,
                  label: label,
                  content: content,
                  url: url,
                  segmentLoadTime: segmentLoadTime,
                  streamType: streamType,
                },
                "*",
              );
            }
          } catch {}
        }

        return response;
      } catch (error) {
        throw error;
      }
    };
  }

  function monitorTextTracks(): void {
    log("Starting textTracks monitor");
    
    const trackedCues = new Set<string>();
    
    setInterval(() => {
      try {
        const videoEl = document.querySelector('video');
        if (!videoEl) return;
        
        const textTracks = videoEl.textTracks;
        if (!textTracks || textTracks.length === 0) return;
        
        for (let trackIdx = 0; trackIdx < textTracks.length; trackIdx++) {
          const track = textTracks[trackIdx];
          if (track.kind !== 'subtitles' && track.kind !== 'captions') continue;
          if (track.mode !== 'showing' && track.mode !== 'hidden') continue;
          if (!track.cues || track.cues.length === 0) continue;
          
          const cues = Array.from(track.cues);
          for (const cue of cues) {
            const cueId = `${cue.startTime}-${cue.endTime}-${cue.text.substring(0, 20)}`;
            if (trackedCues.has(cueId)) continue;
            trackedCues.add(cueId);
            
            // Convert VTTCue to WebVTT format for our parser
            // These cues have already been adjusted by HLS.js for correct timing
            const startHrs = Math.floor(cue.startTime / 3600);
            const startMins = Math.floor((cue.startTime % 3600) / 60);
            const startSecs = (cue.startTime % 60).toFixed(3);
            const endHrs = Math.floor(cue.endTime / 3600);
            const endMins = Math.floor((cue.endTime % 3600) / 60);
            const endSecs = (cue.endTime % 60).toFixed(3);
            
            const vttCue = `${String(startHrs).padStart(2, '0')}:${String(startMins).padStart(2, '0')}:${startSecs} --> ${String(endHrs).padStart(2, '0')}:${String(endMins).padStart(2, '0')}:${endSecs}\n${cue.text}`;
            
            log("Captured cue from textTracks:", cue.startTime.toFixed(2), '-', cue.endTime.toFixed(2), cue.text.substring(0, 30));
            
            window.postMessage(
              {
                type: "FFPROFANITY_SUBTITLE_CUE",
                source: "plutotv.texttracks",
                language: track.language || 'en',
                label: track.label || track.language || 'English',
                cue: vttCue,
                startTime: cue.startTime,
                endTime: cue.endTime,
                text: cue.text,
              },
              "*",
            );
          }
        }
      } catch (err) {
        console.error('[PlutoTV] textTracks monitor error:', err);
      }
    }, 200); // Check 5 times per second
    
    log("textTracks monitor installed");
  }

  function init(): void {
    log("PlutoTV extractor initialized via MAIN world injection");
    interceptXHR();
    interceptFetch();
    monitorTextTracks();
    log("XHR and fetch interception installed");
  }

  if (
    document.readyState === "complete" ||
    document.readyState === "interactive"
  ) {
    init();
  } else {
    document.addEventListener("DOMContentLoaded", init);
  }
}

// Self-execute when loaded
if (typeof window !== "undefined") {
  plutoTVPageScript();
}
