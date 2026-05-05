/**
 * Cinebto / 111movies Page Script - Injected into MAIN world to bypass CORS
 *
 * This script handles subtitle detection on cinebto.com and 111movies domains
 * which use the FastStreamClient/FluidPlayer video player architecture.
 *
 * ARCHITECTURE:
 * - cinebto.com embeds an iframe to 111movies.net (or similar) which contains the player
 * - 111movies uses Next.js with FastStreamClient (built on FluidPlayer)
 * - Subtitles are managed by SubtitlesManager, not <track> elements
 * - Subtitle files (.vtt) are served from CDNs like cca.megafiles.store
 * - The video element is dynamically created inside div.video-container
 *
 * Unlike fmovies, this script MUST run in iframes because the video is in
 * a nested iframe (111movies.net), not the top frame.
 */

import {
  extractLanguageFromUrl,
  getLanguageName,
  findSubtitlesRecursive,
  formatVTTTime,
  isValidSubtitleUrl,
} from "../lib/page-script-helpers";
import {
  createSendSubtitles,
  createSendSubtitleContent,
  createLog,
  interceptFetch,
  interceptXHR,
  type SubtitleTrack,
} from "../lib/network-interception";

const log = createLog();
const sendSubtitles = createSendSubtitles("cinebto");
const sendSubtitleContent = createSendSubtitleContent("cinebto");

// Cinebto-specific: exclude .mjs URLs (SubtitlesManager modules)
const MJS_FILTER = /\.mjs(\?|$)/i;

// ========================================
// Strategy 1: Intercept fetch requests
// ========================================
function setupFetchInterception(): void {
  interceptFetch(sendSubtitles, {
    subtitleSource: "fetch-subtitle",
    hlsSource: "fetch-hls",
    checkHLS: false,
    urlFilter: (url) => !MJS_FILTER.test(url),
    onContent: (content, language, label, url) => {
      if (content.includes("-->")) {
        log(`Captured subtitle content from fetch: ${content.length} bytes`);
        sendSubtitleContent(content, language, label, url);
      }
    },
  });

  // Also intercept JSON responses containing subtitle data
  const originalFetch = window.fetch;
  (window as any).fetch = async function (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url =
      typeof input === "string" ? input : (input as Request)?.url || "";

    const response = await (originalFetch as any).apply(this, [input, init]);

    if (
      url.includes("subtitle") ||
      url.includes("sub") ||
      url.includes("caption") ||
      url.includes("tracks")
    ) {
      try {
        const clone = response.clone();
        clone
          .json()
          .then((data: unknown) => {
            const found = findSubtitlesRecursive(data, [MJS_FILTER]);
            if (found.length > 0) {
              sendSubtitles(found, "fetch-json");
            }
          })
          .catch(() => { /* Not valid JSON */ });
      } catch { /* Clone failed */ }
    }

    return response;
  };
}

// ========================================
// Strategy 2: Intercept XHR requests
// ========================================
function setupXHRInterception(): void {
  interceptXHR(sendSubtitles, {
    subtitleSource: "xhr-subtitle",
    checkHLS: false,
    urlFilter: (url) => !MJS_FILTER.test(url),
    onContent: (content, language, label, url) => {
      if (content.includes("-->")) {
        log(`Captured subtitle content from XHR: ${content.length} bytes`);
        sendSubtitleContent(content, language, label, url);
      }
    },
  });
}

// ========================================
// Strategy 3: FastStreamClient SubtitlesManager
// ========================================
function extractFromFastStreamClient(): SubtitleTrack[] {
  const subs: SubtitleTrack[] = [];

  try {
    const win = window as any;
    const fsc = win.FastStreamClient || win.fastStreamClient;
    if (fsc) {
      log("FastStreamClient found");

      // Try SubtitlesManager
      const sm = fsc.subtitlesManager || fsc.SubtitlesManager;
      if (sm && typeof sm.getTracks === "function") {
        const tracks = sm.getTracks();
        for (const track of tracks) {
          const url = track.url || track.src || track.file;
          if (url && !MJS_FILTER.test(url)) {
            subs.push({
              url,
              language: track.language || track.lang || track.code || "unknown",
              label: track.label || track.name || "Unknown",
            });
          }
        }
      }

      // Try player.subtitles
      if (fsc.player) {
        const player = fsc.player;
        if (player.subtitles && typeof player.subtitles.getTracks === "function") {
          const tracks = player.subtitles.getTracks();
          for (const track of tracks) {
            const url = track.url || track.src || track.file;
            if (url && !MJS_FILTER.test(url)) {
              subs.push({ url, language: track.language || "unknown", label: track.label || "Unknown" });
            }
          }
        }
      }
    }
  } catch (e) {
    log("FastStreamClient extraction error:", e);
  }

  return subs;
}

// ========================================
// Strategy 4: FluidPlayer detection
// ========================================
function extractFromFluidPlayer(): SubtitleTrack[] {
  const subs: SubtitleTrack[] = [];

  try {
    const win = window as any;
    if (
      win.fluidPlayerInstances &&
      Array.isArray(win.fluidPlayerInstances)
    ) {
      for (const instance of win.fluidPlayerInstances) {
        if (instance && instance.options && instance.options.subtitles) {
          for (const sub of instance.options.subtitles) {
            if (sub.url && !MJS_FILTER.test(sub.url)) {
              subs.push({
                url: sub.url,
                language: sub.language || "unknown",
                label: sub.label || "Unknown",
              });
            }
          }
        }
      }
    }

    // Check DOM for fluid player wrappers
    const wrappers = document.querySelectorAll(
      ".fluid_video_wrapper, .mainplayer",
    );
    for (const wrapper of wrappers) {
      const video = wrapper.querySelector("video");
      if (video) {
        const fpConfig = (video as any).dataset?.fluidPlayerConfig;
        if (fpConfig) {
          try {
            const config = JSON.parse(fpConfig);
            if (config.subtitles) {
              for (const sub of config.subtitles) {
                if (sub.url && !MJS_FILTER.test(sub.url)) {
                  subs.push({
                    url: sub.url,
                    language: sub.language || "unknown",
                    label: sub.label || "Unknown",
                  });
                }
              }
            }
          } catch { /* Not valid JSON */ }
        }
      }
    }
  } catch (e) {
    log("FluidPlayer extraction error:", e);
  }

  return subs;
}

// ========================================
// Strategy 5: __NEXT_DATA__ subtitle extraction
// ========================================
function extractFromNextData(): SubtitleTrack[] {
  try {
    const nextDataEl = document.getElementById("__NEXT_DATA__");
    if (nextDataEl) {
      const data = JSON.parse(nextDataEl.textContent || "{}");
      return findSubtitlesRecursive(data, [MJS_FILTER]);
    }
  } catch { /* Not a Next.js page or no subtitle data */ }
  return [];
}

// ========================================
// Strategy 6: Video textTrack monitoring
// ========================================
function monitorVideoTextTracks(): void {
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
              const trackKey = `${track.label || track.language}_${track.cues.length}`;

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

              sendSubtitleContent(
                vttContent,
                track.language || "en",
                track.label || "Video Track",
              );
            }
          }
        }
      }
    } catch (e) {
      log("Error checking textTracks:", e);
    }
  };

  checkTextTracks();
  setInterval(checkTextTracks, 5000);
}

// ========================================
// Initialize all strategies
// ========================================
function init() {
  log(`Cinebto page script initializing on: ${window.location.hostname}`);

  // Install network interceptors first
  setupFetchInterception();
  setupXHRInterception();

  // Check existing state
  const subs = [
    ...extractFromFastStreamClient(),
    ...extractFromFluidPlayer(),
    ...extractFromNextData(),
  ];
  if (subs.length > 0) {
    sendSubtitles(subs, "init");
  }

  // Monitor video textTracks
  monitorVideoTextTracks();

  // Watch for dynamically added video elements
  const videoObserver = new MutationObserver((mutations) => {
    let foundNew = false;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLVideoElement) {
          foundNew = true;
        } else if (node instanceof HTMLElement) {
          if (node.querySelector("video")) {
            foundNew = true;
          }
        }
      }
    }
    if (foundNew) {
      const newSubs = [
        ...extractFromFastStreamClient(),
        ...extractFromFluidPlayer(),
      ];
      if (newSubs.length > 0) {
        sendSubtitles(newSubs, "video-added");
      }
    }
  });
  videoObserver.observe(document.body, { childList: true, subtree: true });

  // Periodically check for FastStreamClient (may load after page)
  let checks = 0;
  const checkInterval = setInterval(() => {
    checks++;
    const fscSubs = extractFromFastStreamClient();
    if (fscSubs.length > 0) {
      sendSubtitles(fscSubs, "faststream-poll");
    }
    if (checks >= 20) {
      clearInterval(checkInterval);
    }
  }, 500);

  log("Cinebto page script initialized");
}

// Run when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}