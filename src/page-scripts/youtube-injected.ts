/**
 * YouTube Page Script - Injected via browser.scripting.executeScript with world: 'MAIN'
 * This script runs in the page context to access ytInitialPlayerResponse
 * It bypasses CSP by being injected by the extension's background script
 *
 * PO Token (POT) requirement:
 * YouTube requires PO Tokens for timedtext API when exp=xpe is present.
 * Real browsers generate POT via Web Integrity attestation, but automated
 * environments cannot. We intercept YouTube's own timedtext responses
 * which have proper POT already applied.
 */

import {
  extractLanguageFromUrl,
  getLanguageName,
} from "../lib/page-script-helpers";
import {
  createLog,
} from "../lib/network-interception";

const log = createLog();

export function youTubePageScript(): void {
  "use strict";

  // Skip execution in iframes - only run in top frame
  if (window.self !== window.top) {
    return;
  }

  const EXTRACTOR_ID = "youtube-ytInitialPlayerResponse";
  const sentSubtitleUrls = new Set<string>();
  const capturedTimedtext: Map<string, string> = new Map();

  /**
   * Emit captured subtitle content to content script
   */
  function emitSubtitleContent(url: string, content: string): void {
    try {
      const urlObj = new URL(url);
      const params = urlObj.searchParams;
      const videoId = params.get("v");
      const lang = params.get("lang") || "unknown";
      const kind = params.get("kind") || "";
      const isAsr = kind === "asr";

      log("Emitting captured subtitle:", videoId, lang, "isAsr:", isAsr, "bytes:", content.length);

      window.postMessage(
        {
          type: "FFPROFANITY_SUBTITLE_CAPTURED",
          source: EXTRACTOR_ID,
          videoId,
          language: lang,
          isAsr,
          content,
          url,
        },
        "*",
      );
    } catch (e) {
      log("Error emitting subtitle content:", e);
    }
  }

  function ensureVttFormat(url: string): string | null {
    if (!url) return null;

    try {
      const urlObj = new URL(url);
      const params = urlObj.searchParams;
      if (params.get("fmt") !== "vtt") {
        params.set("fmt", "vtt");
      }
      return urlObj.toString();
    } catch {
      if (url.includes("fmt=")) {
        return url.replace(/fmt=[^&]+/, "fmt=vtt");
      }
      return url + (url.includes("?") ? "&" : "?") + "fmt=vtt";
    }
  }

  function getTrackLanguage(track: any): string {
    return track.languageCode || track.lang || "unknown";
  }

  function getTrackLabel(track: any): string {
    if (track.name) {
      if (typeof track.name === "string") return track.name;
      if (track.name.simpleText) return track.name.simpleText;
      if (track.name.runs && track.name.runs[0]) return track.name.runs[0].text;
    }
    const lang = getTrackLanguage(track);
    return getLanguageName(lang);
  }

  // =========================================================================
  // CRITICAL: Set up interception IMMEDIATELY before anything else
  // =========================================================================

  log("Setting up XHR/fetch interception IMMEDIATELY...");

  // YouTube-specific XHR: captures timedtext responses
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...args: any[]) {
    (this as any)._ffprofanity_url = url.toString();
    return (originalXHROpen as any).apply(this, [method, url, ...args]);
  };

  XMLHttpRequest.prototype.send = function (body?: any) {
    const url = (this as any)._ffprofanity_url as string;

    if (url && url.includes("timedtext")) {
      const self = this;
      this.addEventListener("load", function () {
        const content = self.responseText;
        if (content && content.length > 10) {
          log("Captured timedtext via XHR:", url.substring(0, 100), "(", content.length, "bytes)");
          capturedTimedtext.set(url, content);
          emitSubtitleContent(url, content);
        }
      });
    }

    return (originalXHRSend as any).apply(this, [body]);
  };

  // YouTube-specific fetch: captures timedtext responses
  const originalFetch = window.fetch;

  window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input :
                (input as Request).url || (input as URL).toString();

    return (originalFetch as any).apply(this, [input, init]).then(async (response: Response) => {
      if (url && url.includes("timedtext")) {
        const clone = response.clone();
        try {
          const content = await clone.text();
          if (content && content.length > 10) {
            log("Captured timedtext via fetch:", url.substring(0, 100), "(", content.length, "bytes)");
            capturedTimedtext.set(url, content);
            emitSubtitleContent(url, content);
          }
        } catch (e) {
          log("Error capturing timedtext fetch:", e);
        }
      }
      return response;
    });
  };

  log("XHR/fetch interception set up successfully");

  async function fetchSubtitleContent(
    url: string,
    language: string,
    label: string,
  ): Promise<string | null> {
    const cached = capturedTimedtext.get(url);
    if (cached) {
      log("Using cached timedtext for", language);
      window.postMessage(
        {
          type: "FFPROFANITY_SUBTITLE_CONTENT",
          source: EXTRACTOR_ID,
          language,
          label,
          content: cached,
        },
        "*",
      );
      return cached;
    }

    try {
      log("Fetching subtitle:", language, url.substring(0, 80) + "...");
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      try {
        const response = await fetch(url, {
          credentials: "include",
          headers: { Accept: "text/vtt,application/vtt,text/plain,*/*" },
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
        capturedTimedtext.set(url, text);

        window.postMessage(
          {
            type: "FFPROFANITY_SUBTITLE_CONTENT",
            source: EXTRACTOR_ID,
            language,
            label,
            content: text,
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
      log("Fetch error:", error);
      return null;
    }
  }

  function sendSubtitleTracks(tracks: any[]): void {
    if (!tracks || tracks.length === 0) return;

    const uniqueTracks = tracks.filter((t) => {
      if (!t.url) return false;
      if (sentSubtitleUrls.has(t.url)) return false;
      sentSubtitleUrls.add(t.url);
      return true;
    });

    if (uniqueTracks.length === 0) return;

    log("Found", uniqueTracks.length, "caption tracks");

    window.postMessage(
      {
        type: "FFPROFANITY_SUBTITLES_DETECTED",
        source: EXTRACTOR_ID,
        subtitles: uniqueTracks.map((t) => ({
          url: t.url,
          language: t.language,
          label: t.label,
          isAsr: t.isAsr,
        })),
      },
      "*",
    );

    const englishTrack = uniqueTracks.find((t) => t.language === "en") || uniqueTracks[0];
    if (englishTrack) {
      fetchSubtitleContent(englishTrack.url, englishTrack.language, englishTrack.label);
    }
  }

  function extractFromInitialPlayerResponse(): void {
    try {
      const ypr = (window as any).ytInitialPlayerResponse;
      if (!ypr) {
        log("No ytInitialPlayerResponse found");
        return;
      }

      const captionTracks = ypr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (!captionTracks || !Array.isArray(captionTracks)) {
        log("No captionTracks found");
        return;
      }

      log("Found", captionTracks.length, "caption tracks in page");

      const subtitles = captionTracks
        .map((track: any) => {
          const rawUrl = track.baseUrl || track.url;
          const vttUrl = ensureVttFormat(rawUrl);
          const isAsr =
            track.kind === "asr" ||
            (track.captionTrack && track.captionTrack.kind === "asr") ||
            track.trackName === "auto-generated";

          return {
            url: vttUrl,
            language: getTrackLanguage(track),
            label: getTrackLabel(track) + (isAsr ? " (Auto)" : ""),
            isAsr,
          };
        })
        .filter((s: any) => s.url);

      sendSubtitleTracks(subtitles);
    } catch (e) {
      log("Error extracting:", e);
    }
  }

  function setupNavigationWatcher(): void {
    let lastUrl = location.href;

    const checkForNavigation = () => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        log("Navigation detected, re-extracting subtitles");
        sentSubtitleUrls.clear();
        capturedTimedtext.clear();
        setTimeout(extractFromInitialPlayerResponse, 500);
        setTimeout(extractFromInitialPlayerResponse, 2000);
      }
    };

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    if (originalPushState) {
      history.pushState = function (...args: any[]) {
        (originalPushState as any).apply(this, args);
        checkForNavigation();
      };
    }

    if (originalReplaceState) {
      history.replaceState = function (...args: any[]) {
        (originalReplaceState as any).apply(this, args);
        checkForNavigation();
      };
    }

    window.addEventListener("popstate", checkForNavigation);
  }

  function setupResponseWatcher(): void {
    setTimeout(extractFromInitialPlayerResponse, 100);
    setTimeout(extractFromInitialPlayerResponse, 500);
    setTimeout(extractFromInitialPlayerResponse, 1000);
    setTimeout(extractFromInitialPlayerResponse, 2000);
    setTimeout(extractFromInitialPlayerResponse, 3000);
    setTimeout(extractFromInitialPlayerResponse, 5000);
  }

  function setupCaptionButtonListener(): void {
    document.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const isCaptionButton =
        target.classList.contains("ytp-subtitles-button") ||
        target.closest(".ytp-subtitles-button");

      if (isCaptionButton) {
        log("Caption button clicked, will capture timedtext");
        setTimeout(() => extractFromInitialPlayerResponse(), 500);
        setTimeout(() => extractFromInitialPlayerResponse(), 2000);
      }
    }, true);
  }

  function tryEnableCaptions(): void {
    const ccButton = document.querySelector(".ytp-subtitles-button") as HTMLButtonElement;
    if (!ccButton) {
      log("No CC button found");
      return;
    }

    const isEnabled = ccButton.getAttribute("aria-pressed") === "true";

    if (isEnabled) {
      log("Captions already enabled, timedtext should be loading");
      const ypr = (window as any).ytInitialPlayerResponse;
      const captionTracks = ypr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (!captionTracks || captionTracks.length === 0) {
        if ((window as any).__ffprofanity_caption_toggled) {
          log("Live stream: No caption tracks available after toggle");
          return;
        }
        log("Live stream with no tracks - toggling captions to trigger timedtext");
        (window as any).__ffprofanity_caption_toggled = true;
        ccButton.click();
        setTimeout(() => {
          ccButton.click();
          setTimeout(() => extractFromInitialPlayerResponse(), 500);
        }, 100);
        return;
      }
      return;
    }

    if ((window as any).__ffprofanity_caption_triggered) {
      log("Already tried enabling captions");
      return;
    }
    (window as any).__ffprofanity_caption_triggered = true;

    log("Clicking CC button to trigger caption loading");
    ccButton.click();

    setTimeout(() => {
      const tracks = document.querySelectorAll("track");
      log("After CC click, found", tracks.length, "track elements");
      extractFromInitialPlayerResponse();
    }, 1000);
  }

  function init(): void {
    log("YouTube extractor initialized via MAIN world injection");

    if (document.readyState === "complete" || document.readyState === "interactive") {
      extractFromInitialPlayerResponse();
      setTimeout(tryEnableCaptions, 1500);
    } else {
      document.addEventListener("DOMContentLoaded", () => {
        extractFromInitialPlayerResponse();
        setTimeout(tryEnableCaptions, 1500);
      });
    }

    setupNavigationWatcher();
    setupResponseWatcher();
    setupCaptionButtonListener();

    const videoObserver = new MutationObserver(() => {
      const video = document.querySelector("video");
      const ccButton = document.querySelector(".ytp-subtitles-button");
      if (video && ccButton && !(window as any).__ffprofanity_caption_triggered) {
        setTimeout(tryEnableCaptions, 500);
      }
    });
    videoObserver.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => videoObserver.disconnect(), 10000);

    log("ytInitialPlayerResponse extraction ready");
    log("Network interception active - will capture timedtext responses");
  }

  init();
}

// Self-execute when loaded
if (typeof window !== "undefined") {
  youTubePageScript();
}