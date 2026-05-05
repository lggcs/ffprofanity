/**
 * PlutoTV Page Script - Injected via browser.scripting.executeScript with world: 'MAIN'
 * This script runs in the page context to intercept network requests and detect subtitles
 * It bypasses CSP by being injected by the extension's background script
 */

import {
  extractLanguageFromUrl,
  getLanguageName,
  isValidSubtitleUrl,
  formatVTTTime,
} from "../lib/page-script-helpers";
import {
  createSendSubtitles,
  createSendSubtitleContent,
  createLog,
  interceptXHR,
  interceptFetch,
  type SubtitleTrack,
  type InterceptOptions,
} from "../lib/network-interception";
import { parseHLSManifest } from "../lib/hls-parser";

const log = createLog();
const sendSubtitles = createSendSubtitles("plutotv");
const sendSubtitleContent = createSendSubtitleContent("plutotv");

function plutoTVPageScript(): void {
  "use strict";

  // Skip execution in iframes - only run in top frame
  if (window.self !== window.top) {
    return;
  }

  // Determine if we're on a live TV page (checked once at init)
  const isLiveTVPage = window.location.href.includes("/live-tv/");

  async function fetchSubtitleContent(
    url: string,
    language: string,
    label: string,
    isHLSManifest: boolean,
  ): Promise<string | null> {
    try {
      if (!isValidSubtitleUrl(url)) return null;

      log("Fetching subtitle:", language, isHLSManifest ? "(HLS manifest)" : "", url.substring(0, 80) + "...");

      if (isHLSManifest) {
        return await fetchHLSManifestContent(url, language, label);
      }

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
            language,
            label,
            content: text,
            url,
          },
          "*",
        );

        return text;
      } catch (fetchError) {
        clearTimeout(timeoutId);
        if ((fetchError as Error).name === "AbortError") {
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
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      let response: Response;
      try {
        response = await fetch(manifestUrl, {
          credentials: "include",
          headers: {
            Accept: "application/vnd.apple.mpegurl,application/x-mpegurl,text/plain",
          },
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
      } catch (fetchError) {
        clearTimeout(timeoutId);
        if ((fetchError as Error).name === "AbortError") {
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

        if (line.includes(".vtt") || line.includes("/webvtt/") || line.includes("webvtt")) {
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

  // Content callback for intercepted subtitles: includes PlutoTV-specific mtp timing
  const onInterceptedContent = (content: string, language: string, label: string, url: string) => {
    const videoEl = document.querySelector("video");
    const mtpMatch =
      url.match(/mtp%3D(\d+)/i) ||
      url.match(/mtp%3A(\d+)/i) ||
      url.match(/[&?]mtp=(\d+)/i);
    const mtpTime = mtpMatch ? parseInt(mtpMatch[1], 10) / 1000 : 0;
    const segmentLoadTime = mtpTime > 0 ? mtpTime : videoEl ? videoEl.currentTime : 0;
    const streamType = isLiveTVPage ? "live" : "vod";

    window.postMessage(
      {
        type: "FFPROFANITY_SUBTITLE_CONTENT",
        source: "plutotv.intercepted",
        language,
        label,
        content,
        url,
        segmentLoadTime,
        streamType,
      },
      "*",
    );
  };

  function setupXHR(): void {
    interceptXHR(sendSubtitles, {
      subtitleSource: "xhr-subtitle",
      hlsSource: "xhr-hls",
      checkHLS: true,
      checkSubtitles: true,
      parseHLSManifest,
      fetchSubtitleContent,
      onContent: onInterceptedContent,
    });
  }

  function setupFetch(): void {
    interceptFetch(sendSubtitles, {
      subtitleSource: "fetch-subtitle",
      hlsSource: "fetch-hls",
      checkHLS: true,
      checkSubtitles: true,
      parseHLSManifest,
      fetchSubtitleContent,
      onContent: onInterceptedContent,
    });
  }

  function monitorTextTracks(): void {
    log("Starting textTracks monitor");

    const trackedCues = new Set<string>();

    setInterval(() => {
      try {
        const videoEl = document.querySelector("video");
        if (!videoEl) return;

        const textTracks = videoEl.textTracks;
        if (!textTracks || textTracks.length === 0) return;

        for (let trackIdx = 0; trackIdx < textTracks.length; trackIdx++) {
          const track = textTracks[trackIdx];
          if (track.kind !== "subtitles" && track.kind !== "captions") continue;
          if (track.mode !== "showing" && track.mode !== "hidden") continue;
          if (!track.cues || track.cues.length === 0) continue;

          const cues = Array.from(track.cues);
          for (const cue of cues) {
            const cueId = `${cue.startTime}-${cue.endTime}-${cue.text.substring(0, 20)}`;
            if (trackedCues.has(cueId)) continue;
            trackedCues.add(cueId);

            const startHrs = Math.floor(cue.startTime / 3600);
            const startMins = Math.floor((cue.startTime % 3600) / 60);
            const startSecs = (cue.startTime % 60).toFixed(3);
            const endHrs = Math.floor(cue.endTime / 3600);
            const endMins = Math.floor((cue.endTime % 3600) / 60);
            const endSecs = (cue.endTime % 60).toFixed(3);

            const vttCue = `${String(startHrs).padStart(2, "0")}:${String(startMins).padStart(2, "0")}:${startSecs} --> ${String(endHrs).padStart(2, "0")}:${String(endMins).padStart(2, "0")}:${endSecs}\n${cue.text}`;

            log("Captured cue from textTracks:", cue.startTime.toFixed(2), "-", cue.endTime.toFixed(2), cue.text.substring(0, 30));

            window.postMessage(
              {
                type: "FFPROFANITY_SUBTITLE_CUE",
                source: "plutotv.texttracks",
                language: track.language || "en",
                label: track.label || track.language || "English",
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
        if ((window as any).__FFPROFANITY_DEBUG__) {
          console.error("[FFProfanity] textTracks monitor error:", err);
        }
      }
    }, 200);

    log("textTracks monitor installed");
  }

  function init(): void {
    log("PlutoTV extractor initialized via MAIN world injection");
    setupXHR();
    setupFetch();
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