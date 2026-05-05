/**
 * fmovies Page Script - Injected into MAIN world to bypass CSP
 *
 * This script handles:
 * 1. Fetch/XHR interception to capture subtitle URLs from sub.wyzie.io
 * 2. Video textTrack monitoring for loaded subtitles
 * 3. Auto-selection of English CC track when subtitle modal opens
 * 4. Hiding native subtitles to prevent double display
 */

import {
  extractLanguageFromUrl,
  formatVTTTime,
} from "../lib/page-script-helpers";
import {
  createSendSubtitles,
  createSendSubtitleContent,
  createLog,
  interceptXHR,
  interceptFetch,
  type SubtitleTrack,
} from "../lib/network-interception";
import { disableVideoJSTextTracks } from "../lib/videojs-helpers";

const log = createLog();
const sendSubtitles = createSendSubtitles("fmovies");
const sendSubtitleContent = createSendSubtitleContent("fmovies");
let ccAutoClicked = false;

function interceptFetchSubtitles(): void {
  // fmovies uses a custom fetch intercept for sub.wyzie.io URLs specifically
  const originalFetch = window.fetch;

  (window as any).fetch = async function (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url =
      typeof input === "string" ? input : (input as Request)?.url || "";

    try {
      const response = await originalFetch.call(this, input, init);

      // Check for sub.wyzie.io subtitle URLs
      const isSubtitleUrl =
        url.includes("sub.wyzie.io/c/") &&
        (url.includes("format=srt") || url.includes("format=vtt"));

      if (isSubtitleUrl) {
        try {
          const clone = response.clone();
          const text = await clone.text();

          if (text.includes("-->")) {
            const language = extractLanguageFromUrl(url) || "en";
            log(`Captured subtitle from fetch: ${url.substring(0, 100)}`);
            sendSubtitleContent(text, language, "Wyzie");
          }
        } catch (e) {
          log("Error reading subtitle fetch response:", e);
        }
      }

      return response;
    } catch (e) {
      throw e;
    }
  };

  log("Fetch interceptor installed");
}

function interceptXHRSubtitles(): void {
  // fmovies uses a custom XHR intercept for sub.wyzie.io and .vtt/.srt URLs specifically
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string,
  ): XMLHttpRequest {
    (this as any)._ffprofanity_url = url;
    return nativeOpen.apply(this, arguments as any) as XMLHttpRequest;
  };

  XMLHttpRequest.prototype.send = function (): void {
    const url = (this as any)._ffprofanity_url || "";
    const xhr = this;

    if (url.includes("sub.wyzie.io") || url.includes(".vtt") || url.includes(".srt")) {
      xhr.addEventListener("load", function () {
        try {
          const responseText = xhr.responseText;
          if (responseText && responseText.includes("-->")) {
            const language = extractLanguageFromUrl(url) || "en";
            log(`Captured subtitle from XHR: ${url.substring(0, 100)}`);
            sendSubtitleContent(responseText, language, "XHR");
          }
        } catch (e) {
          log("Error reading XHR response:", e);
        }
      });
    }

    return nativeSend.apply(this, arguments as any) as void;
  };

  log("XHR interceptor installed");
}

function monitorVideoTextTracks(): void {
  let lastCueCount = 0;

  const checkTextTracks = () => {
    try {
      const videos = document.querySelectorAll("video");
      for (const video of videos) {
        if (video.textTracks && video.textTracks.length > 0) {
          for (let i = 0; i < video.textTracks.length; i++) {
            const track = video.textTracks[i];
            if (
              (track.kind === "subtitles" || track.kind === "captions") &&
              track.cues &&
              track.cues.length > 0
            ) {
              const cues = Array.from(track.cues);
              const trackKey = track.label || track.language || String(i);

              if (cues.length > 0 && cues.length !== lastCueCount) {
                lastCueCount = cues.length;

                // Reconstruct VTT from cues
                let vttContent = "WEBVTT\n\n";
                cues.forEach((cue, idx) => {
                  const vttcue = cue as VTTCue;
                  const start = formatVTTTime(vttcue.startTime);
                  const end = formatVTTTime(vttcue.endTime);
                  vttContent += idx + 1 + "\n";
                  vttContent += start + " --> " + end + "\n";
                  vttContent += vttcue.text + "\n\n";
                });

                log(`Captured ${cues.length} cues from textTrack: ${track.label || track.language}`);
                sendSubtitleContent(vttContent, track.language || "en", track.label || "Video Track");
              }
            }
          }
        }
      }
    } catch (e) {
      log("Error checking textTracks:", e);
    }
  };

  // Check periodically with exponential backoff
  let interval = 1000;
  const check = () => {
    checkTextTracks();
    if (interval < 5000) {
      interval = Math.min(interval * 1.5, 5000);
    }
    setTimeout(check, interval);
  };
  setTimeout(check, 500);

  log("TextTrack monitor installed");
}

function setupAutoCCSelection(): void {
  const findAndClickEnglishCC = () => {
    if (ccAutoClicked) return false;

    const ccBadges = document.querySelectorAll('div[style*="rgba(97, 218, 251"]');
    for (const badge of ccBadges) {
      if (badge.textContent?.trim() !== "CC") continue;

      let container = badge.parentElement;
      for (let i = 0; i < 5 && container; i++) {
        container = container?.parentElement || null;
      }
      if (!container) continue;

      const englishText = container.querySelector('.text-sm.font-medium.text-white');
      if (englishText?.textContent?.toLowerCase().includes("english")) {
        log("Found English with CC badge, clicking...");
        const clickable =
          container.closest("button") ||
          container.closest('[role="button"]') ||
          container.closest("div.cursor-pointer") ||
          container;
        if (clickable instanceof HTMLElement) {
          clickable.click();
          ccAutoClicked = true;
          log("Clicked English CC subtitle");
          return true;
        }
      }
    }

    // Alternative: Look for language items with "en" code
    const langItems = document.querySelectorAll('.text-\\[11px\\].text-white\\/50');
    for (const item of langItems) {
      if (item.textContent?.trim().toLowerCase() === "en") {
        const parent = item.closest(".flex.items-center");
        if (parent) {
          const nextSibling = parent?.nextElementSibling;
          if (nextSibling?.textContent?.includes("CC")) {
            log("Found English (en) with CC badge");
            const clickable =
              parent.closest("button") ||
              parent.closest('[role="button"]') ||
              parent.closest("div.cursor-pointer") ||
              parent;
            if (clickable instanceof HTMLElement) {
              clickable.click();
              ccAutoClicked = true;
              log("Clicked English CC subtitle");
              return true;
            }
          }
        }
      }
    }

    return false;
  };

  const modalObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLElement) {
          if (
            node.classList.contains("modal") ||
            node.classList.contains("dropdown") ||
            node.querySelector('[class*="subtitle"]') ||
            node.querySelector('[class*="language"]')
          ) {
            setTimeout(() => findAndClickEnglishCC(), 100);
            return;
          }
        }
      }
    }
  });

  modalObserver.observe(document.body, { childList: true, subtree: true });

  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (
      target.closest('[class*="subtitle"]') ||
      target.closest('[class*="language"]') ||
      target.closest('[aria-label*="subtitle"]') ||
      target.closest('[aria-label*="language"]')
    ) {
      setTimeout(() => findAndClickEnglishCC(), 100);
      setTimeout(() => findAndClickEnglishCC(), 500);
      setTimeout(() => findAndClickEnglishCC(), 1000);
    }
  }, true);

  setInterval(() => {
    if (!ccAutoClicked) {
      const visibleModal = document.querySelector(
        '.modal[style*="display: block"], .dropdown:not(.hidden), [class*="subtitle-selector"]:not(.hidden)',
      );
      if (visibleModal) {
        findAndClickEnglishCC();
      }
    }
  }, 2000);

  log("Auto CC selection installed");
}

function hideNativeSubtitles(): void {
  const disableVideoTextTracks = () => {
    const videos = document.querySelectorAll("video");
    for (const video of videos) {
      if (video.textTracks) {
        for (let i = 0; i < video.textTracks.length; i++) {
          const track = video.textTracks[i];
          if (
            (track.kind === "subtitles" || track.kind === "captions") &&
            track.mode !== "disabled"
          ) {
            log(`Disabling textTrack: ${track.label || track.language || i}`);
            track.mode = "disabled";
          }
        }
      }
    }
  };

  const injectHideCSS = () => {
    const styleId = "ffprofanity-hide-native-subtitles";
    if (document.getElementById(styleId)) return;

    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      .vjs-text-track-display { visibility: hidden !important; opacity: 0 !important; }
      .vjs-text-track-cue { visibility: hidden !important; opacity: 0 !important; }
      .video-js .vjs-text-track-display { visibility: hidden !important; opacity: 0 !important; }
      .vjs-text-track-display div { visibility: hidden !important; opacity: 0 !important; }
      div[class*="cue"] { visibility: hidden !important; opacity: 0 !important; }
      [class*="subtitle-display"] { visibility: hidden !important; }
      [class*="captions-display"] { visibility: hidden !important; }
    `;
    document.head.appendChild(style);
    log("Injected CSS to hide native subtitles");
  };

  window.addEventListener("message", (event) => {
    if (
      event.source === window &&
      event.data?.type === "FFPROFANITY_HIDE_NATIVE_SUBTITLES"
    ) {
      log("Received HIDE_NATIVE_SUBTITLES message");
      disableVideoTextTracks();
      disableVideoJSTextTracks();
      injectHideCSS();
    }
  });

  const runHide = () => {
    disableVideoTextTracks();
    disableVideoJSTextTracks();
  };

  setTimeout(runHide, 1000);
  setTimeout(runHide, 3000);
  setTimeout(runHide, 5000);
  setTimeout(injectHideCSS, 1000);
  setInterval(runHide, 10000);

  const videoObserver = new MutationObserver(() => {
    const videos = document.querySelectorAll("video");
    if (videos.length > 0) {
      runHide();
    }
  });
  videoObserver.observe(document.body, { childList: true, subtree: true });

  log("Native subtitle hiding installed");
}

function init(): void {
  // Skip execution in iframes
  if (window.self !== window.top) return;

  log("Page script initializing...");
  interceptFetchSubtitles();
  interceptXHRSubtitles();
  monitorVideoTextTracks();
  setupAutoCCSelection();
  hideNativeSubtitles();
  log("Page script ready");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}