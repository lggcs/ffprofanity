/**
 * Fandango At Home (Vudu) Page Script - Injected into MAIN world
 *
 * Handles subtitle detection on athome.fandango.com (formerly Vudu).
 *
 * ARCHITECTURE:
 * - Fandango At Home uses Shaka Player (asteroid.all.*.js) inside an iframe
 *   (`#contentPlayerFrame` / `iframe[id="contentPlayerFrame"]`).
 * - The player iframe contains `<video id="videoPlayer">` with
 *   `data-contentid` attribute and a `<track>` element pointing to a VTT
 *   subtitle URL on cc.vudu.com.
 * - IMPORTANT: The `<track>` uses `kind="metadata"` (not "subtitles" or
 *   "captions"), so the browser's native textTrack API won't surface it as
 *   a caption track. The Shaka player reads it programmatically.
 * - VTT URL pattern: `https://cc.vudu.com/{prefix}/{contentId}/movie/subtitle.{num}.{lang}.vtt`
 * - Fandango renders its own subtitles in `#subtitleContainer` within the
 *   player iframe, not via native <track> rendering.
 * - DRM (Widevine) is used for video; subtitle VTT files are not encrypted.
 *
 * DETECTION STRATEGIES:
 * 1. <track kind="metadata"> element detection (Fandango-specific)
 * 2. Shaka player textTracks API
 * 3. XHR/fetch interception for .vtt URLs (especially cc.vudu.com)
 * 4. contentid-based VTT URL construction
 * 5. Video textTrack monitoring (after enabling metadata tracks)
 * 6. MutationObserver for late-loading elements
 */

import {
  extractLanguageFromUrl,
  getLanguageName,
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

const log = createLog();
const sendSubtitles = createSendSubtitles("fandango");
const sendSubtitleContent = createSendSubtitleContent("fandango");

// Track which URLs we've already sent to avoid duplicates
const sentUrls = new Set<string>();

function uniqueSendSubtitles(subs: SubtitleTrack[], source: string): void {
  const unique = subs.filter((s) => {
    if (sentUrls.has(s.url)) return false;
    sentUrls.add(s.url);
    return true;
  });
  if (unique.length > 0) {
    sendSubtitles(unique, source);
  }
}

// ========================================
// Strategy 1: <track kind="metadata"> detection
// ========================================
// Fandango uses kind="metadata" instead of kind="subtitles"/"captions"
function extractMetadataTracks(): SubtitleTrack[] {
  const subs: SubtitleTrack[] = [];
  const videos = document.querySelectorAll("video");

  for (const video of videos) {
    // Look for ALL track elements, including kind="metadata"
    const trackElements = video.querySelectorAll("track");
    for (const track of trackElements) {
      const url = track.src;
      if (!url) continue;

      // Validate it looks like a subtitle file
      if (/\.(vtt|srt|ass|ssa)(\?|$)/i.test(url) || url.includes("cc.vudu.com")) {
        const lang = track.srclang || extractLanguageFromUrl(url) || "en";
        const label = track.label || getLanguageName(lang) || "Unknown";

        subs.push({ url, language: lang, label });
        log(`Found metadata <track>: ${url} [${lang}]`);
      }
    }

    // Also check for id="vudu" which is Fandango's convention
    const vuduTrack = video.querySelector('track#vudu');
    if (vuduTrack && vuduTrack.src && !sentUrls.has(vuduTrack.src)) {
      const url = vuduTrack.src;
      const lang = vuduTrack.srclang || extractLanguageFromUrl(url) || "en";
      const label = vuduTrack.label || getLanguageName(lang) || "Unknown";
      subs.push({ url, language: lang, label });
      log(`Found #vudu track: ${url} [${lang}]`);
    }
  }

  return subs;
}

// ========================================
// Strategy 2: Shaka Player textTracks
// ========================================
function extractFromShakaPlayer(): SubtitleTrack[] {
  const subs: SubtitleTrack[] = [];

  try {
    const win = window as any;

    // Shaka player may be on window.shaka or accessed via the video element
    // Check common Shaka player globals
    const shakaPlayer = win.shaka?.Player;
    if (shakaPlayer) {
      log("Shaka Player library found on window.shaka");
    }

    // Look for Shaka player instances attached to video elements
    const videos = document.querySelectorAll("video");
    for (const video of videos) {
      // Shaka stores the player reference on the video element
      const shakaRef = (video as any).shakaPlayer ||
        (video as any)._shakaPlayer;

      if (shakaRef && typeof shakaRef.getTextTracks === "function") {
        try {
          const tracks = shakaRef.getTextTracks();
          for (const track of tracks) {
            if (track.language && track.uri) {
              subs.push({
                url: track.uri,
                language: track.language,
                label: track.label || getLanguageName(track.language),
              });
            }
          }
          if (subs.length > 0) {
            log(`Found ${subs.length} tracks from Shaka player.getTextTracks()`);
          }
        } catch (e) {
          log("Error calling getTextTracks:", e);
        }
      }

      // Also check shaka.media or player from the Shaka namespace
      // Some versions store the player differently
      if (win.shakaInstance) {
        const inst = win.shakaInstance;
        if (typeof inst.getTextTracks === "function") {
          const tracks = inst.getTextTracks();
          for (const track of tracks) {
            if (track.language && (track.uri || track.url)) {
              subs.push({
                url: track.uri || track.url,
                language: track.language,
                label: track.label || getLanguageName(track.language),
              });
            }
          }
        }
      }
    }

    // Try to find the player via the Fandango/Vudu player framework (asteroid)
    // The asteroid script creates a player instance that wraps Shaka
    if (subs.length === 0 && win.VuduPlayer) {
      try {
        const player = win.VuduPlayer;
        if (player && typeof player.getSubtitleTracks === "function") {
          const tracks = player.getSubtitleTracks();
          for (const track of tracks) {
            if (track.url || track.uri || track.src) {
              subs.push({
                url: track.url || track.uri || track.src,
                language: track.language || track.lang || "en",
                label: track.label || track.name || "Unknown",
              });
            }
          }
        }
      } catch (e) {
        log("VuduPlayer extraction error:", e);
      }
    }
  } catch (e) {
    log("Shaka extraction error:", e);
  }

  return subs;
}

// ========================================
// Strategy 3: Network interception (cc.vudu.com VTT)
// ========================================
function setupNetworkInterception(): void {
  interceptXHR(sendSubtitles, {
    subtitleSource: "xhr-subtitle",
    hlsSource: "xhr-hls",
    checkHLS: false,
    checkSubtitles: true,
    onContent: (content, language, label, url) => {
      if (content.includes("-->")) {
        log(`Captured subtitle content from XHR: ${content.length} bytes`);
        sendSubtitleContent(content, language, label, url);
      }
    },
  });

  interceptFetch(sendSubtitles, {
    subtitleSource: "fetch-subtitle",
    hlsSource: "fetch-hls",
    checkHLS: false,
    checkSubtitles: true,
    onContent: (content, language, label, url) => {
      if (content.includes("-->")) {
        log(`Captured subtitle content from fetch: ${content.length} bytes`);
        sendSubtitleContent(content, language, label, url);
      }
    },
  });

  // Also intercept cc.vudu.com requests specifically and fetch their content
  const origFetch = window.fetch;
  (window as any).fetch = async function (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === "string" ? input : (input as Request)?.url || "";

    const response = await (origFetch as any).apply(this, [input, init]);

    // Intercept cc.vudu.com VTT files
    if (url.includes("cc.vudu.com") && /\.vtt(\?|$)/i.test(url)) {
      log(`Intercepted cc.vudu.com VTT: ${url}`);
      try {
        const clone = response.clone();
        clone.text().then((text) => {
          if (text.includes("-->")) {
            const lang = extractLanguageFromUrl(url) || "en";
            const label = getLanguageName(lang);
            if (!sentUrls.has(url)) {
              sentUrls.add(url);
              sendSubtitles([{ url, language: lang, label }], "cc-vudu-intercept");
            }
            sendSubtitleContent(text, lang, label, url);
          }
        }).catch(() => { /* text() failed */ });
      } catch { /* clone failed */ }
    }

    return response;
  };
}

// ========================================
// Strategy 4: Construct VTT URLs from contentid
// ========================================
// If we know the content ID and the cc.vudu.com URL pattern, we can
// proactively fetch subtitle tracks.
function discoverVttFromContentId(): SubtitleTrack[] {
  const subs: SubtitleTrack[] = [];

  try {
    const video = document.querySelector('video[data-contentid]');
    if (!video) return subs;

    const contentId = (video as HTMLVideoElement).dataset.contentid;
    if (!contentId) return subs;

    // Known VTT URL pattern: https://cc.vudu.com/{prefix}/{contentId}/movie/subtitle.{num}.{lang}.vtt
    // The prefix number appears to be a bucket derived from the content ID
    // We can try to extract it from any existing <track> elements first
    const existingTrack = video.querySelector('track[src*="cc.vudu.com"]');
    if (existingTrack && existingTrack.getAttribute("src")) {
      // We already have a track URL, extract the base pattern to try other languages
      const srcUrl = existingTrack.getAttribute("src")!;
      const baseUrlMatch = srcUrl.match(/^(https:\/\/cc\.vudu\.com\/\d+\/\d+\/movie\/subtitle\.)/);
      if (baseUrlMatch) {
        const baseUrl = baseUrlMatch[1];
        // Common language codes and their numeric IDs
        // The number before the language code varies; we only know what we see
        // For now, just report what we know; we'll fetch other languages
        // via network interception if the user switches CC in the player
      }
    }

    // Also check meta[name="clearplay"] which has the contentId
    const clearplayMeta = document.querySelector('meta[name="clearplay"]');
    if (clearplayMeta && !video) {
      log(`Found clearplay meta with contentId: ${clearplayMeta.getAttribute("content")}`);
    }
  } catch (e) {
    log("ContentId discovery error:", e);
  }

  return subs;
}

// ========================================
// Strategy 5: Monitor video textTracks (including metadata kind)
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

          // Fandango uses kind="metadata" — we need to check those too
          const isSubtitleTrack =
            track.kind === "subtitles" ||
            track.kind === "captions" ||
            track.kind === "metadata";

          if (isSubtitleTrack && track.cues && track.cues.length > 0) {
            const trackKey = `${track.kind}_${track.label || track.language}_${track.cues.length}`;
            if (seenTrackKeys.has(trackKey)) continue;
            seenTrackKeys.add(trackKey);

            // Enable the track to read its cues if it's hidden/disabled
            if (track.mode === "disabled" || track.mode === "hidden") {
              track.mode = "showing";
            }

            // Reconstruct VTT from cues
            let vttContent = "WEBVTT\n\n";
            Array.from(track.cues).forEach((cue, idx) => {
              const vttcue = cue as VTTCue;
              const start = formatVTTTime(vttcue.startTime);
              const end = formatVTTTime(vttcue.endTime);
              vttContent += idx + 1 + "\n";
              vttContent += start + " --> " + end + "\n";
              vttContent += (vttcue as any).text || vttcue.text + "\n\n";
            });

            log(`Captured ${track.cues.length} cues from ${track.kind} textTrack: ${track.label || track.language}`);
            sendSubtitleContent(
              vttContent,
              track.language || "en",
              track.label || `${track.kind} Track`,
            );
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
// Strategy 6: MutationObserver for late-loading elements
// ========================================
function watchForDynamicElements(): void {
  const observer = new MutationObserver((mutations) => {
    let foundNew = false;

    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLVideoElement) {
          foundNew = true;
        } else if (node instanceof HTMLElement) {
          // Check for video element or track element additions
          if (node.querySelector("video") || node.tagName === "TRACK") {
            foundNew = true;
          }
        }
      }
      if (foundNew) break;
    }

    if (foundNew) {
      log("New video/track element detected");
      setTimeout(() => {
        const trackSubs = extractMetadataTracks();
        if (trackSubs.length > 0) {
          uniqueSendSubtitles(trackSubs, "dynamic-metadata-tracks");
        }

        const shakaSubs = extractFromShakaPlayer();
        if (shakaSubs.length > 0) {
          uniqueSendSubtitles(shakaSubs, "dynamic-shaka");
        }
      }, 500);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

// ========================================
// Hide Fandango's native subtitle rendering
// ========================================
function hideNativeSubtitles(): void {
  const injectHideCSS = () => {
    const styleId = "ffprofanity-fandango-hide";
    if (document.getElementById(styleId)) return;

    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      /* Hide Fandango's subtitleContainer so our overlay replaces it */
      #subtitleContainer { visibility: hidden !important; opacity: 0 !important; }
    `;
    document.head.appendChild(style);
    log("Injected CSS to hide Fandango native subtitles");
  };

  window.addEventListener("message", (event) => {
    if (
      event.source === window &&
      event.data?.type === "FFPROFANITY_HIDE_NATIVE_SUBTITLES"
    ) {
      log("Received HIDE_NATIVE_SUBTITLES message");
      injectHideCSS();
    }
  });

  // Delay initial injection to give the player time to load
  setTimeout(injectHideCSS, 3000);
}

// ========================================
// Proactively fetch known VTT URLs
// ========================================
async function fetchKnownVttUrls(): Promise<void> {
  const tracks = extractMetadataTracks();
  for (const track of tracks) {
    if (track.url && !sentUrls.has(track.url)) {
      sentUrls.add(track.url);
      try {
        log(`Proactively fetching VTT: ${track.url}`);
        const response = await fetch(track.url);
        if (response.ok) {
          const text = await response.text();
          if (text.includes("-->")) {
            sendSubtitleContent(text, track.language, track.label, track.url);
          }
        }
      } catch (e) {
        log(`Failed to fetch VTT ${track.url}:`, e);
      }
    }
  }
}

// ========================================
// Initialize all strategies
// ========================================
function init() {
  log(`Fandango page script initializing on: ${window.location.hostname}`);

  // Install network interceptors first (they run synchronously)
  setupNetworkInterception();

  // Check existing <track> elements
  const trackSubs = extractMetadataTracks();
  if (trackSubs.length > 0) {
    uniqueSendSubtitles(trackSubs, "init");
  }

  // Check Shaka player
  const shakaSubs = extractFromShakaPlayer();
  if (shakaSubs.length > 0) {
    uniqueSendSubtitles(shakaSubs, "init");
  }

  // Try to discover VTT URLs from contentid
  const discoveredSubs = discoverVttFromContentId();
  if (discoveredSubs.length > 0) {
    uniqueSendSubtitles(discoveredSubs, "contentid-discovery");
  }

  // Monitor video textTracks (including metadata kind)
  monitorVideoTextTracks();

  // Watch for dynamically added elements
  watchForDynamicElements();

  // Hide Fandango's native subtitles
  hideNativeSubtitles();

  // Proactively fetch VTT content from detected track URLs
  fetchKnownVttUrls();

  // Periodically check for Shaka player (may load after page)
  let shakaChecks = 0;
  const shakaInterval = setInterval(() => {
    shakaChecks++;
    const subs = extractFromShakaPlayer();
    if (subs.length > 0) {
      uniqueSendSubtitles(subs, "shaka-poll");
    }
    if (shakaChecks >= 20) {
      clearInterval(shakaInterval);
    }
  }, 500);

  log("Fandango page script initialized");
}

// Run when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}