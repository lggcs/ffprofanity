/**
 * 2embed Page Script - Injected into MAIN world for Video.js players
 *
 * This handles subtitle detection on 2embed streaming server iframes
 * which use Video.js (not FastStreamClient). Used when cinebto.com
 * loads content via the 2embed server option.
 *
 * STRATEGIES:
 * 1. Video.js player detection (remoteTextTrackEls, textTracks)
 * 2. XHR/fetch interception for .vtt/.srt/.ass URLs and HLS manifests
 * 3. <track> element detection within video elements
 * 4. Video textTrack monitoring
 * 5. MutationObserver for late-loading video elements
 */

import {
  extractLanguageFromUrl,
  getLanguageName,
  findSubtitlesRecursive,
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
import { parseHLSManifest } from "../lib/hls-parser";
import {
  extractFromVideoJS,
  extractFromVideoTrackElements,
  disableVideoJSTextTracks,
} from "../lib/videojs-helpers";

const log = createLog();
const sendSubtitles = createSendSubtitles("2embed");
const sendSubtitleContent = createSendSubtitleContent("2embed");

// ========================================
// Strategy 1: Video.js player detection
// ========================================
function checkVideoJS(): void {
  const subs = extractFromVideoJS();
  if (subs.length > 0) {
    log(`Found ${subs.length} tracks from Video.js`);
    sendSubtitles(subs, "videojs");
  }
}

// ========================================
// Strategy 2: Network interception
// ========================================
function setupNetworkInterception(): void {
  interceptXHR(sendSubtitles, {
    subtitleSource: "xhr-subtitle",
    hlsSource: "xhr-hls",
    checkHLS: true,
    checkSubtitles: true,
    parseHLSManifest,
    onContent: (content, language, label, url) => {
      if (content.includes("-->")) {
        sendSubtitleContent(content, language, label, url);
      }
    },
  });

  interceptFetch(sendSubtitles, {
    subtitleSource: "fetch-subtitle",
    hlsSource: "fetch-hls",
    checkHLS: true,
    checkSubtitles: true,
    parseHLSManifest,
    onContent: (content, language, label, url) => {
      if (content.includes("-->")) {
        sendSubtitleContent(content, language, label, url);
      }
    },
  });
}

// ========================================
// Strategy 3: <track> element detection
// ========================================
function checkVideoTrackElements(): void {
  const subs = extractFromVideoTrackElements();
  if (subs.length > 0) {
    log(`Found ${subs.length} <track> elements`);
    sendSubtitles(subs, "track-elements");
  }
}

// ========================================
// Strategy 4: Video textTrack monitoring
// ========================================
function monitorVideoTextTracks(): void {
  const seenTrackKeys = new Set<string>();

  const check = () => {
    try {
      const videos = document.querySelectorAll("video");
      for (const video of videos) {
        if (!video.textTracks || video.textTracks.length === 0) continue;

        for (let i = 0; i < video.textTracks.length; i++) {
          const track = video.textTracks[i];
          if (
            (track.kind === "subtitles" || track.kind === "captions") &&
            track.cues &&
            track.cues.length > 0
          ) {
            const trackKey = `${track.label || track.language}_${track.cues.length}`;
            if (seenTrackKeys.has(trackKey)) continue;
            seenTrackKeys.add(trackKey);

            // Reconstruct VTT from cues
            let vttContent = "WEBVTT\n\n";
            Array.from(track.cues).forEach((cue, idx) => {
              const vttcue = cue as VTTCue;
              const start = formatVTTTime(vttcue.startTime);
              const end = formatVTTTime(vttcue.endTime);
              vttContent += idx + 1 + "\n";
              vttContent += start + " --> " + end + "\n";
              vttContent += vttcue.text + "\n\n";
            });

            log(`Captured ${track.cues.length} cues from textTrack: ${track.label || track.language}`);
            sendSubtitleContent(vttContent, track.language || "en", track.label || "Video Track");
          }
        }
      }
    } catch (e) {
      log("Error checking textTracks:", e);
    }
  };

  check();
  setInterval(check, 3000);
}

// ========================================
// Strategy 5: Watch for video elements added to DOM
// ========================================
function watchForVideoElement(): void {
  const observer = new MutationObserver((mutations) => {
    let foundVideo = false;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLVideoElement) {
          foundVideo = true;
        } else if (node instanceof HTMLElement && node.querySelector("video")) {
          foundVideo = true;
        }
      }
      if (foundVideo) break;
    }

    if (foundVideo) {
      log("Video element detected in DOM");
      setTimeout(checkVideoJS, 200);
      setTimeout(checkVideoTrackElements, 200);
      setTimeout(monitorVideoTextTracks, 500);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

// ========================================
// Strategy 6: Poll for Video.js player
// ========================================
function pollForVideoJS(): void {
  let checks = 0;
  const interval = setInterval(() => {
    checks++;
    if (typeof (window as any).videojs !== "undefined") {
      log("Video.js detected via polling");
      clearInterval(interval);
      setTimeout(checkVideoJS, 100);
      setTimeout(checkVideoJS, 2000);
    } else if (checks >= 60) {
      clearInterval(interval);
    }
  }, 500);
}

// ========================================
// Hide native subtitles (Video.js specific)
// ========================================
function hideNativeSubtitles(): void {
  const injectHideCSS = () => {
    const styleId = "ffprofanity-2embed-hide";
    if (document.getElementById(styleId)) return;

    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      .vjs-text-track-display { visibility: hidden !important; opacity: 0 !important; }
      .vjs-text-track-cue { visibility: hidden !important; opacity: 0 !important; }
      .video-js .vjs-text-track-display { visibility: hidden !important; opacity: 0 !important; }
      .vjs-text-track-display div { visibility: hidden !important; opacity: 0 !important; }
    `;
    document.head.appendChild(style);
    log("Injected CSS to hide Video.js native subtitles");
  };

  window.addEventListener("message", (event) => {
    if (
      event.source === window &&
      event.data?.type === "FFPROFANITY_HIDE_NATIVE_SUBTITLES"
    ) {
      log("Received HIDE_NATIVE_SUBTITLES message");
      injectHideCSS();
      disableVideoJSTextTracks();
    }
  });

  setTimeout(injectHideCSS, 2000);
  setInterval(disableVideoJSTextTracks, 10000);
}

// ========================================
// Initialize
// ========================================
function init(): void {
  log(`2embed page script initializing on: ${window.location.hostname}`);

  // Note: 2embed runs inside iframes, so we do NOT skip iframes
  setupNetworkInterception();
  checkVideoJS();
  checkVideoTrackElements();
  monitorVideoTextTracks();
  watchForVideoElement();
  pollForVideoJS();
  hideNativeSubtitles();

  log("2embed page script initialized");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}