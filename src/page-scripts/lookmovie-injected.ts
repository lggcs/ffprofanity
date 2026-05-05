/**
 * LookMovie Page Script - Injected via browser.scripting.executeScript with world: 'MAIN'
 *
 * This script handles:
 * 1. VideoJS player text track extraction
 * 2. XHR/Fetch interception for HLS manifests and subtitle URLs
 * 3. Auto-enabling captions and selecting English track
 * 4. Hiding native subtitles
 */

import {
  extractLanguageFromUrl,
  getLanguageName,
  findSubtitlesRecursive,
} from "../lib/page-script-helpers";
import {
  createSendSubtitles,
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

// LookMovie has custom dedup: number same-language tracks and allow user re-selection
const sentSubtitleHashes = new Set<string>();
let lastTracksHash = "";
let userSelectionInProgress = false;
let pendingUserSelection: SubtitleTrack | null = null;

function sendSubtitles(subs: SubtitleTrack[], source: string): void {
  if (!subs || subs.length === 0) return;

  const isUserSelection = source === "lookmovie.user-subtitle-selected";

  let finalSubs = subs;
  if (!isUserSelection) {
    // Number same-language tracks
    const languageTotalCounts: Record<string, number> = {};
    for (const sub of subs) {
      const lang = sub.language.toLowerCase();
      languageTotalCounts[lang] = (languageTotalCounts[lang] || 0) + 1;
    }

    const languageLabelCounts: Record<string, number> = {};
    const numberedSubs = subs.map((sub) => {
      const normalizedLabel = sub.label || getLanguageName(sub.language) || "Unknown";
      const lang = sub.language.toLowerCase();
      const key = `${lang}:${normalizedLabel}`;
      languageLabelCounts[key] = (languageLabelCounts[key] || 0) + 1;
      const number = languageLabelCounts[key];
      const numberedLabel = `${normalizedLabel} ${number}`;
      return { ...sub, label: numberedLabel };
    });

    finalSubs = numberedSubs.map((sub) => {
      const lang = sub.language.toLowerCase();
      const totalForLang = languageTotalCounts[lang];
      if (totalForLang === 1 && sub.label.endsWith(" 1")) {
        return { ...sub, label: sub.label.replace(/ 1$/, "") };
      }
      return sub;
    });

    // Deduplicate by URL hash
    const key = finalSubs.map((s) => s.url).sort().join("|");
    if (sentSubtitleHashes.has(key)) return;
    sentSubtitleHashes.add(key);
  }

  log(`Sending ${finalSubs.length} subtitles from ${source}`);
  window.postMessage(
    {
      type: "FFPROFANITY_SUBTITLES_DETECTED",
      source,
      subtitles: finalSubs,
    },
    "*",
  );

  setTimeout(() => hideNativeSubtitles(), 500);
}

// ========================================
// Strategy 2: movie_storage global (legacy LookMovie)
// ========================================
function extractFromMovieStorage(): SubtitleTrack[] {
  const subs: SubtitleTrack[] = [];
  try {
    const tracks = (window as any).movie_storage?.text_tracks;
    if (!tracks || !Array.isArray(tracks) || tracks.length === 0) {
      const altTracks =
        (window as any).movie_storage?.subs ||
        (window as any).movie_storage?.subtitles ||
        (window as any).movie_storage?.cc ||
        (window as any).movie_storage?.captions;
      if (altTracks && Array.isArray(altTracks)) {
        return altTracks.map((t: any) => ({
          url: t.file || t.url || t.src,
          language: t.language || t.lang || "en",
          label: t.label || t.name || "English",
        })).filter((s: SubtitleTrack) => s.url);
      }
      return subs;
    }

    return tracks.map((t: any) => ({
      url: t.file || t.url || t.src,
      language: t.language || "en",
      label: t.label || "English",
    })).filter((s: SubtitleTrack) => s.url);
  } catch (e) {
    log("movie_storage extraction error:", (e as Error).message || e);
  }
  return subs;
}

// Poll for text_tracks changes
let lastTextTracksJson = "";
let textTracksCheckInterval: ReturnType<typeof setInterval> | null = null;

function setupTextTracksWatcher(): void {
  if (textTracksCheckInterval) {
    clearInterval(textTracksCheckInterval);
  }

  textTracksCheckInterval = setInterval(() => {
    const tracks = (window as any).movie_storage?.text_tracks;
    if (tracks && Array.isArray(tracks)) {
      const tracksJson = JSON.stringify(tracks);
      if (tracksJson !== lastTextTracksJson && tracksJson !== "[]" && tracksJson !== "") {
        lastTextTracksJson = tracksJson;
        log("text_tracks changed, length:", tracks.length);
        checkAndSendTracks("lookmovie.text_tracks_poll");
      }
    }
  }, 500);
}

// ========================================
// Combine all strategies
// ========================================
function checkAndSendTracks(source: string): void {
  const allSubs: SubtitleTrack[] = [];

  const videojsSubs = extractFromVideoJS();
  allSubs.push(...videojsSubs);

  const storageSubs = extractFromMovieStorage();
  allSubs.push(...storageSubs);

  const videoSubs = extractFromVideoTrackElements();
  allSubs.push(...videoSubs);

  if (allSubs.length > 0) {
    sendSubtitles(allSubs, source);
  }
}

// ========================================
// Watch for VideoJS player initialization
// ========================================
function watchForVideoJS(): void {
  if (typeof (window as any).videojs !== "undefined") {
    log("VideoJS already available");
    setTimeout(() => checkAndSendTracks("lookmovie.videojs-ready"), 100);
    setTimeout(() => checkAndSendTracks("lookmovie.videojs-delayed"), 2000);
  }

  let videojsCheckCount = 0;
  const videojsCheckInterval = setInterval(() => {
    videojsCheckCount++;
    if (typeof (window as any).videojs !== "undefined") {
      clearInterval(videojsCheckInterval);
      log("VideoJS detected via polling");
      setTimeout(() => checkAndSendTracks("lookmovie.videojs-polled"), 100);
      setTimeout(() => checkAndSendTracks("lookmovie.videojs-polled-delayed"), 2000);
    } else if (videojsCheckCount > 200) {
      clearInterval(videojsCheckInterval);
    }
  }, 100);

  const playerObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of Array.from(mutation.addedNodes)) {
        if (node instanceof HTMLVideoElement) {
          log("Video element added");
          setTimeout(() => checkAndSendTracks("lookmovie.video-added"), 200);
          setTimeout(() => checkAndSendTracks("lookmovie.video-added-delayed"), 1000);
        }
      }
    }
  });
  playerObserver.observe(document.body, { childList: true, subtree: true });
}

// ========================================
// Hijack XHR for HLS manifest and subtitle files
// ========================================
function setupXHRInterception(): void {
  interceptXHR(sendSubtitles, {
    subtitleSource: "lookmovie.xhr-subtitle",
    hlsSource: "lookmovie.hls",
    checkHLS: true,
    checkSubtitles: true,
    parseHLSManifest,
    urlFilter: () => {
      if (userSelectionInProgress) {
        log("XHR intercept blocked - user selection in progress");
        return false;
      }
      if (pendingUserSelection) {
        log("XHR intercept blocked - using pending user selection");
        return false;
      }
      return true;
    },
  });
}

// ========================================
// Hijack fetch API
// ========================================
function setupFetchInterception(): void {
  interceptFetch(sendSubtitles, {
    subtitleSource: "lookmovie.fetch-subtitle",
    hlsSource: "lookmovie.fetch-hls",
    checkHLS: true,
    checkSubtitles: true,
    parseHLSManifest,
  });
}

// ========================================
// Auto-enable captions and select English
// ========================================
function tryEnableCaptions(): void {
  log("tryEnableCaptions: attempting to enable captions...");

  const ccSelectors = [
    ".vjs-subtitles-language-toggle",
    ".vjs-subs-caps-button",
    ".vjs-captions-button",
    ".vjs-subtitles-button",
    'button[aria-label*="caption"]',
    'button[aria-label*="subtitle"]',
    'button[aria-label*="subtitles"]',
    'button[class*="subtitle"]',
  ];

  for (const selector of ccSelectors) {
    const ccButton = document.querySelector(selector) as HTMLButtonElement;
    if (ccButton) {
      const isPressed =
        ccButton.getAttribute("aria-pressed") === "true" ||
        ccButton.classList.contains("vjs-enabled") ||
        ccButton.classList.contains("vjs-playing");

      if (!isPressed) {
        if ((window as any).__ffprofanity_lm_cc_clicked) {
          log("CC button already clicked");
          return;
        }
        (window as any).__ffprofanity_lm_cc_clicked = true;
        log("Clicking CC button to enable captions");
        ccButton.click();

        setTimeout(() => checkAndSendTracks("lookmovie.cc-auto-click"), 500);
        setTimeout(() => checkAndSendTracks("lookmovie.cc-auto-click-delayed"), 2000);
        setTimeout(() => selectEnglishSubtitle(), 300);
        return;
      } else {
        log("Captions already enabled");
        setTimeout(() => selectEnglishSubtitle(), 300);
        return;
      }
    }
  }
  log("No CC button found");
}

function selectEnglishSubtitle(): void {
  const showingItem = document.querySelector(".vjs-subtitles-language-item.showing");
  if (showingItem && showingItem.textContent?.includes("English")) {
    log("English subtitle already selected:", showingItem.textContent?.trim());
    setTimeout(() => hideNativeSubtitles(), 500);
    return;
  }

  const items = Array.from(document.querySelectorAll(".vjs-subtitles-language-item"));
  let targetItem: Element | null = null;

  for (const item of items) {
    const text = item.textContent?.trim() || "";
    if (text === "English 1") {
      targetItem = item;
      break;
    } else if (!targetItem && text.startsWith("English")) {
      targetItem = item;
    }
  }

  if (targetItem && !targetItem.classList.contains("showing")) {
    log("Selecting subtitle:", targetItem.textContent?.trim());
    (targetItem as HTMLElement).click();

    setTimeout(() => {
      const selectedTrack = findTrackForSelectedItem(targetItem!);
      if (selectedTrack) {
        log("Auto-select: sending track:", selectedTrack.url);
        sendSubtitles([selectedTrack], "lookmovie.auto-selected");
      } else {
        checkAndSendTracks("lookmovie.subtitle-selected");
      }
    }, 500);
    setTimeout(() => hideNativeSubtitles(), 1000);
  } else if (!targetItem) {
    log("No English subtitle option found in menu");
  }
}

function hideNativeSubtitles(): boolean {
  log("hideNativeSubtitles: attempting to disable native subtitles");

  const offButton = findOffButton();
  if (offButton) {
    log('hideNativeSubtitles: Found "Off" button directly, clicking');
    offButton.click();
    return true;
  }

  const ccButton = findCCButton();
  if (ccButton) {
    log('hideNativeSubtitles: Opening CC menu to access "Off" button');
    ccButton.click();

    setTimeout(() => {
      const offBtn = findOffButton();
      if (offBtn) {
        log('hideNativeSubtitles: Found "Off" button after opening menu, clicking');
        offBtn.click();
      } else {
        log('hideNativeSubtitles: Still no "Off" button found after opening menu');
      }
    }, 200);
    return true;
  }

  log("hideNativeSubtitles: No CC button or Off button found");
  return false;
}

function findOffButton(): HTMLElement | null {
  const items = Array.from(
    document.querySelectorAll(".vjs-subtitles-language-item, .vjs-menu-item"),
  );
  for (const item of items) {
    if (item.textContent?.trim() === "Off") {
      return item as HTMLElement;
    }
  }

  const buttons = Array.from(document.querySelectorAll("button"));
  for (const btn of buttons) {
    if (btn.textContent?.trim() === "Off") {
      return btn;
    }
  }

  return null;
}

function findCCButton(): HTMLElement | null {
  const selectors = [
    ".vjs-subtitles-language-toggle",
    ".vjs-subs-caps-button",
    ".vjs-captions-button",
    ".vjs-subtitles-button",
    'button[aria-label*="caption"]',
    'button[aria-label*="subtitle"]',
    'button[class*="subtitle"]',
  ];

  for (const selector of selectors) {
    const btn = document.querySelector(selector) as HTMLElement;
    if (btn) return btn;
  }

  return null;
}

function setupSubtitleChangeListener(): void {
  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const subtitleItem = target.closest(".vjs-subtitles-language-item");
    if (subtitleItem && !subtitleItem.classList.contains("showing")) {
      const selectedText = subtitleItem.textContent?.trim();
      log("User selected subtitle:", selectedText);

      userSelectionInProgress = true;
      (window as any).__ffprofanity_lm_cc_clicked = false;

      const selectedTrack = findTrackForSelectedItem(subtitleItem);

      if (selectedTrack) {
        pendingUserSelection = selectedTrack;
        log("Sending user-selected track:", selectedTrack.url);
        sendSubtitles([selectedTrack], "lookmovie.user-subtitle-selected");

        setTimeout(() => {
          userSelectionInProgress = false;
          pendingUserSelection = null;
        }, 2000);
      } else {
        setTimeout(() => {
          checkAndSendTracks("lookmovie.user-subtitle-change");
          userSelectionInProgress = false;
        }, 500);
      }

      setTimeout(() => hideNativeSubtitles(), 300);
    }
  }, true);
}

function findTrackForSelectedItem(menuItem: Element): SubtitleTrack | null {
  try {
    const pageWindow = (window as any).wrappedJSObject || window;
    const videojs = pageWindow.videojs;

    if (!videojs) {
      log("findTrackForSelectedItem: videojs not available");
      return null;
    }

    let player: any = null;

    if (typeof videojs.getPlayerIds === "function") {
      const playerIds = videojs.getPlayerIds() as string[];
      if (playerIds.length > 0) {
        player = videojs.getPlayer.call(videojs, playerIds[0]);
      }
    } else if (videojs.players) {
      const playerIds = Object.keys(videojs.players);
      if (playerIds.length > 0) {
        player = videojs.players[playerIds[0]];
      }
    }

    if (!player) {
      log("findTrackForSelectedItem: no player found");
      return null;
    }

    const selectedText = menuItem.textContent?.trim() || "";
    log(`findTrackForSelectedItem: looking for track matching "${selectedText}"`);

    const remoteEls = typeof player.remoteTextTrackEls === "function" ? player.remoteTextTrackEls() : [];
    const textTracks = typeof player.textTracks === "function" ? player.textTracks() : [];

    const numberMatch = selectedText.match(/\s+(\d+)$/);
    const selectedNumber = numberMatch ? numberMatch[1] : null;
    const selectedLang = selectedText.replace(/\s+\d+$/, "").trim().toLowerCase();

    log(`findTrackForSelectedItem: parsed lang="${selectedLang}" number="${selectedNumber}"`);

    interface TrackInfo {
      url: string;
      language: string;
      label: string;
      index: number;
    }
    const allTracks: TrackInfo[] = [];

    for (let i = 0; i < remoteEls.length; i++) {
      const trackEl = remoteEls[i];
      if (!trackEl || !trackEl.src) continue;

      const track = textTracks[i];
      const url = trackEl.src;
      const label = track?.label || trackEl.getAttribute?.("label") || "";
      const lang = track?.language || trackEl.getAttribute?.("srclang") || extractLanguageFromUrl(url);

      allTracks.push({ url, language: lang, label, index: i });
    }

    log(`findTrackForSelectedItem: found ${allTracks.length} tracks to search`);

    // Strategy 1: Exact label match
    for (const t of allTracks) {
      if (t.label === selectedText) {
        log(`findTrackForSelectedItem: exact match "${t.label}"`);
        return { url: t.url, language: t.language, label: t.label };
      }
    }

    // Strategy 2: Same language + same number
    if (selectedNumber !== null) {
      const sameLangTracks = allTracks.filter((t) => {
        const trackLang = t.language.toLowerCase();
        const trackLabelLang = t.label.toLowerCase().replace(/\s+\d+$/, "").trim();
        return trackLang === selectedLang || trackLabelLang === selectedLang ||
               trackLabelLang.includes(selectedLang) || selectedLang.includes(trackLabelLang);
      });

      log(`findTrackForSelectedItem: found ${sameLangTracks.length} tracks for language "${selectedLang}"`);

      const targetIndex = parseInt(selectedNumber, 10);
      if (targetIndex > 0 && targetIndex <= sameLangTracks.length) {
        const selectedTrack = sameLangTracks[targetIndex - 1];
        log(`findTrackForSelectedItem: using track #${targetIndex} for "${selectedText}": ${selectedTrack.url.substring(0, 60)}`);
        return { url: selectedTrack.url, language: selectedTrack.language, label: selectedText };
      }
    }

    // Strategy 3: First track of the language
    if (selectedNumber === null) {
      for (const t of allTracks) {
        const trackLang = t.language.toLowerCase();
        const trackLabelLower = t.label.toLowerCase();
        if (trackLang === selectedLang || trackLabelLower.includes(selectedLang)) {
          log(`findTrackForSelectedItem: language-only match "${t.label}"`);
          return { url: t.url, language: t.language, label: t.label };
        }
      }
    }

    // Strategy 4: Currently showing track
    for (let i = 0; i < textTracks.length; i++) {
      const track = textTracks[i];
      if (track.mode === "showing") {
        const trackEl = remoteEls[i];
        if (trackEl && trackEl.src) {
          const trackLang = track.language?.toLowerCase() || "";
          const trackLabel = track.label || "";
          if (trackLang === selectedLang || trackLabel.toLowerCase().includes(selectedLang)) {
            log(`findTrackForSelectedItem: found showing track "${trackLabel}"`);
            return {
              url: trackEl.src,
              language: track.language || extractLanguageFromUrl(trackEl.src),
              label: trackLabel,
            };
          }
        }
      }
    }

    log("findTrackForSelectedItem: no matching track found");
  } catch (e) {
    log("findTrackForSelectedItem error:", (e as Error).message || e);
  }

  return null;
}

function watchForPlayerTransition(): void {
  log("Watching for player transitions (ad -> content)");

  let lastSrc = "";
  const checkVideoSrc = () => {
    const video = document.querySelector("video");
    if (video && video.src && video.src !== lastSrc) {
      lastSrc = video.src;
      log("Video source changed:", video.src.substring(0, 60));
      setTimeout(() => checkAndSendTracks("lookmovie.video-src-change"), 500);
      setTimeout(() => checkAndSendTracks("lookmovie.video-src-delayed"), 2000);
      setTimeout(() => checkAndSendTracks("lookmovie.video-src-slow"), 5000);
    }
  };

  setInterval(checkVideoSrc, 1000);

  document.addEventListener("playing", (e) => {
    if (e.target instanceof HTMLVideoElement) {
      log("Video playing event");
      checkVideoSrc();
      setTimeout(() => checkAndSendTracks("lookmovie.video-playing"), 500);
    }
  }, true);

  document.addEventListener("loadedmetadata", (e) => {
    if (e.target instanceof HTMLVideoElement) {
      log("Video loadedmetadata event");
      setTimeout(() => checkAndSendTracks("lookmovie.video-metadata"), 200);
    }
  }, true);
}

function setupCCButtonDetection(): void {
  const ccButtonSelectors = [
    ".vjs-subtitles-language-toggle",
    ".vjs-subs-caps-button",
    ".vjs-captions-button",
    ".vjs-subtitles-button",
  ];

  for (const selector of ccButtonSelectors) {
    const btn = document.querySelector(selector);
    if (btn) {
      btn.addEventListener("click", () => {
        log("CC button clicked");
        setTimeout(() => checkAndSendTracks("lookmovie.cc-clicked"), 300);
        setTimeout(() => checkAndSendTracks("lookmovie.cc-clicked-delayed"), 1000);
      });
    }
  }

  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    for (const sel of ccButtonSelectors) {
      if (target.matches && (target.matches(sel) || target.closest?.(sel))) {
        log("CC container clicked");
        setTimeout(() => checkAndSendTracks("lookmovie.cc-container-click"), 300);
        break;
      }
    }
  }, true);
}

// ========================================
// Initialize
// ========================================
function init(): void {
  // Skip execution in iframes
  if (window.self !== window.top) return;

  log("Extractor initializing");

  setupXHRInterception();
  setupFetchInterception();
  watchForVideoJS();
  setupCCButtonDetection();
  setupSubtitleChangeListener();
  watchForPlayerTransition();

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;

    if (event.data?.type === "FFPROFANITY_HIDE_NATIVE_SUBTITLES") {
      log("Received HIDE_NATIVE_SUBTITLES message");
      hideNativeSubtitles();
      setTimeout(() => hideNativeSubtitles(), 500);
      setTimeout(() => hideNativeSubtitles(), 1500);
      setTimeout(() => hideNativeSubtitles(), 3000);
    }

    if (event.data?.type === "FFPROFANITY_TRACK_SELECTED") {
      log("Received TRACK_SELECTED message:", event.data?.track?.label);
      hideNativeSubtitles();
      setTimeout(() => hideNativeSubtitles(), 500);
      setTimeout(() => hideNativeSubtitles(), 1500);
    }
  });

  // Setup movie_storage watcher
  if ((window as any).movie_storage) {
    setupTextTracksWatcher();
    const tracks = (window as any).movie_storage.text_tracks;
    if (tracks && tracks.length > 0) {
      checkAndSendTracks("lookmovie.storage-initial");
    }
  } else {
    let attempts = 0;
    const checkInterval = setInterval(() => {
      attempts++;
      if ((window as any).movie_storage) {
        clearInterval(checkInterval);
        setupTextTracksWatcher();
        const tracks = (window as any).movie_storage.text_tracks;
        if (tracks && tracks.length > 0) {
          checkAndSendTracks("lookmovie.storage-found");
        }
      } else if (attempts > 100) {
        clearInterval(checkInterval);
      }
    }, 200);
  }

  // Delayed checks for dynamic content
  setTimeout(() => checkAndSendTracks("lookmovie.init-500"), 500);
  setTimeout(() => checkAndSendTracks("lookmovie.init-2000"), 2000);
  setTimeout(() => checkAndSendTracks("lookmovie.init-5000"), 5000);
  setTimeout(() => checkAndSendTracks("lookmovie.init-10000"), 10000);
  setTimeout(() => checkAndSendTracks("lookmovie.init-15000"), 15000);
  setTimeout(() => checkAndSendTracks("lookmovie.init-20000"), 20000);

  setTimeout(tryEnableCaptions, 2000);
  setTimeout(tryEnableCaptions, 5000);
  setTimeout(tryEnableCaptions, 10000);

  log("Extractor ready");
}

init();