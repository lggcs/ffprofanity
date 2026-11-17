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

  // Addon-state parity with the YouTube page script: the content script
  // broadcasts FFPROFANITY_CC_DISABLED (disabled: !isActive) and answers our
  // init query. While the addon is off, captions are the viewer's business —
  // auto-enable stops and the suppression CSS is lifted so Pluto's own
  // captions render again.
  let ccAutoEnabled = true;

  function removeNativeHideCss(): void {
    try {
      document.getElementById("ffprofanity-hide-native-subtitles")?.remove();
      document.getElementById("ffprofanity-hide-native-subtitles-fallback")?.remove();
    } catch {
      // Nothing to remove yet
    }
  }

  window.addEventListener("message", (e: MessageEvent) => {
    if (e.source !== window) return;
    const data = e.data as { type?: string; disabled?: boolean } | null;
    if (!data?.type) return;
    if (data.type === "FFPROFANITY_CC_DISABLED") {
      ccAutoEnabled = data.disabled !== true;
      if (data.disabled === true) removeNativeHideCss();
      log(
        "Addon state from content script:",
        ccAutoEnabled
          ? "enabled — captions auto-enable active"
          : "disabled — captions left to the viewer",
      );
    }
  });

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
        const line = lines[i];
        if (!line) continue;
        const trimmed = line.trim();
        if (trimmed.startsWith("#") || trimmed.length === 0) continue;

        if (trimmed.includes(".vtt") || trimmed.includes("/webvtt/") || trimmed.includes("webvtt")) {
          const absoluteUrl = new URL(trimmed, manifestUrl).href;
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
    const mtpGroup = mtpMatch?.[1];
    const mtpTime = mtpGroup ? parseInt(mtpGroup, 10) / 1000 : 0;
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

        let activeSubtitleTrack = false;
        const disabledSubtitleTracks: TextTrack[] = [];

        for (let trackIdx = 0; trackIdx < textTracks.length; trackIdx++) {
          const track = textTracks[trackIdx];
          if (!track) continue;
          if (track.kind !== "subtitles" && track.kind !== "captions") continue;
          if (track.mode !== "showing" && track.mode !== "hidden") {
            disabledSubtitleTracks.push(track);
            continue;
          }
          activeSubtitleTrack = true;
          if (!track.cues || track.cues.length === 0) continue;

          const cues = Array.from(track.cues);
          for (const cue of cues) {
            const vttCue = cue as VTTCue;
            const cueId = `${vttCue.startTime}-${vttCue.endTime}-${vttCue.text.substring(0, 20)}`;
            if (trackedCues.has(cueId)) continue;
            trackedCues.add(cueId);

            const startHrs = Math.floor(vttCue.startTime / 3600);
            const startMins = Math.floor((vttCue.startTime % 3600) / 60);
            const startSecs = (vttCue.startTime % 60).toFixed(3);
            const endHrs = Math.floor(vttCue.endTime / 3600);
            const endMins = Math.floor((vttCue.endTime % 3600) / 60);
            const endSecs = (vttCue.endTime % 60).toFixed(3);

            const cueText = `${String(startHrs).padStart(2, "0")}:${String(startMins).padStart(2, "0")}:${startSecs} --> ${String(endHrs).padStart(2, "0")}:${String(endMins).padStart(2, "0")}:${endSecs}\n${vttCue.text}`;

            log("Captured cue from textTracks:", vttCue.startTime.toFixed(2), "-", vttCue.endTime.toFixed(2), vttCue.text.substring(0, 30));

            window.postMessage(
              {
                type: "FFPROFANITY_SUBTITLE_CUE",
                source: "plutotv.texttracks",
                language: track.language || "en",
                label: track.label || track.language || "English",
                cue: cueText,
                startTime: vttCue.startTime,
                endTime: vttCue.endTime,
                text: vttCue.text,
              },
              "*",
            );
          }
        }

        // Captions only reach this monitor once a textTrack is active, which
        // on Pluto happens when the player fetches the rendition — i.e. when
        // the viewer clicks CC. Auto-enable makes that API-level flip for the
        // viewer (English-preferred), the same standing rule as the YouTube
        // re-arm; the addon's CSS suppresses the native render the flip turns
        // on. Stays off while the addon is disabled and never fights an
        // already-active track — the viewer's own pick always wins.
        if (ccAutoEnabled && !activeSubtitleTrack && disabledSubtitleTracks.length > 0) {
          const preferred =
            disabledSubtitleTracks.find(
              (t) =>
                (t.language || "").toLowerCase().startsWith("en") ||
                /english/i.test(t.label || ""),
            ) ?? disabledSubtitleTracks[0];
          if (preferred) {
            preferred.mode = "showing";
            log(
              "Auto-enabled captions track:",
              preferred.label || preferred.language || "(unlabeled)",
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
    // Ask the content script for the current addon state — covers a page
    // reload while the popup Disable is still latched.
    try {
      window.postMessage({ type: "FFPROFANITY_CC_STATE_QUERY" }, "*");
    } catch {
      // Content script not listening yet — its next broadcast settles state
    }
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