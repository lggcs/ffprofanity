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

  // The background injects this script at onCommitted — often before the
  // content script has attached its message listener — and its own retry
  // dedup means a message sent into the void is never sent again. Buffer
  // every relay until the content script signals it is listening.
  let relayReady = false;
  const pendingPrelude: any[] = [];

  function flushPrelude(): void {
    if (!relayReady || pendingPrelude.length === 0) return;
    const prelude = pendingPrelude.splice(0);
    for (const msg of prelude) window.postMessage(msg, "*");
  }

  function markRelayReady(): void {
    if (relayReady) return;
    try {
      if (!document.documentElement.hasAttribute("data-ffprofanity-relay-ready")) {
        return;
      }
    } catch {
      // No document element yet — stay buffered
    }
    relayReady = true;
    flushPrelude();
  }

  function relayPost(msg: Record<string, unknown>): void {
    if (relayReady) {
      window.postMessage(msg, "*");
      return;
    }
    pendingPrelude.push(msg);
  }

  window.addEventListener("message", (e: MessageEvent) => {
    if (e.source !== window) return;
    if ((e.data as { type?: string } | null)?.type !== "FFPROFANITY_RELAY_READY") return;
    markRelayReady();
  });

  // A READY posted before this script existed is gone; the DOM attribute
  // the content script sets is the listener-independent signal.
  const readyPoll = setInterval(markRelayReady, 250);
  setTimeout(() => {
    clearInterval(readyPoll);
    if (!relayReady && pendingPrelude.length > 0) {
      // Deliver anyway rather than lose the only copy of this data.
      relayReady = true;
      flushPrelude();
    }
  }, 15000);

  /**
   * The player element that actually carries media data. Shorts pages keep
   * #movie_player as an empty stub and mount the real player as
   * #shorts-player, so the stub must not win just by being queried first.
   */
  function getLivePlayer(): any | null {
    const candidates: any[] = [
      document.getElementById("movie_player"),
      document.getElementById("shorts-player"),
    ].filter(Boolean);
    for (const p of candidates) {
      try {
        if (p?.getVideoData?.()?.video_id) return p;
      } catch {
        // Player API not ready for this element
      }
    }
    return candidates[0] || null;
  }

  /**
   * Video Id the player is actually showing right now. YouTube rewrites the
   * URL on playlist transitions, so ?v= in location.search is authoritative;
   * Shorts pages carry the Id in the path instead and expose none in the
   * player response; falls back to the player API and the document response.
   */
  function getCurrentVideoId(): string | null {
    const urlVid = new URLSearchParams(window.location.search).get("v");
    if (urlVid) return urlVid;
    const shortsVid = window.location.pathname.match(/\/shorts\/([\w-]+)/)?.[1];
    if (shortsVid) return shortsVid;
    try {
      const data = getLivePlayer()?.getVideoData?.();
      if (data?.video_id) return data.video_id;
    } catch {
      // Player API not ready
    }
    try {
      const ypr = (window as any).ytInitialPlayerResponse;
      if (ypr?.videoId) return ypr.videoId;
    } catch {
      // Not available
    }
    return null;
  }

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

      // A timedtext response can resolve after a playlist transition moved
      // the player to another video; forwarding it would desync the new video.
      const currentVid = getCurrentVideoId();
      if (videoId && currentVid && videoId !== currentVid) {
        log("Dropping captured timedtext for previous video:", videoId);
        return;
      }

      log("Emitting captured subtitle:", videoId, lang, "isAsr:", isAsr, "bytes:", content.length);

      relayPost(
        {
          type: "FFPROFANITY_SUBTITLE_CAPTURED",
          source: EXTRACTOR_ID,
          videoId,
          language: lang,
          isAsr,
          content,
          url,
        },
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
      relayPost(
        {
          type: "FFPROFANITY_SUBTITLE_CONTENT",
          source: EXTRACTOR_ID,
          language,
          label,
          url,
          content: cached,
        },
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

        relayPost(
          {
            type: "FFPROFANITY_SUBTITLE_CONTENT",
            source: EXTRACTOR_ID,
            language,
            label,
            url,
            content: text,
          },
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

    relayPost(
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
    );

    const englishTrack = uniqueTracks.find((t) => t.language === "en") || uniqueTracks[0];
    if (englishTrack) {
      fetchSubtitleContent(englishTrack.url, englishTrack.language, englishTrack.label);
    }
  }

  function extractFromInitialPlayerResponse(): void {
    try {
      // Prefer the player's live response: on playlist transitions YouTube
      // swaps videos without replacing the document-level one, so
      // window.ytInitialPlayerResponse can still hold the previous video's
      // caption tracks long after the player has moved on. Shorts pages
      // mount the live player as #shorts-player (see getLivePlayer).
      let ypr: any = null;
      try {
        ypr = getLivePlayer()?.getPlayerResponse?.() || null;
      } catch {
        ypr = null;
      }
      if (!ypr || !ypr.captions) {
        ypr = (window as any).ytInitialPlayerResponse;
      }
      if (!ypr) {
        log("No ytInitialPlayerResponse found");
        return;
      }

      const currentVid = getCurrentVideoId();
      const responseVid = ypr.videoId || null;
      if (currentVid && responseVid && responseVid !== currentVid) {
        log("Skipping stale player response for", responseVid, "(playing:", currentVid + ")");
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
        .filter((s: any) => s.url)
        // Belt and braces: a response can list tracks of a dead video on
        // mixed sources; never forward a track stamped with another video.
        .filter((s: any) => {
          try {
            const stamp = new URL(s.url).searchParams.get("v");
            return !stamp || !currentVid || stamp === currentVid;
          } catch {
            return true;
          }
        });

      // Stamp each track URL with the video Id it belongs to; the content
      // script drops late arrivals whose stamp no longer matches the player.
      if (currentVid) {
        for (const s of subtitles) {
          if (!s.url) continue;
          try {
            const u = new URL(s.url);
            if (!u.searchParams.get("v")) {
              u.searchParams.set("v", currentVid);
              s.url = u.toString();
            }
          } catch {
            // Keep original URL if parsing fails
          }
        }
      }

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

    // In-player transitions (playlist autoplay) may bypass the wrapped
    // pushState/replaceState when YouTube's own code captured the originals
    // before this script ran — watch yt-navigate and poll the URL so the
    // swap is still noticed. yt-navigate-start also drops cached timedtext
    // so a just-finished fetch of the old video cannot be served from cache.
    document.addEventListener(
      "yt-navigate-start",
      () => {
        sentSubtitleUrls.clear();
        capturedTimedtext.clear();
      },
      true,
    );
    document.addEventListener("yt-navigate-finish", checkForNavigation, true);
    setInterval(checkForNavigation, 2000);
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
    const ccButton = document.querySelector(".ytp-subtitles-button") as HTMLButtonElement | null;
    const buttonUsable =
      !!ccButton &&
      getComputedStyle(ccButton).display !== "none" &&
      ccButton.getClientRects().length > 0;

    if (buttonUsable && ccButton) {
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
      return;
    }

    // Shorts keeps the CC button display:none — aria-pressed stays false and
    // a click on it does nothing, so drive the player's captions module
    // directly to make the player fetch timedtext for our interception.
    if ((window as any).__ffprofanity_caption_triggered) {
      log("Already tried enabling captions");
      return;
    }
    const player = getLivePlayer();
    // #movie_player is a stub until Shorts mounts the real player; one
    // attempt must not be wasted toggling it, so retry until the API is wired.
    if (!player?.getVideoData?.()?.video_id) {
      const attempts = (window as any).__ffprofanity_caption_attempts || 0;
      if (attempts >= 20) return;
      (window as any).__ffprofanity_caption_attempts = attempts + 1;
      log("Player API not ready for caption toggle, retrying");
      setTimeout(tryEnableCaptions, 1000);
      return;
    }
    (window as any).__ffprofanity_caption_triggered = true;

    log("CC button hidden or absent — enabling captions via player API");
    try {
      player.loadModule("captions");
      player.toggleSubtitles();
    } catch (e) {
      log("Player API caption toggle failed:", e);
    }
    setTimeout(() => extractFromInitialPlayerResponse(), 1000);
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