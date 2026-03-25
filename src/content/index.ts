/**
 * Content Script
 * Monitors video playback, renders subtitle overlay, and triggers mute/unmute
 */

import { storage } from "../lib/storage";
import { parseSubtitle, sanitizeText, ParseResult } from "../lib/parser";
import {
  ProfanityDetector,
  createDetector,
  computeProfanityWindows,
} from "../lib/detector";
import { CueIndex } from "../lib/cueIndex";
import {
  selectBestTrack,
  formatTrackLabel,
  createTrackFromUser,
} from "../lib/tracks";
import {
  scanPageForTracks,
  extractFromPageScripts,
  watchForVideoTracks,
} from "../lib/extractor";
import {
  getAllMatchingExtractors,
  extractLanguageFromUrl,
  isSubtitleUrl,
} from "../extractors";
import type { Cue, Settings, SubtitleTrack } from "../types";

// State
let cues: Cue[] = [];
let detector: ProfanityDetector;
let settings: Settings;
let cueIndex: CueIndex;

// Track state
let detectedTracks: SubtitleTrack[] = [];
let currentTrack: SubtitleTrack | null = null;

// DOM elements
let overlayContainer: HTMLDivElement | null = null;
let currentCueEl: HTMLDivElement | null = null;
let nextCuesEl: HTMLDivElement | null = null;
let notificationEl: HTMLDivElement | null = null;

// Video state
let videoElement: HTMLVideoElement | null = null;
let isActive = false;
let animationFrameId: ReturnType<typeof requestAnimationFrame> | null = null;

// Live TV timing state - track previous firstCue to detect broadcast-absolute pattern
let previousFirstCueMs: number | null = null;
let lastCueId: number | null = null;
let currentProfanityCue: Cue | null = null; // Track current profanity cue for mute state
let playbackRate: number = 1.0; // Track playback speed
let isMuted: boolean = false; // Track mute state to avoid redundant messages

// Track last known good time to ignore hover preview seeks
let lastStableTimeMs: number = 0;
let pendingSeekTimeMs: number | null = null;
let pendingSeekFrameCount: number = 0;
let lastKnownTimeMs: number = 0; // Last known good time from display element
let lastKnownTimeTimestamp: number = 0; // When we last read a valid time (for estimation)
let timeEstimateOffset: number = 0; // Offset between display time and video.currentTime (for calibration)

// Reference to time display element (for sites like fmovies where video.currentTime is unreliable)
let timeDisplayElement: HTMLElement | null = null;

// Debouncing
let muteDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let unmuteTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Initialize the content script
 */
async function init(): Promise<void> {
  console.log("[FFProfanity] Content script initializing...");

  // Load settings
  settings = await storage.getSettings();
  console.log("[FFProfanity] Settings loaded:", {
    offsetMs: settings.offsetMs,
    sensitivity: settings.sensitivity,
    useSubstitutions: settings.useSubstitutions,
  });

  // Create detector
  // Only pass wordlist if user has custom words; otherwise use defaults
  const detectorConfig: Partial<import("../lib/detector").ProfanityConfig> = {
    ...settings,
    wordlist: settings.wordlist.length > 0 ? settings.wordlist : undefined,
    customSubstitutions: settings.customSubstitutions
      ? new Map(Object.entries(settings.customSubstitutions))
      : undefined,
  };
  detector = createDetector(detectorConfig);
  if (settings.wordlist.length > 0) {
    detector.addWords(settings.wordlist);
  }
  // Apply substitution settings
  if (settings.useSubstitutions) {
    detector.setSubstitutions(true, settings.substitutionCategory);
    if (
      settings.customSubstitutions &&
      Object.keys(settings.customSubstitutions).length > 0
    ) {
      detector.setCustomSubstitutions(
        new Map(Object.entries(settings.customSubstitutions)),
      );
    }
  }

  // Initialize cue index
  cueIndex = new CueIndex();

  // Find video element
  findVideoElement();
  console.log("[FFProfanity] Video element found:", !!videoElement);

  // Create overlay
  createOverlay();
  console.log("[FFProfanity] Overlay created");

  // Inject script to intercept API responses on streaming sites
  injectApiInterceptor();

  // Clear any old saved cues - user prefers per-session only
  await storage.clearCues();

  // Scan for existing subtitle tracks
  await scanForTracks();
  console.log("[FFProfanity] Detected tracks:", detectedTracks.length);

  // Watch for dynamically added tracks
  watchForVideoTracks((tracks) => {
    console.log("[FFProfanity] New tracks detected:", tracks.length);
    addDetectedTracks(tracks);
  });

  // Listen for storage changes
  browser.storage.onChanged.addListener(handleStorageChange);

  // Listen for messages from background and popup
  browser.runtime.onMessage.addListener(handleMessage);

  // Start enabled by default if settings say so
  if (settings.enabled !== false) {
    isActive = true;
    startMonitoring();
  }

  console.log("[FFProfanity] Content script ready");
}

/**
 * Inject script to intercept API responses from streaming sites
 * This captures subtitle URLs from JSON API responses
 */
function injectApiInterceptor(): void {
  // Get site-specific injected scripts
  const currentUrl = window.location.href;
  const matchingExtractors = getAllMatchingExtractors(currentUrl);
  const siteScripts = matchingExtractors
    .map((e) => (e as any).getInjectedScript?.() || "")
    .filter((s: string) => s.length > 0)
    .join("\n\n");

  const script = document.createElement("script");
  script.textContent = `
    (function() {
      console.log('[FFProfanity] API interceptor injected');

      // Site-specific extractors
      ${siteScripts}

      // Generic helper: Recursively find subtitle URLs in any object
      function findSubtitlesRecursive(obj) {
        const subs = [];
        if (!obj || typeof obj !== 'object') return subs;

        // Check if this object looks like a subtitle entry
        if (obj.file && typeof obj.file === 'string' &&
            (obj.file.includes('.vtt') || obj.file.includes('.srt') || obj.file.includes('.ass'))) {
          subs.push({
            url: obj.file,
            language: obj.language || obj.lang || obj.code || 'unknown',
            label: obj.label || obj.name || obj.language || 'Detected'
          });
        }
        if (obj.url && typeof obj.url === 'string' &&
            (obj.url.includes('.vtt') || obj.url.includes('.srt') || obj.url.includes('.ass'))) {
          subs.push({
            url: obj.url,
            language: obj.language || obj.lang || obj.code || 'unknown',
            label: obj.label || obj.name || obj.language || 'Detected'
          });
        }

        // Recursively search arrays
        if (Array.isArray(obj)) {
          for (const item of obj) {
            subs.push(...findSubtitlesRecursive(item));
          }
        } else {
          // Search object properties, prioritizing subtitle-related keys
          const priorityKeys = ['subtitles', 'subs', 'captions', 'cc', 'text_tracks', 'tracks'];
          for (const key of priorityKeys) {
            if (obj[key]) {
              subs.push(...findSubtitlesRecursive(obj[key]));
            }
          }
        }

        return subs;
      }

      // Generic helper: Extract language from URL
      function extractLanguageFromUrl(url) {
        const patterns = [
          /[?&]lang=([a-z]{2,3})/i,
          /\\/([a-z]{2,3})_[a-f0-9]+\\.vtt$/i,
          /\\/([a-z]{2,3})\\/[^/]+\\.vtt$/i,
          /[_\\-\\.]([a-z]{2,3})\\.(vtt|srt|ass)$/i
        ];
        for (const pattern of patterns) {
          const match = url.match(pattern);
          if (match) return match[1].toLowerCase();
        }
        return 'unknown';
      }

      // Generic helper: Language code to name
      function getLanguageName(code) {
        const names = {
          en: 'English', es: 'Spanish', fr: 'French', de: 'German',
          it: 'Italian', pt: 'Portuguese', ru: 'Russian', ja: 'Japanese',
          ko: 'Korean', zh: 'Chinese', ar: 'Arabic', hi: 'Hindi'
        };
        return names[code.toLowerCase()] || code.toUpperCase();
      }

      // Intercept XMLHttpRequest
      const originalXHROpen = XMLHttpRequest.prototype.open;
      const originalXHRSend = XMLHttpRequest.prototype.send;

      XMLHttpRequest.prototype.open = function(method, url) {
        this._ffprofanity_url = url;
        return originalXHROpen.apply(this, arguments);
      };

      XMLHttpRequest.prototype.send = function() {
        const xhr = this;

        xhr.addEventListener('load', function() {
          const url = xhr._ffprofanity_url || '';

          if (xhr.responseType !== '' && xhr.responseType !== 'text') {
            return; // Skip binary responses
          }

          try {
            const responseText = xhr.responseText || '';

            // Direct subtitle file URLs
            if (/\\.(vtt|srt|ass|ssa)/i.test(url) && !url.includes('blob:')) {
              console.log('[FFProfanity] Intercepted subtitle URL:', url);
              const lang = extractLanguageFromUrl(url);
              window.postMessage({
                type: 'FFPROFANITY_SUBTITLES_DETECTED',
                source: 'xhr',
                subtitles: [{ url: url, language: lang, label: getLanguageName(lang) }]
              }, '*');
            }

            // JSON responses - search recursively for subtitles
            if (responseText.trim().startsWith('{') || responseText.trim().startsWith('[')) {
              try {
                const data = JSON.parse(responseText);
                const subs = findSubtitlesRecursive(data);
                if (subs.length > 0) {
                  console.log('[FFProfanity] Found ' + subs.length + ' subtitles in JSON response:', url.substring(0, 100));
                  window.postMessage({
                    type: 'FFPROFANITY_SUBTITLES_DETECTED',
                    source: 'json-recursive',
                    subtitles: subs
                  }, '*');
                }
              } catch (e) { /* Not valid JSON */ }
            }
          } catch (e) { /* Error reading response */ }
        });

        return originalXHRSend.apply(this, arguments);
      };

      // Intercept fetch
      const originalFetch = window.fetch;
      window.fetch = function(input, init) {
        const url = typeof input === 'string' ? input : (input.url || '');

        return originalFetch.apply(this, arguments).then(response => {
          const clone = response.clone();

          // Direct subtitle URLs
          if (/\\.(vtt|srt|ass|ssa)/i.test(url)) {
            console.log('[FFProfanity] Intercepted fetch subtitle URL:', url);
            const lang = extractLanguageFromUrl(url);
            window.postMessage({
              type: 'FFPROFANITY_SUBTITLES_DETECTED',
              source: 'fetch',
              subtitles: [{ url: url, language: lang, label: getLanguageName(lang) }]
            }, '*');
          }

          // JSON responses
          if (url && (url.includes('timedtext') || url.includes('caption') || url.includes('subtitle') || url.includes('/api/'))) {
            clone.text().then(text => {
              try {
                const data = JSON.parse(text);
                const subs = findSubtitlesRecursive(data);
                if (subs.length > 0) {
                  window.postMessage({
                    type: 'FFPROFANITY_SUBTITLES_DETECTED',
                    source: 'fetch-json',
                    subtitles: subs
                  }, '*');
                }
              } catch (e) { /* Not JSON */ }
            });
          }

          return response;
        });
      };

      // Watch for CC button clicks (generic)
      document.addEventListener('click', function(e) {
        const ccSelectors = [
          '[class*="cc"]', '[class*="caption"]', '[class*="subtitle"]',
          '[aria-label*="subtitle"]', '[aria-label*="caption"]', '[aria-label*="cc"]',
          '.ytp-subtitles-button', '.cc-button'
        ];
        const target = e.target;
        for (const sel of ccSelectors) {
          if (target.matches && (target.matches(sel) || target.closest?.(sel))) {
            console.log('[FFProfanity] CC button clicked');
            // Site-specific handlers will check after click
            break;
          }
        }
      }, true);
    })();
  `;

  const scriptContent = script.textContent;
  script.remove();

  const fallbackScript = document.createElement("script");
  fallbackScript.textContent = scriptContent;
  (document.head || document.documentElement).appendChild(fallbackScript);
  fallbackScript.remove();

  window.addEventListener("message", handleInterceptedMessage);
}

/**
 * Handle intercepted subtitle data from injected script
 * Handles two message types:
 * - FFPROFANITY_SUBTITLES_DETECTED: Track metadata (URL, language, label)
 * - FFPROFANITY_SUBTITLE_CONTENT: Actual subtitle content fetched in page context
 */
function handleInterceptedMessage(event: MessageEvent): void {
  if (event.source !== window) return;

  // Handle subtitle content (fetched in page context with cookies)
  if (event.data?.type === "FFPROFANITY_SUBTITLE_CONTENT") {
    // Skip if no video element - only process subtitles in frame with video
    if (!videoElement) {
      console.log("[FFProfanity] Skipping subtitle content - no video element in this frame");
      return;
    }
    const { content, language, label, source, segmentLoadTime, streamType } =
      event.data;
    console.log(
      `[FFProfanity] Received subtitle content from ${source}: ${content?.length || 0} bytes for ${language}`,
    );

    if (content && content.length > 10) {
      const segmentLoadTimeMs = segmentLoadTime
        ? Math.round(segmentLoadTime * 1000)
        : videoElement
          ? Math.round(videoElement.currentTime * 1000)
          : undefined;
      handleSubtitleContent(
        content,
        language,
        label,
        source,
        segmentLoadTimeMs,
        streamType,
      );
    }
    return;
  }

  // Handle track metadata
  if (event.data?.type !== "FFPROFANITY_SUBTITLES_DETECTED") return;

  // Skip if no video element - only process subtitles in frame with video
  // This prevents iframes from processing subtitles
  if (!videoElement) {
    console.log("[FFProfanity] Skipping subtitle detection - no video element in this frame");
    return;
  }

  const { subtitles, source } = event.data;
  console.log(
    `[FFProfanity] Received ${subtitles.length} subtitles from ${source}`,
  );

  // Log each subtitle URL for debugging
  for (const sub of subtitles) {
    if (sub.url) {
      console.log(
        `[FFProfanity] Subtitle: ${sub.label || sub.language} - ${sub.url.substring(0, 100)}...`,
      );
    }
  }

  const tracks: SubtitleTrack[] = [];

  for (const sub of subtitles) {
    if (!sub.url) continue;

    const track: SubtitleTrack = {
      id: `intercepted-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      url: sub.url,
      label: sub.label || sub.language || "Detected",
      language: sub.language || "",
      isSDH: /sdh|cc|hearing|deaf/i.test(sub.label || ""),
      isDefault: false,
      embedded: false,
      source: source,
      recommendScore: 5,
    };

    tracks.push(track);
  }

  // Add all tracks at once (this also saves to storage)
  if (tracks.length > 0) {
    addDetectedTracks(tracks);
  }
}

/**
 * Handle subtitle content received from page context (YouTube, PlutoTV, etc.)
 * For HLS streams, mtp (media time position) in URL indicates segment timeline position.
 */
function handleSubtitleContent(
  content: string,
  language: string,
  label: string,
  source: string,
  segmentLoadTimeMs?: number,
  streamType?: string,
): void {
  const rawResult = parseSubtitle(content, 0);

  if (rawResult.cues.length === 0) {
    console.error("[FFProfanity] Parse errors:", rawResult.errors);
    showNotification(
      "error",
      `Failed to parse subtitle: ${rawResult.errors.join(", ")}`,
    );
    return;
  }

  let finalCues = rawResult.cues;

  // FMovies/subs from video.textTracks are already perfectly synced with the player
  // Skip any timing adjustments for these sources
  const isSyncedSource = source === "fmovies" || source === "Wyzie" || source === "Video Track" || label === "Video Track";
  
  if (isSyncedSource) {
    // Trust the timestamps as-is - they're already in the video's timeline
    console.log(
      `[FFProfanity] Using synced source '${source}': ${finalCues.length} cues, ` +
      `range: ${finalCues[0]?.startMs}ms - ${finalCues[finalCues.length-1]?.endMs}ms`
    );
    // Reset previousFirstCueMs to prevent cross-source contamination
    previousFirstCueMs = null;
  } else {
    // TIMING ANALYSIS for streaming sources (PlutoTV, etc.):
    // - VTT timestamps are already in the content's native timeline (movie for VOD, broadcast for live)
    // - The mtp parameter indicates HLS playlist position, NOT a timeline offset to add
    // - For Live TV with short segments + broadcast-absolute timestamps: convert to segment-relative
    // - For VOD: timestamps are already correct in movie timeline, no offset needed

    // Detect Live TV from streamType OR from video characteristics
    // Live TV segments are short (~30s) with broadcast-absolute timestamps (>> video duration)
    let isLiveTV = streamType === "live";
    const firstCueMs = rawResult.cues[0]?.startMs || 0;
    const videoDurationMs = videoElement ? videoElement.duration * 1000 : 0;

    // Detect broadcast-absolute timestamps by tracking firstCue across segments
    // Broadcast-absolute: firstCue INCREASES across segments (6s → 11s → 14s → 18s...)
    // Segment-relative: firstCue RESETS to ~0 each segment (0s → 0s → 0s...)
    const isIncreasingTimestamps =
      previousFirstCueMs !== null && firstCueMs > previousFirstCueMs;
    previousFirstCueMs = firstCueMs;

    // Fallback: Detect Live TV when streamType is missing but video characteristics indicate live TV
    // Live TV: short video segments (< 60s) with broadcast-absolute timestamps (>> video duration)
    // VOD: longer video (> 60s) with movie timeline timestamps
    // Broadcast-absolute detection: firstCue > 30s OR firstCue increasing across segments
    const isBroadcastAbsolute =
      (firstCueMs > 30000 &&
        firstCueMs > videoDurationMs * 2 &&
        videoDurationMs > 0) ||
      isIncreasingTimestamps;
    const isShortVideo = videoDurationMs > 0 && videoDurationMs < 60000;

    if (
      !isLiveTV &&
      streamType === undefined &&
      isShortVideo &&
      isBroadcastAbsolute
    ) {
      isLiveTV = true;
      console.log(
        `[FFProfanity] Detected Live TV: short video (${videoDurationMs}ms) with broadcast timestamps (${firstCueMs}ms)${isIncreasingTimestamps ? " [increasing pattern]" : ""}`,
      );
    }

    if (isLiveTV && rawResult.timestampMap) {
      // Live TV: Check if timestamps are broadcast-absolute (firstCue >> videoDuration)
      if (isBroadcastAbsolute) {
        // Broadcast-absolute timestamps: firstCue is time into original program (e.g., 6:09 = 369517ms)
        // For Live TV, video position represents current playback in the circular buffer
        // Map subtitles to current playback position: offset = videoPos - firstCue
        const videoPosMs = videoElement
          ? Math.round(videoElement.currentTime * 1000)
          : 0;
        const offset = videoPosMs - firstCueMs;
        finalCues = rawResult.cues.map((cue) => ({
          ...cue,
          startMs: cue.startMs + offset,
          endMs: cue.endMs + offset,
        }));
        console.log(
          `[FFProfanity] Live TV: Broadcast-absolute offset=${offset}ms. ` +
            `firstCue=${firstCueMs}ms, videoPos=${videoPosMs}ms, ` +
            `Cue range: ${finalCues[0]?.startMs}ms -> ${finalCues[finalCues.length - 1]?.endMs}ms`,
        );
      } else {
        // Segment-relative timestamps: VTT starts at 0-10s within the segment
        // Use mtp (media time position) from URL to align with video timeline
        const mtpMs = segmentLoadTimeMs || 0;
        if (mtpMs > 0) {
          // mtp indicates where this segment should start in the video
          finalCues = rawResult.cues.map((cue) => ({
            ...cue,
            startMs: cue.startMs + mtpMs,
            endMs: cue.endMs + mtpMs,
          }));
          console.log(
            `[FFProfanity] Live TV: Segment-relative + mtp offset. ` +
              `mtp=${mtpMs}ms, firstCue=${firstCueMs}ms. ` +
              `Cue range: ${finalCues[0]?.startMs}ms -> ${finalCues[finalCues.length - 1]?.endMs}ms`,
          );
        } else {
          // No mtp available - fall back to video position
          const videoPosMs = videoElement
            ? Math.round(videoElement.currentTime * 1000)
            : 0;
          // Only apply offset if timestamps would make sense relative to video position
          // This handles cases where segments arrive ahead of playback
          if (firstCueMs > videoPosMs + 5000) {
            // Timestamps are ahead of video - wait for video to catch up
            console.log(
              `[FFProfanity] Live TV: Segment timestamps ahead of video. ` +
                `firstCue=${firstCueMs}ms, videoPos=${videoPosMs}ms - no offset applied`,
            );
          } else {
            console.log(
              `[FFProfanity] Live TV: Segment timestamps already aligned. ` +
                `firstCue=${firstCueMs}ms, videoPos=${videoPosMs}ms`,
            );
          }
        }
      }
    } else {
      // VOD: Timestamps are already in movie timeline, use directly
      // mtp is NOT a timeline offset - it's the HLS playlist position
      if (rawResult.timestampMap) {
        console.log(
          `[FFProfanity] VOD: Using movie timeline timestamps directly (no offset). ` +
            `firstCue=${firstCueMs}ms, mtp=${segmentLoadTimeMs}ms (ignored)}`,
        );
      }
    }
  } // end else (not syncedSource)
  console.log(
    `[FFProfanity] Parsed ${finalCues.length} cues from ${source} (${language})`,
  );

  const trackId = `content-${Date.now()}`;

  // Tag cues with source for deduplication logic
  const taggedCues = finalCues.map(cue => ({
    ...cue,
    source: source
  }));

  processCues(taggedCues);

  currentTrack = {
    id: trackId,
    url: "",
    label: label || language || "Detected",
    language: language || "en",
    isSDH: false,
    isDefault: true,
    embedded: false,
    source: source as "video" | "network" | "user",
    recommendScore: 10,
  };

  detectedTracks = [currentTrack];

  console.log(
    `[FFProfanity] Loaded subtitle track: ${currentTrack.label} (${finalCues.length} cues)`,
  );
}

/**
 * Auto-select the best detected track
 */
async function autoSelectBestTrack(): Promise<void> {
  if (detectedTracks.length === 0) return;

  const selection = selectBestTrack(detectedTracks, settings);
  console.log("[FFProfanity] Auto-selecting track:", selection.track?.label);

  if (selection.track) {
    await selectTrack(selection.track);
  }
}

/**
 * Scan for subtitle tracks on the page
 */
let lastScanTime = 0;
const SCAN_THROTTLE_MS = 2000; // Only log once per 2 seconds

async function scanForTracks(): Promise<void> {
  const now = Date.now();
  const shouldLog = now - lastScanTime > SCAN_THROTTLE_MS;
  lastScanTime = now;

  if (shouldLog) {
    console.log("[FFProfanity] Scanning for subtitle tracks...");
  }

  // Get tracks from video elements
  const videoTracks = scanPageForTracks();

  // Get tracks from page scripts
  const scriptTracks = extractFromPageScripts();

  // Combine all detected tracks
  const allTracks = [...videoTracks, ...scriptTracks];

  if (allTracks.length > 0) {
    if (shouldLog) {
      console.log("[FFProfanity] Found tracks:", allTracks.length);
    }
    addDetectedTracks(allTracks);
  }

  // Request any tracks detected by background script
  try {
    const response = await browser.runtime.sendMessage({
      type: "getDetectedTracks",
    });
    if (response?.tracks?.length > 0) {
      if (shouldLog) {
        console.log(
          "[FFProfanity] Background-detected tracks:",
          response.tracks.length,
        );
      }
      addDetectedTracks(response.tracks);
    }
  } catch (err) {
    // Background not ready, silently ignore
  }
}

/**
 * Add detected tracks and auto-select best one
 */
function addDetectedTracks(tracks: SubtitleTrack[]): void {
  // Filter out duplicates
  const newTracks = tracks.filter(
    (track) =>
      !detectedTracks.some((t) => t.url === track.url || t.id === track.id),
  );

  if (newTracks.length === 0) return;

  detectedTracks.push(...newTracks);

  // Note: tracks are in-memory only - not persisted

  // If no current track, auto-select best one
  if (!currentTrack && detectedTracks.length > 0) {
    const selection = selectBestTrack(detectedTracks, settings);

    if (selection.track && selection.autoSelected) {
      selectTrack(selection.track);
      showNotification("success", "", true);
    }
  }

  // Notify popup of new tracks
  browser.runtime
    .sendMessage({
      type: "tracksUpdated",
      tracks: detectedTracks,
      currentTrack,
    })
    .catch(() => {
      // Popup may not be open, ignore
    });
}

/**
 * Select and load a subtitle track
 */
async function selectTrack(track: SubtitleTrack): Promise<void> {
  console.log(
    `[FFProfanity] Selecting track: ${track.label} (${track.language}) from ${track.source}`,
  );
  console.log(`[FFProfanity] Track URL: ${track.url?.substring(0, 100)}...`);

  if (!track.url && !track.embedded) {
    console.warn("[FFProfanity] Track has no URL and is not embedded");
    return;
  }

  currentTrack = track;

  // Note: track selection is in-memory only - not persisted

  // If track has URL, fetch it
  if (track.url) {
    try {
      console.log(`[FFProfanity] Fetching subtitle URL: ${track.url}`);
      const response = await fetch(track.url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const content = await response.text();
      console.log(
        `[FFProfanity] Received ${content.length} bytes from subtitle URL`,
      );
      console.log(
        `[FFProfanity] Content preview: ${content.substring(0, 200)}...`,
      );

      await handleSubtitleUpload(content, track.label);
    } catch (error) {
      console.error("[FFProfanity] Failed to fetch subtitle track:", error);
      showNotification(
        "error",
        `Failed to load subtitles: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  } else if (track.embedded && videoElement) {
    // For embedded tracks, we need to read from textTracks API
    const textTrack = videoElement.textTracks[0];
    if (textTrack) {
      // Convert TextTrack cues to our format
      const cues = Array.from(textTrack.cues || []).map((cue, index) => {
        const vtCue = cue as VTTCue;
        return {
          id: index,
          startMs: vtCue.startTime * 1000,
          endMs: vtCue.endTime * 1000,
          text: vtCue.text || "",
          censoredText: "",
          hasProfanity: false,
          profanityScore: 0,
          profanityMatches: [],
        };
      });

      processCues(cues);
    }
  }
}

/**
 * Show notification overlay
 */
function showNotification(
  type: "success" | "error" | "info",
  message: string,
  autoSelected = false,
): void {
  if (!overlayContainer) return;

  // Remove existing notification
  if (notificationEl) {
    notificationEl.remove();
  }

  notificationEl = document.createElement("div");
  notificationEl.className = "ffprofanity-notification";

  let content = "";
  if (autoSelected && currentTrack) {
    content = `✓ Loaded: ${formatTrackLabel(currentTrack)} (auto-detected)`;
  } else {
    content = message;
  }

  notificationEl.innerHTML = `
    <div class="ffprofanity-notification-content">
      <span class="ffprofanity-notification-icon">${type === "success" ? "✓" : type === "error" ? "✗" : "ℹ"}</span>
      <span class="ffprofanity-notification-text">${content}</span>
      ${autoSelected ? `<button class="ffprofanity-notification-change">Change</button>` : ""}
    </div>
  `;

  overlayContainer.appendChild(notificationEl);

  // Auto-hide after 3 seconds
  setTimeout(() => {
    if (notificationEl) {
      notificationEl.classList.add("ffprofanity-notification-hidden");
      setTimeout(() => notificationEl?.remove(), 300);
    }
  }, 3000);

  // Change button click handler
  const changeBtn = notificationEl.querySelector(
    ".ffprofanity-notification-change",
  );
  if (changeBtn) {
    changeBtn.addEventListener("click", () => {
      browser.runtime.sendMessage({ type: "openTrackSelector" });
    });
  }
}

/**
 * Find video element on page with retry logic
 * Uses polling + mutation observer for dynamic video players
 */
function findVideoElement(): void {
  console.log("[FFProfanity] Looking for video element...");

  // First, try immediate search
  const videos = document.querySelectorAll("video");
  if (videos.length > 0) {
    console.log("[FFProfanity] Found video immediately:", videos.length);
    videoElement = videos[0] as HTMLVideoElement;
    attachVideoListeners(videoElement);
    return;
  }

  // Poll for video element (streaming sites load dynamically)
  // Use longer timeout for iframe scenarios where player takes time to initialize
  let pollAttempts = 0;
  const maxPollAttempts = 120; // Poll for up to 60 seconds (for slow iframe players)
  const pollInterval = 500;

  const pollTimer = setInterval(() => {
    pollAttempts++;
    const videos = document.querySelectorAll("video");

    if (videos.length > 0) {
      console.log(`[FFProfanity] Found video after ${pollAttempts} polls`);
      clearInterval(pollTimer);
      videoElement = videos[0] as HTMLVideoElement;
      attachVideoListeners(videoElement);
      
      // Find time display element for sites like fmovies where video.currentTime is unreliable
      findTimeDisplayElement();

      // Start monitoring if we have cues and video found
      // Check !animationFrameId to avoid starting duplicate loops
      if (cues.length > 0 && !animationFrameId) {
        console.log("[FFProfanity] Video found with cues ready, starting monitoring");
        isActive = true;
        startMonitoring();
      }
    } else if (pollAttempts >= maxPollAttempts) {
      console.log("[FFProfanity] No video found after max polls, stopping");
      clearInterval(pollTimer);
    }
  }, pollInterval);

  // Also observe for new video elements (for SPA navigation)
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of Array.from(mutation.addedNodes)) {
        // Check if the added node is a video or contains a video
        if (node instanceof HTMLVideoElement) {
          console.log("[FFProfanity] Video element added via mutation");
          videoElement = node;
          attachVideoListeners(videoElement);
          // Start monitoring if we have cues ready
          if (cues.length > 0 && !animationFrameId) {
            console.log("[FFProfanity] Video mutation found with cues ready, starting monitoring");
            isActive = true;
            startMonitoring();
          }
        } else if (node instanceof HTMLElement) {
          // Check descendants for video
          const nestedVideos = Array.from(node.querySelectorAll("video"));
          if (nestedVideos.length > 0) {
            console.log("[FFProfanity] Video found in added subtree");
            videoElement = nestedVideos[0];
            attachVideoListeners(videoElement);
            // Start monitoring if we have cues ready
            if (cues.length > 0 && !animationFrameId) {
              console.log("[FFProfanity] Video subtree found with cues ready, starting monitoring");
              isActive = true;
              startMonitoring();
            }
          }
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
  console.log("[FFProfanity] Mutation observer attached");
}

/**
 * Attach event listeners to video element
 */
function attachVideoListeners(video: HTMLVideoElement): void {
  // Handle seek events - check if we landed in profanity
  video.addEventListener("seeked", handleVideoSeeked);

  // Handle playback rate changes
  video.addEventListener("ratechange", handleRateChange);

  // Handle play/pause for state tracking
  video.addEventListener("play", () => {
    if (cues.length > 0) {
      isActive = true;
      startMonitoring();
    }
  });

  video.addEventListener("pause", () => {
    // Don't stop monitoring on pause, just let the loop continue
    // This ensures we're ready when playback resumes
  });
}

/**
 * Find the time display element on the page
 * For sites like fmovies, the video.currentTime is affected by hover preview,
 * so we look for the displayed time element which shows the actual playback position
 */
function findTimeDisplayElement(): void {
  // Look for elements that display time in MM:SS or HH:MM:SS format
  // fmovies has: current time (left) and duration (right) in the player controls
  // We want the current time which updates during playback
  
  const timePattern = /^\d{1,3}:\d{2}$/;
  const candidates: Array<{ element: HTMLElement; position: number }> = [];
  
  // Find all elements with time-like text content
  const allElements = document.querySelectorAll('span, div, p');
  for (const el of Array.from(allElements)) {
    const text = el.textContent?.trim() || '';
    if (timePattern.test(text)) {
      const rect = el.getBoundingClientRect();
      // Get the element's horizontal position - current time is typically on the LEFT
      // Duration/total time is typically on the RIGHT
      if (rect.width > 0 && rect.height > 0) {
        candidates.push({
          element: el as HTMLElement,
          position: rect.left // Lower value = more left = more likely to be current time
        });
      }
    }
  }
  
  if (candidates.length === 0) {
    console.log('[FFProfanity] No time display elements found');
    return;
  }
  
  // Sort by position - leftmost is likely current time
  candidates.sort((a, b) => a.position - b.position);
  
  // Take the leftmost as current time, second-leftmost as duration
  timeDisplayElement = candidates[0].element;
  console.log(`[FFProfanity] Found time display element: "${candidates[0].element.textContent?.trim()}" (${candidates.length} candidates, using leftmost)`);
}

/**
 * Parse time string (MM:SS or HH:MM:SS) to milliseconds
 */
function parseTimeString(timeStr: string): number | null {
  const parts = timeStr.split(':').map(p => parseInt(p, 10));
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
    return (parts[0] * 60 + parts[1]) * 1000;
  }
  if (parts.length === 3 && !isNaN(parts[0]) && !isNaN(parts[1]) && !isNaN(parts[2])) {
    return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  }
  return null;
}

/**
 * Get current playback time in milliseconds
 * Uses time display element if available AND visible (for sites like fmovies),
 * otherwise falls back to video.currentTime with hover preview detection
 */
function getCurrentTimeMs(): { timeMs: number; source: string } {
  // Periodically re-find the time display element (controls might get re-created)
  if (!timeDisplayElement || !timeDisplayElement.isConnected) {
    findTimeDisplayElement();
  }
  
  const now = performance.now();
  
  // Try time display element first (for sites like fmovies where video.currentTime is unreliable)
  if (timeDisplayElement && timeDisplayElement.isConnected) {
    // Check if element is visible (not hidden by player controls auto-hide)
    const rect = timeDisplayElement.getBoundingClientRect();
    const style = window.getComputedStyle(timeDisplayElement);
    const isVisible = style.display !== 'none' && 
                      style.visibility !== 'hidden' && 
                      parseFloat(style.opacity) > 0 &&
                      rect.width > 0 && rect.height > 0;
    
    const timeStr = timeDisplayElement.textContent?.trim() || '';
    const timeMs = parseTimeString(timeStr);
    
    if (isVisible && timeMs !== null && timeMs >= 0) {
      // Validate: if video has a currentTime > 0 and display shows 0, display is wrong
      // (happens when player reinitializes but display hasn't updated)
      const videoTime = videoElement ? videoElement.currentTime * 1000 : 0;
      if (videoTime > 5000 && timeMs < 1000 && lastKnownTimeMs > 5000) {
        // Display shows 0 but we have higher cached value - use cached estimation
        // This happens when video element gets replaced but display element shows stale 00:00
        const elapsedMs = (now - lastKnownTimeTimestamp);
        const estimatedTimeMs = lastKnownTimeMs + (elapsedMs * playbackRate);
        return { timeMs: Math.min(estimatedTimeMs, lastKnownTimeMs + 10000), source: 'estimated' }; // Cap at +10s
      }
      
      // Cache the last known good time with timestamp
      lastKnownTimeMs = timeMs;
      lastKnownTimeTimestamp = now;
      return { timeMs, source: 'display' };
    }
  }
  
  // If display element is hidden, estimate time from last known position
  // This works when controls auto-hide during playback
  if (lastKnownTimeMs > 0 && videoElement && !videoElement.paused && lastKnownTimeTimestamp > 0) {
    // Estimate: last known time + (elapsed wall-clock time × playback rate)
    const elapsedMs = (now - lastKnownTimeTimestamp); // wall-clock ms since last reading
    const estimatedTimeMs = lastKnownTimeMs + (elapsedMs * playbackRate);
    
    // Sanity check: don't estimate beyond video duration
    const durationMs = (videoElement.duration || 0) * 1000;
    if (durationMs > 0 && estimatedTimeMs > durationMs) {
      return { timeMs: durationMs, source: 'estimated' };
    }
    
    return { timeMs: estimatedTimeMs, source: 'estimated' };
  }
  
  // Fallback to video.currentTime (affected by hover previews on some sites)
  if (videoElement) {
    return { timeMs: videoElement.currentTime * 1000, source: 'video' };
  }
  
  return { timeMs: 0, source: 'none' };
}

/**
 * Handle seek events - immediately mute if landing in profanity
 * Note: Do NOT clear cues on seek for static VOD content (SRT/VTT files)
 * Cue clearing is only needed for live HLS segments that need timing recalculation
 */
function handleVideoSeeked(): void {
  if (!videoElement || !isActive || cues.length === 0) return;

  const currentTimeMs = videoElement.currentTime * 1000;
  const profanityCue = cueIndex.findProfanityCue(
    currentTimeMs,
    settings.offsetMs,
  );

  // Debug: show seek info
  const profanityCount = cues.filter((c) => c.hasProfanity).length;
  console.log(
    `[FFProfanity] SEEK to ${videoElement.currentTime.toFixed(2)}s (${currentTimeMs}ms), offset: ${settings.offsetMs}ms, total cues: ${cues.length}, profanity cues: ${profanityCount}`,
  );

  if (profanityCue && !isMuted) {
    // Seeking into profanity - mute immediately
    console.log(
      `[FFProfanity] SEEK landed in profanity cue ${profanityCue.id}, muting`,
    );
    sendMuteNow();
    currentProfanityCue = profanityCue;
  } else if (!profanityCue && isMuted) {
    // Seeking out of profanity - unmute
    sendUnmuteNow();
    currentProfanityCue = null;
  }
}

/**
 * Handle playback rate changes
 */
function handleRateChange(): void {
  if (!videoElement) return;
  playbackRate = videoElement.playbackRate;
  // Note: The RAF loop already uses video.currentTime which accounts for playback rate
  // No additional calculation needed, just tracking the rate for potential future use
}

/**
 * Create subtitle overlay
 */
function createOverlay(): void {
  // Check if overlay already exists
  if (overlayContainer) return;

  overlayContainer = document.createElement("div");
  overlayContainer.id = "ffprofanity-overlay";
  overlayContainer.className = "ffprofanity-overlay";
  overlayContainer.innerHTML = `
    <style>
      .ffprofanity-overlay {
        position: fixed;
        left: 50%;
        bottom: 15%;
        transform: translateX(-50%);
        z-index: 2147483647 !important;
        font-family: Arial, Helvetica, sans-serif;
        text-align: center;
        pointer-events: none;
        isolation: isolate;
      }
      .ffprofanity-cue {
        padding: 8px 16px;
        border-radius: 4px;
        text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.8);
        max-width: 80vw;
        line-height: 1.4;
        animation: fadeIn 0.2s ease-out;
        background: rgba(0, 0, 0, 0.7);
        color: #ffffff;
      }
      .ffprofanity-hidden {
        opacity: 0;
        animation: fadeOut 0.2s ease-out;
      }
      .ffprofanity-next-cues {
        margin-top: 8px;
        font-size: 12px;
        color: rgba(255, 255, 255, 0.7);
      }
      .ffprofanity-preview {
        font-size: 14px;
        color: rgba(255, 255, 255, 0.9);
        margin: 4px 0;
        padding: 4px 8px;
        border-radius: 3px;
      }
      .ffprofanity-notification {
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 2147483647;
        pointer-events: auto;
        animation: slideIn 0.3s ease-out;
      }
      .ffprofanity-notification-content {
        background: rgba(0, 0, 0, 0.9);
        color: #ffffff;
        padding: 12px 16px;
        border-radius: 8px;
        font-size: 14px;
        display: flex;
        align-items: center;
        gap: 8px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      }
      .ffprofanity-notification-icon {
        font-size: 16px;
      }
      .ffprofanity-notification-text {
        text-shadow: none;
      }
      .ffprofanity-notification-change {
        background: #4a9eff;
        color: white;
        border: none;
        padding: 4px 8px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
        pointer-events: auto;
      }
      .ffprofanity-notification-change:hover {
        background: #3a8eef;
      }
      .ffprofanity-notification-hidden {
        animation: slideOut 0.3s ease-out forwards;
      }
      @keyframes fadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @keyframes fadeOut {
        from { opacity: 1; }
        to { opacity: 0; }
      }
      @keyframes slideIn {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
      @keyframes slideOut {
        from { transform: translateX(0); opacity: 1; }
        to { transform: translateX(100%); opacity: 0; }
      }
    </style>
  `;

  currentCueEl = document.createElement("div");
  currentCueEl.className = "ffprofanity-cue";
  currentCueEl.style.display = "none";

  nextCuesEl = document.createElement("div");
  nextCuesEl.className = "ffprofanity-next-cues";

  overlayContainer.appendChild(currentCueEl);
  overlayContainer.appendChild(nextCuesEl);
  document.body.appendChild(overlayContainer);

  // Handle fullscreen changes - move overlay into fullscreen element
  document.addEventListener("fullscreenchange", handleFullscreenChange);
  document.addEventListener("webkitfullscreenchange", handleFullscreenChange);

  // Apply initial display settings
  applyDisplaySettings();
}

/**
 * Handle fullscreen changes - move overlay into fullscreen element
 */
function handleFullscreenChange(): void {
  if (!overlayContainer) return;

  const fullscreenElement =
    document.fullscreenElement || (document as any).webkitFullscreenElement;

  if (fullscreenElement) {
    // Move overlay into fullscreen element
    fullscreenElement.appendChild(overlayContainer);
    console.log("[FFProfanity] Moved overlay into fullscreen element");
  } else {
    // Move overlay back to body
    document.body.appendChild(overlayContainer);
    console.log("[FFProfanity] Moved overlay back to body");
  }
}

/**
 * Apply display settings (font size, color, position, etc.)
 */
function applyDisplaySettings(): void {
  if (!overlayContainer || !currentCueEl || !nextCuesEl) return;

  // Font size mapping
  const fontSizes: Record<string, string> = {
    small: "16px",
    medium: "20px",
    large: "26px",
    xlarge: "32px",
  };

  // Position mapping
  const positions: Record<string, string> = {
    bottom: "80px",
    middle: "50%",
    top: "80px",
  };

  // Apply position
  overlayContainer.style.bottom = positions[settings.position] || "80px";
  if (settings.position === "middle") {
    overlayContainer.style.top = "50%";
    overlayContainer.style.bottom = "auto";
    overlayContainer.style.transform = "translateX(-50%) translateY(-50%)";
  } else if (settings.position === "top") {
    overlayContainer.style.top = positions.top;
    overlayContainer.style.bottom = "auto";
    overlayContainer.style.transform = "translateX(-50%)";
  } else {
    overlayContainer.style.bottom = positions.bottom;
    overlayContainer.style.top = "auto";
    overlayContainer.style.transform = "translateX(-50%)";
  }

  // Parse background opacity (0-100 -> 0-1)
  const bgOpacity = (settings.backgroundOpacity ?? 80) / 100;

  // Apply styles to current cue
  currentCueEl.style.fontSize = fontSizes[settings.fontSize] || "20px";
  currentCueEl.style.color = settings.fontColor || "#ffffff";

  // Parse background color and apply with opacity
  const bgColor = settings.backgroundColor || "#000000";
  const bgR = parseInt(bgColor.slice(1, 3), 16);
  const bgG = parseInt(bgColor.slice(3, 5), 16);
  const bgB = parseInt(bgColor.slice(5, 7), 16);
  currentCueEl.style.background = `rgba(${bgR}, ${bgG}, ${bgB}, ${bgOpacity})`;

  // Apply upcoming cues visibility
  nextCuesEl.style.display = settings.showUpcomingCues ? "block" : "none";
}

/**
 * Handle storage change events
 */
function handleStorageChange(
  changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
  _areaName: string,
): void {
  console.log("[FFProfanity] Storage change detected:", changes);
  if (changes.settings) {
    const oldSettings = settings;
    const newSettings = changes.settings.newValue as Partial<Settings>;
    console.log("[FFProfanity] Settings changed:", {
      old: oldSettings,
      new: newSettings,
    });
    settings = { ...settings, ...newSettings };

    // Recreate detector with new settings
    const newDetectorConfig: Partial<
      import("../lib/detector").ProfanityConfig
    > = {
      ...settings,
      customSubstitutions: settings.customSubstitutions
        ? new Map(Object.entries(settings.customSubstitutions))
        : undefined,
    };
    detector = createDetector(newDetectorConfig);

    // Apply substitution settings
    if (settings.useSubstitutions) {
      detector.setSubstitutions(true, settings.substitutionCategory);
      if (
        settings.customSubstitutions &&
        Object.keys(settings.customSubstitutions).length > 0
      ) {
        detector.setCustomSubstitutions(
          new Map(Object.entries(settings.customSubstitutions)),
        );
      }
    }

    // Re-compute profanity windows if sensitivity changed
    if (oldSettings.sensitivity !== settings.sensitivity) {
      console.log(
        `[FFProfanity] Sensitivity changed from ${oldSettings.sensitivity} to ${settings.sensitivity}, re-computing windows`,
      );
      for (const cue of cues) {
        if (cue.hasProfanity && cue.profanityMatches.length > 0) {
          cue.profanityWindows = computeProfanityWindows(
            cue.id,
            cue.startMs,
            cue.endMs,
            cue.text,
            cue.profanityMatches,
            settings.sensitivity,
          );
        }
      }
      // Rebuild index with updated cues
      cueIndex.build(cues);
    }

    // Re-process censored text if substitution settings changed
    if (
      oldSettings.useSubstitutions !== settings.useSubstitutions ||
      oldSettings.substitutionCategory !== settings.substitutionCategory
    ) {
      console.log(
        `[FFProfanity] Substitution settings changed from ${oldSettings.useSubstitutions}/${oldSettings.substitutionCategory} to ${settings.useSubstitutions}/${settings.substitutionCategory}, re-processing cue text`,
      );
      console.log(
        `[FFProfanity] Detector useSubstitutions:`,
        detector["useSubstitutions"],
      );
      for (const cue of cues) {
        if (cue.hasProfanity && cue.profanityMatches.length > 0) {
          const detection = detector.detect(cue.text);
          cue.censoredText = detection.censoredText;
          console.log(
            `[FFProfanity] Re-processed cue ${cue.id}: "${cue.text.substring(0, 30)}..." -> "${cue.censoredText.substring(0, 30)}..."`,
          );
        }
      }
    }

    // Apply display settings if any changed
    if (
      oldSettings.fontSize !== settings.fontSize ||
      oldSettings.fontColor !== settings.fontColor ||
      oldSettings.backgroundColor !== settings.backgroundColor ||
      oldSettings.position !== settings.position ||
      oldSettings.backgroundOpacity !== settings.backgroundOpacity ||
      oldSettings.showUpcomingCues !== settings.showUpcomingCues ||
      oldSettings.upcomingCuesCount !== settings.upcomingCuesCount
    ) {
      applyDisplaySettings();
    }

    // Handle enabled/disabled state change
    if (oldSettings.enabled !== settings.enabled) {
      if (settings.enabled && !isActive) {
        isActive = true;
        startMonitoring();
      } else if (!settings.enabled && isActive) {
        isActive = false;
        stopMonitoring();
      }
    }
  }
}

/**
 * Handle messages from background and popup
 */
function handleMessage(message: unknown): Promise<unknown> {
  if (!message || typeof message !== "object") return Promise.resolve();

  const msg = message as Record<string, unknown>;

  switch (msg.type) {
    case "uploadCues":
      const content = msg.content as string;
      const filename = msg.filename as string | undefined;
      handleSubtitleUpload(content, filename);
      break;

    case "updateOffset":
      const offset = msg.offsetMs as number;
      if (typeof offset === "number") {
        settings.offsetMs = offset;
        storage.setSetting("offsetMs", offset);
      }
      break;

    case "updateSettings":
      // Settings updated from options page
      console.log(
        "[FFProfanity] Received updateSettings message:",
        msg.settings,
      );
      if (msg.settings) {
        handleStorageChange({ settings: { newValue: msg.settings } }, "local");
      }
      break;

    case "enable":
      isActive = true;
      startMonitoring();
      break;

    case "disable":
      isActive = false;
      stopMonitoring();
      break;

    case "getStatus":
      return Promise.resolve({
        active: isActive,
        cueCount: cues.length,
        profanityCount: cues.filter((c) => c.hasProfanity).length,
        hasVideo: !!videoElement,
        currentTrack,
        detectedTracks,
      });

    case "trackDetected":
      // New track detected by background script
      if (msg.track) {
        addDetectedTracks([msg.track as SubtitleTrack]);
      }
      break;

    case "selectTrack":
      // User selected a track from popup
      if (msg.trackId) {
        const track = detectedTracks.find((t) => t.id === msg.trackId);
        if (track) {
          selectTrack(track);
        }
      }
      break;

    case "getTracks":
      // Return available tracks to popup
      return Promise.resolve({
        type: "tracks",
        tracks: detectedTracks,
        currentTrack,
      });
  }

  return Promise.resolve();
}

/**
 * Handle uploaded subtitle file
 */
async function handleSubtitleUpload(
  content: string,
  filename?: string,
): Promise<void> {
  console.log(
    `[FFProfanity] Parsing subtitle content (${content.length} bytes)`,
  );

  const result = parseSubtitle(content);

  console.log(
    `[FFProfanity] Detected format: ${result.format}, cues: ${result.cues.length}, errors: ${result.errors.length}`,
  );

  if (result.errors.length > 0) {
    console.error("[FFProfanity] Parse errors:", result.errors);
    showNotification("error", result.errors.join("; "));
    return;
  }

  if (result.cues.length === 0) {
    console.error("[FFProfanity] No cues found in subtitle content");
    showNotification("error", "No subtitles found in file");
    return;
  }

  // For uploaded subtitle files, use cues as-is (VOD/static content)
  // Live TV timing offsets are only applied in handleSubtitleContent()
  // for intercepted PlutoTV segments which have context (streamType, segmentLoadTimeMs)
  processCues(result.cues);
  // Note: cues are NOT saved to storage - per-session only

  // Create a track entry for user uploads
  const userTrack: SubtitleTrack = {
    id: `user-upload-${Date.now()}`,
    label: filename || "Uploaded subtitles",
    language: "unknown",
    isSDH: false,
    isDefault: true,
    source: "user",
    embedded: false,
    recommendScore: 10, // User uploads should be preferred
  };

  // Set as current track (in-memory only)
  if (!detectedTracks.some((t) => t.id === userTrack.id)) {
    detectedTracks.push(userTrack);
  }
  currentTrack = userTrack;

  console.log(
    `[FFProfanity] Created track for uploaded file: ${userTrack.label}`,
  );
}

/**
 * Process cues with profanity detection
 * For HLS streams, accumulate cues from multiple segments instead of replacing
 */
function processCues(newCues: Cue[]): void {
  console.log(
    `[FFProfanity] Processing ${newCues.length} new cues, existing: ${cues.length}`,
  );

  // Process new cues for profanity
  const processedNewCues = newCues.map((cue) => {
    const detection = detector.detect(cue.text);

    if (cue.text.toLowerCase().includes("bullshit")) {
      console.log(`[FFProfanity] DEBUG bullshit cue ${cue.id}:`, {
        text: cue.text,
        hasProfanity: detection.hasProfanity,
        score: detection.score,
        matches: detection.matches,
        censoredText: detection.censoredText,
      });
    }

    const processedCue: Cue = {
      ...cue,
      censoredText: detection.censoredText,
      hasProfanity: detection.hasProfanity,
      profanityScore: detection.score,
      profanityMatches: detection.matches,
    };

    if (detection.hasProfanity && settings.sensitivity !== "high") {
      processedCue.profanityWindows = computeProfanityWindows(
        cue.id,
        cue.startMs,
        cue.endMs,
        cue.text,
        detection.matches,
        settings.sensitivity,
      );
    }

    return processedCue;
  });

  // For VOD sources (fmovies, etc.), detect if this is a replacement rather than incremental
  // If new cues have similar timing range to existing, replace instead of accumulate
  const firstCueSource = newCues[0]?.source || '';
  const isSyncedSource = firstCueSource === 'fmovies' || 
                         firstCueSource === 'wyzie';
  
  if (isSyncedSource && cues.length > 0 && processedNewCues.length > 100) {
    // Check timing overlap: if ranges overlap significantly, this is likely a replacement
    const existingStart = cues[0]?.startMs || 0;
    const existingEnd = cues[cues.length - 1]?.endMs || 0;
    const newStart = processedNewCues[0]?.startMs || 0;
    const newEnd = processedNewCues[processedNewCues.length - 1]?.endMs || 0;
    
    // If timing ranges overlap by >50%, replace instead of accumulate
    const overlapStart = Math.max(existingStart, newStart);
    const overlapEnd = Math.min(existingEnd, newEnd);
    const overlapDuration = Math.max(0, overlapEnd - overlapStart);
    const existingDuration = existingEnd - existingStart;
    
    if (existingDuration > 0 && overlapDuration > existingDuration * 0.5) {
      console.log(
        `[FFProfanity] Replacing ${cues.length} cues with ${processedNewCues.length} (timing overlap detected)`
      );
      cues = processedNewCues;
    } else {
      // No significant overlap - accumulate with deduplication
      const existingKeys = new Set(cues.map((c) => `${c.startMs}:${c.text}`));
      const uniqueNewCues = processedNewCues.filter(
        (c) => !existingKeys.has(`${c.startMs}:${c.text}`),
      );
      cues = [...cues, ...uniqueNewCues];
    }
  } else {
    // Accumulate cues: merge new cues with existing, avoiding duplicates
    // Use startMs + text as unique key to prevent duplicates from overlapping segments
    const existingKeys = new Set(cues.map((c) => `${c.startMs}:${c.text}`));
    const uniqueNewCues = processedNewCues.filter(
      (c) => !existingKeys.has(`${c.startMs}:${c.text}`),
    );
    cues = [...cues, ...uniqueNewCues];
  }

  // Sort by start time
  cues.sort((a, b) => a.startMs - b.startMs);

  // For static subtitle files, keep all cues - no limit needed
  // The comment about "last 5 minutes" was incorrect; we need ALL cues
  // for VOD content to cover the entire video.
  // Memory usage is acceptable: 2000 cues ≈ 2MB.

  // Build index for fast lookup
  cueIndex.build(cues);

  // Log summary
  const profanityCues = cues.filter((c) => c.hasProfanity);
  console.log(
    `[FFProfanity] Processed ${cues.length} cues, ${profanityCues.length} with profanity`,
  );
  if (settings.sensitivity !== "high" && profanityCues.length > 0) {
    const windowCount = profanityCues.reduce(
      (sum, c) => sum + (c.profanityWindows?.length || 0),
      0,
    );
    console.log(
      `[FFProfanity] Computed ${windowCount} profanity windows for sensitivity '${settings.sensitivity}'`,
    );
  }

  // Log first few profanity cues for verification (with timestamps)
  if (profanityCues.length > 0) {
    console.log(
      `[FFProfanity] First 10 profanity cues:`,
      profanityCues.slice(0, 10).map((c) => ({
        id: c.id,
        time: `${Math.floor(c.startMs / 60000)}:${Math.floor(
          (c.startMs % 60000) / 1000,
        )
          .toString()
          .padStart(2, "0")}`,
        text: c.text.substring(0, 40),
        hasProfanity: c.hasProfanity,
        windows: c.profanityWindows?.length || 0,
      })),
    );
  }

  // Start monitoring if we have a video
  if (cues.length > 0 && videoElement) {
    console.log(
      `[FFProfanity] Starting monitoring: ${cues.length} cues, videoElement=${!!videoElement}`,
    );
    isActive = true;
    startMonitoring();
  } else {
    console.log(
      `[FFProfanity] NOT starting monitoring: cues=${cues.length}, videoElement=${!!videoElement}`,
    );
  }
}

/**
 * Start monitoring playback
 */
function startMonitoring(): void {
  if (!videoElement) {
    console.log("[FFProfanity] startMonitoring: no videoElement, returning");
    return;
  }

  // Only start if we have both video AND cues
  if (cues.length === 0) {
    console.log("[FFProfanity] startMonitoring: no cues, returning");
    return;
  }

  // Cancel any existing loop first - critical for multi-frame scenarios
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }

  console.log("[FFProfanity] startMonitoring: starting update loop");
  console.log(
    `[FFProfanity] Video state: paused=${videoElement.paused}, currentTime=${videoElement.currentTime?.toFixed(2)}, duration=${videoElement.duration?.toFixed(2)}, readyState=${videoElement.readyState}`,
  );

  const updateLoop = () => {
    // Stop if not active
    if (!isActive) {
      animationFrameId = null;
      return;
    }

    // Try to re-find video if disconnected (fmovies replaces video elements)
    if (videoElement && !videoElement.isConnected && !document.fullscreenElement?.contains(videoElement)) {
      // Video was disconnected, try to find a new one
      const newVideo = document.querySelector('video');
      if (newVideo && newVideo.isConnected) {
        console.log("[FFProfanity] Found new video element after disconnect");
        videoElement = newVideo as HTMLVideoElement;
        attachVideoListeners(videoElement);
        findTimeDisplayElement(); // Re-find time display for new video
      } else {
        // No video found, stop loop
        console.log("[FFProfanity] Video element disconnected, stopping loop");
        animationFrameId = null;
        return;
      }
    }

    // Use time display element if available (for sites like fmovies where video.currentTime is unreliable)
    // Otherwise fall back to video.currentTime
    const { timeMs: currentTimeMs, source: timeSource } = getCurrentTimeMs();

    // When using video.currentTime, detect hover preview seeks (transient jumps that quickly revert)
    // Hover preview: seek to hover position, then quickly seek back when mouse leaves
    // Legitimate seek: stays at new position (user clicked)
    // Note: This detection is only needed when falling back to video.currentTime
    const usingVideoTime = timeSource === 'video';
    const videoPaused = videoElement?.paused ?? true;

    if (usingVideoTime && !videoPaused && lastStableTimeMs > 0) {
      const frameAdvanceMs = 20 * playbackRate; // ~20ms per frame at 60fps
      const jumpThreshold = frameAdvanceMs * 3; // 3 frames worth = ~60ms, anything larger is a seek
      const actualJump = currentTimeMs - lastStableTimeMs;

      if (Math.abs(actualJump) > jumpThreshold) {
        // Large jump detected during playback - could be hover preview or legitimate seek
        // Start tracking this pending seek
        if (pendingSeekTimeMs === null) {
          pendingSeekTimeMs = currentTimeMs;
          pendingSeekFrameCount = 0;
        }
        pendingSeekFrameCount++;

        // After ~5 frames (~80ms), check if we're still at the new position
        if (pendingSeekFrameCount >= 5) {
          const timeDrift = Math.abs(currentTimeMs - (pendingSeekTimeMs || 0));
          // Still near the jumped position? It's a legitimate seek
          if (timeDrift < jumpThreshold) {
            // Legitimate seek confirmed - accept the new time
            lastStableTimeMs = currentTimeMs;
            pendingSeekTimeMs = null;
            pendingSeekFrameCount = 0;
            updatePlayback(currentTimeMs);
          }
          // Otherwise keep waiting for it to stabilize
        }
        animationFrameId = requestAnimationFrame(updateLoop);
        return;
      }

      // Check if we're recovering from a pending seek that reverted
      if (pendingSeekTimeMs !== null) {
        // Time has returned to near where it was before the jump - hover preview ended
        if (Math.abs(currentTimeMs - lastStableTimeMs) < jumpThreshold * 2) {
          // Hover preview reverted, clear pending state
          pendingSeekTimeMs = null;
          pendingSeekFrameCount = 0;
          // Continue with normal playback using lastStableTimeMs
          updatePlayback(lastStableTimeMs);
          animationFrameId = requestAnimationFrame(updateLoop);
          return;
        }
      }
    }

    // Clear pending state on normal playback (or when using display element)
    pendingSeekTimeMs = null;
    pendingSeekFrameCount = 0;

    // Time is stable - use it
    lastStableTimeMs = currentTimeMs;
    updatePlayback(currentTimeMs);
    animationFrameId = requestAnimationFrame(updateLoop);
  };

  animationFrameId = requestAnimationFrame(updateLoop);
}

/**
 * Stop monitoring playback
 */
function stopMonitoring(): void {
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
}

/**
 * Debounce function
 */
function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delay: number,
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

/**
 * Send mute message immediately (no debounce for tighter timing)
 */
function sendMuteNow(): void {
  if (isMuted) return; // Already muted

  console.log(
    `[FFProfanity] MUTE: ${currentProfanityCue ? `cue ${currentProfanityCue.id}` : "unknown"} at ${videoElement?.currentTime?.toFixed(2)}s`,
  );

  browser.runtime.sendMessage({
    type: "muteNow",
    reasonId: currentProfanityCue ? `cue-${currentProfanityCue.id}` : "unknown",
    expectedUnmuteAt: currentProfanityCue?.endMs || 0,
  });
  isMuted = true;
}

/**
 * Send unmute message immediately (no debounce for tighter timing)
 */
function sendUnmuteNow(): void {
  if (!isMuted) return; // Already unmuted

  console.log(
    `[FFProfanity] UNMUTE at ${videoElement?.currentTime?.toFixed(2)}s`,
  );

  browser.runtime.sendMessage({
    type: "unmuteNow",
  });
  isMuted = false;
}

/**
 * Update playback based on current video time
 */
function updatePlayback(currentTimeMs: number): void {
  if (!videoElement || !currentCueEl) return;

  // Find current subtitle cue and profanity status
  const currentCue = cueIndex.findActive(currentTimeMs, settings.offsetMs);

  // Debug: log periodically (every 5 seconds of video time)
  if (
    Math.floor(currentTimeMs / 5000) !== Math.floor((currentTimeMs - 16) / 5000)
  ) {
    console.log(
      `[FFProfanity] updatePlayback: time=${(currentTimeMs / 1000).toFixed(1)}s, cue=${currentCue ? currentCue.id : "none"}, isActive=${isActive}, cues=${cues.length}`,
    );
  }

  // Handle muting based on sensitivity setting
  // HIGH: mute entire cue, MEDIUM/LOW: mute only profanity word windows
  const muteState = cueIndex.getMuteState(
    currentTimeMs,
    settings.offsetMs,
    settings.sensitivity,
  );

  if (muteState.shouldMute && !isMuted) {
    // Entering a profanity zone
    currentProfanityCue = muteState.cue;
    sendMuteNow();
  } else if (!muteState.shouldMute && isMuted) {
    // Leaving the profanity zone
    sendUnmuteNow();
    currentProfanityCue = null;
  }

  // Update overlay
  if (currentCue) {
    const displayText = currentCue.hasProfanity
      ? currentCue.censoredText
      : sanitizeText(currentCue.text);

    currentCueEl.textContent = displayText;
    currentCueEl.style.display = "block";
    currentCueEl.classList.remove("ffprofanity-hidden");

    // Show next cues preview if enabled
    if (
      settings.showUpcomingCues &&
      settings.upcomingCuesCount > 0 &&
      nextCuesEl
    ) {
      const nextCues = cueIndex.getNextCues(
        currentTimeMs,
        settings.upcomingCuesCount,
        settings.offsetMs,
      );
      if (nextCues.length > 0) {
        const previews = nextCues
          .map((c) => {
            const time = formatTime(c.startMs);
            const text = c.hasProfanity ? c.censoredText : sanitizeText(c.text);
            return `<div class="ffprofanity-preview">${time}: ${text.substring(0, 50)}${text.length > 50 ? "..." : ""}</div>`;
          })
          .join("");
        nextCuesEl.innerHTML = previews;
      } else {
        nextCuesEl.innerHTML = "";
      }
    } else if (nextCuesEl) {
      nextCuesEl.innerHTML = "";
    }
  } else {
    currentCueEl.classList.add("ffprofanity-hidden");
  }
}

/**
 * Format milliseconds to readable time
 */
function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString(10).padStart(2, "0")}:${seconds.toString(10).padStart(2, "0")}`;
  }
  return `${minutes}:${seconds.toString(10).padStart(2, "0")}`;
}

/**
 * Handle file input from options page
 */
function setupFileInput(): void {
  document.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement;
    if (target.type === "file" && target.accept?.includes(".srt,.vtt,.ass")) {
      const file = target.files?.[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (e) => {
          const content = e.target?.result as string;
          handleSubtitleUpload(content);
        };
        reader.readAsText(file);
      }
    }
  });
}

// Initialize on DOM ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// Keyboard shortcuts
document.addEventListener("keydown", (event) => {
  if (event.altKey && event.key === "ArrowLeft") {
    settings.offsetMs -= 500;
    storage.setSetting("offsetMs", settings.offsetMs);
  } else if (event.altKey && event.key === "ArrowRight") {
    settings.offsetMs += 500;
    storage.setSetting("offsetMs", settings.offsetMs);
  }
});
