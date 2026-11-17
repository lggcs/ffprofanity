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

  // Video Ids that produced a real relay (fetched content or captured
  // timedtext) — the capture watchdog stops probing once the current video's
  // Id is marked, and navigation clears the set.
  const relaySucceededVids = new Set<string>();

  function stampRelayVid(url: string): void {
    try {
      const vid = new URL(url).searchParams.get("v");
      if (vid) relaySucceededVids.add(vid);
    } catch {
      // Unparseable URL — nothing to stamp
    }
  }

  // The addon keeps YouTube captions on so the player's timedtext stream —
  // the capture source below — never stops. The only sanctioned off-switch
  // is the viewer clicking Disable in the addon popup; the content script
  // broadcasts that state (FFPROFANITY_CC_DISABLED) and answers our init
  // query for it.
  let ccDisabledByUser = false;

  function resetCaptionFlags(): void {
    const w = window as any;
    delete w.__ffprofanity_caption_triggered;
    delete w.__ffprofanity_caption_attempts;
    delete w.__ffprofanity_caption_retries;
    delete w.__ffprofanity_caption_inflight;
  }

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
    const data = e.data as { type?: string; disabled?: boolean } | null;
    if (!data?.type) return;
    if (data.type === "FFPROFANITY_RELAY_READY") {
      markRelayReady();
      return;
    }
    if (data.type === "FFPROFANITY_CC_DISABLED") {
      ccDisabledByUser = data.disabled === true;
      log(
        "Addon state from content script:",
        ccDisabledByUser ? "disabled — captions left to the viewer" : "enabled — captions stay on",
      );
      // Popup re-enable mid-session: re-arm captions right away instead of
      // waiting for the next navigation.
      if (!ccDisabledByUser) {
        resetCaptionFlags();
        setTimeout(tryEnableCaptions, 300);
      }
    }
  });

  // A READY posted before this script existed is gone; the DOM attribute
  // the content script sets is the listener-independent signal.
  const readyPoll = setInterval(markRelayReady, 100);
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
      if (videoId) relaySucceededVids.add(videoId);

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
      stampRelayVid(url);
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
        stampRelayVid(url);

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
        relaySucceededVids.clear();
        // The new video's player response can land seconds after the finished
        // navigation; the old two-shot schedule missed it, capture stayed
        // dark until a manual CC click. Replay the load-time schedule.
        for (const delay of [100, 500, 1000, 2000, 3000, 5000]) {
          setTimeout(extractFromInitialPlayerResponse, delay);
        }
        // Caption enabling is otherwise one-shot per page load: the triggered
        // flag latched forever, so from the second SPA video the script never
        // re-enabled CC and the timedtext stream died with it. Re-arm per
        // video; the addon rule is captions on unless the popup Disable.
        if (!ccDisabledByUser) {
          resetCaptionFlags();
          setTimeout(tryEnableCaptions, 100);
        }
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
        relaySucceededVids.clear();
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

  // The addon forces captions on — the player's timedtext stream is the
  // capture source — and only a popup Disable may leave them alone. Synthetic
  // clicks on the CC button were verified unanswered on-device (the button
  // stays inert until caption data mounts — aria-pressed never flips), so the
  // player's captions module is toggled directly, and every attempt is
  // verified against the button state and retried a bounded number of times.
  const CAPTION_RETRY_DELAYS_MS = [600, 1200, 2400, 4800, 8000, 10000];

  function captionsReportOn(): boolean {
    return (
      document
        .querySelector(".ytp-subtitles-button")
        ?.getAttribute("aria-pressed") === "true"
    );
  }

  function armCaptionsSuccess(): void {
    const w = window as any;
    w.__ffprofanity_caption_triggered = true;
    delete w.__ffprofanity_caption_inflight;
    setTimeout(() => extractFromInitialPlayerResponse(), 100);
  }

  function verifyCaptionsEnabled(stage: string): void {
    const w = window as any;
    if (ccDisabledByUser) {
      delete w.__ffprofanity_caption_inflight;
      return;
    }
    if (captionsReportOn()) {
      log(`Captions verified on (${stage}) — arming capture`);
      armCaptionsSuccess();
      return;
    }
    delete w.__ffprofanity_caption_inflight;
    const retries = w.__ffprofanity_caption_retries || 0;
    if (retries >= CAPTION_RETRY_DELAYS_MS.length) {
      log("Caption enable retries exhausted — leaving captions as they are");
      return;
    }
    const delay = CAPTION_RETRY_DELAYS_MS[retries];
    w.__ffprofanity_caption_retries = retries + 1;
    log(`Captions still off after ${stage} — retrying in ${delay ?? 3000}ms`);
    setTimeout(() => tryEnableCaptions(), delay ?? 3000);
  }

  function tryEnableCaptions(): void {
    if (ccDisabledByUser) {
      log("Addon disabled from popup — leaving captions untouched");
      return;
    }
    if (captionsReportOn()) {
      if (!(window as any).__ffprofanity_caption_triggered) {
        log("Captions already on — arming capture");
        armCaptionsSuccess();
      }
      return;
    }
    // Retries already gave up for this video — navigation re-arms them.
    if ((window as any).__ffprofanity_caption_retries >= CAPTION_RETRY_DELAYS_MS.length) {
      return;
    }
    // One attempt at a time: the load timers, the MutationObserver, the
    // post-navigation re-arm and the popup-enable broadcast all funnel here.
    if ((window as any).__ffprofanity_caption_inflight) return;
    (window as any).__ffprofanity_caption_inflight = true;

    const player = getLivePlayer();
    // #movie_player is a stub until the real player mounts; one attempt must
    // not be wasted toggling it, so retry until the API is wired. 250ms
    // cadence, 60 attempts ≈ 15s of readiness window.
    if (!player?.getVideoData?.()?.video_id) {
      const attempts = (window as any).__ffprofanity_caption_attempts || 0;
      if (attempts >= 60) {
        verifyCaptionsEnabled("player readiness");
        return;
      }
      (window as any).__ffprofanity_caption_attempts = attempts + 1;
      log("Player API not ready for caption toggle, retrying");
      delete (window as any).__ffprofanity_caption_inflight;
      setTimeout(tryEnableCaptions, 250);
      return;
    }

    // The button attribute still reports the captions state; a blind toggle
    // would switch captions OFF when they were already on.
    const pressed = document
      .querySelector(".ytp-subtitles-button")
      ?.getAttribute("aria-pressed");
    if (pressed === "true") {
      log("Captions already enabled — timedtext should be loading");
      verifyCaptionsEnabled("player API check");
      return;
    }

    log("Enabling captions via player API");
    try {
      player.loadModule("captions");
      player.toggleSubtitles();
    } catch (e) {
      log("Player API caption toggle failed:", e);
    }
    verifyCaptionsEnabled("player API pass");
  }

  function init(): void {
    log("YouTube extractor initialized via MAIN world injection");

    // Ask for the popup disable state in case this script attached after the
    // content script broadcast it (either one covers the load-order race).
    window.postMessage({ type: "FFPROFANITY_CC_STATE_QUERY" }, "*");

    if (document.readyState === "complete" || document.readyState === "interactive") {
      extractFromInitialPlayerResponse();
      setTimeout(tryEnableCaptions, 0);
    } else {
      document.addEventListener("DOMContentLoaded", () => {
        extractFromInitialPlayerResponse();
        setTimeout(tryEnableCaptions, 0);
      });
    }

    setupNavigationWatcher();
    setupResponseWatcher();
    setupCaptionButtonListener();

    // A playlist transition can mount the new player response after the
    // finite 100→5000ms extraction replay has run, leaving no cues until a
    // page refresh. Probe every 2s while the current video has produced
    // neither fetched content nor captured timedtext; extraction is deduped
    // (sentSubtitleUrls) and stale-response guarded, so a capture for the
    // current video marks it in relaySucceededVids and the probing stops.
    setInterval(() => {
      const currentVid = getCurrentVideoId();
      if (!currentVid || relaySucceededVids.has(currentVid)) return;
      extractFromInitialPlayerResponse();
    }, 2000);

    const videoObserver = new MutationObserver(() => {
      const video = document.querySelector("video");
      const ccButton = document.querySelector(".ytp-subtitles-button");
      if (video && ccButton && !(window as any).__ffprofanity_caption_triggered) {
        setTimeout(tryEnableCaptions, 0);
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