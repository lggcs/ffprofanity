/**
 * Content Script
 * Monitors video playback, renders subtitle overlay, and triggers mute/unmute
 */

import { log, debug, warn, error } from "../lib/logger";
import { storage } from "../lib/storage";
import { parseSubtitle, sanitizeText, ParseResult } from "../lib/parser";
import {
  ProfanityDetector,
  createDetector,
  computeProfanityWindows,
  ProfanityWindow,
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
let currentProfanityCue: Cue | null = null; // Track current profanity cue for mute state
let currentProfanityWindow: ProfanityWindow | null = null; // Track current profanity window for medium/low sensitivity
let playbackRate: number = 1.0; // Track playback speed
let isMuted: boolean = false; // Track mute state to avoid redundant messages
let originalVolume: number | null = null; // Store original volume before muting (for mobile fallback)

// When true, a user-uploaded subtitle file is active and auto-detection should be suppressed
let userUploadActive = false;

// Track last known good time to ignore hover preview seeks
let lastStableTimeMs: number = 0;
let pendingSeekTimeMs: number | null = null;
let pendingSeekFrameCount: number = 0;
let lastKnownTimeMs: number = 0; // Last known good time from display element
let lastKnownTimeTimestamp: number = 0; // When we last read a valid time (for estimation)

// Reference to time display element (for sites like fmovies where video.currentTime is unreliable)
let timeDisplayElement: HTMLElement | null = null;

// Debouncing
let unmuteTimeout: ReturnType<typeof setTimeout> | null = null;

// Track URLs that have been processed via intercepted content (avoid double-fetch)
const processedContentUrls = new Set<string>();

// Accumulate textTracks cues from HLS.js (these have correct timing)
interface TextTracksCue {
  type: string;
  source: string;
  language: string;
  label: string;
  cue: string;
  startTime: number;
  endTime: number;
  text: string;
}
const textTracksCues: TextTracksCue[] = [];

// Processing interval for textTracks cues (PlutoTV only)
let textTracksProcessTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Process accumulated textTracks cues from HLS.js (PlutoTV only)
 * These cues already have correct timing applied by HLS.js
 */
function processTextTracksCues(): void {
  if (textTracksCues.length === 0) return;

  // When a user upload is active, suppress auto-detected content
  if (userUploadActive) {
    debug(`Suppressing ${textTracksCues.length} textTracks cues because user upload is active`);
    textTracksCues.length = 0;
    return;
  }

  // Take a snapshot and clear the accumulator
  const pendingCues = [...textTracksCues];
  textTracksCues.length = 0;

  // Convert to our Cue format
  const newCues: Cue[] = pendingCues.map((tc, idx) => {
    const id = `texttrack-${Date.now()}-${idx}`;
    return {
      id,
      startMs: Math.round(tc.startTime * 1000),
      endMs: Math.round(tc.endTime * 1000),
      text: tc.text,
      source: 'plutotv-texttracks',
    };
  });

  // Deduplicate against existing cues
  const existingKeys = new Set(cues.map(c => `${c.startMs}:${c.text}`));
  const uniqueCues = newCues.filter(c => !existingKeys.has(`${c.startMs}:${c.text}`));

  if (uniqueCues.length === 0) return;

  log(`Processing ${uniqueCues.length} textTracks cues from PlutoTV (HLS.js timed)`);

  // Mark as synced source so VOD offset logic doesn't apply
  processCues(uniqueCues);
}

/**
 * Start the textTracks processing interval (call once during init)
 */
function startTextTracksProcessor(): void {
  if (textTracksProcessTimer) return;

  // Process accumulated textTracks cues every 500ms
  textTracksProcessTimer = setInterval(() => {
    processTextTracksCues();
  }, 500);
}

/**
 * Initialize the content script
 */
async function init(): Promise<void> {
  log("Content script initializing...");

  // Load settings
  settings = await storage.getSettings();
  log("Settings loaded:", {
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
  log("Video element found:", !!videoElement);

  // Create overlay
  createOverlay();
  log("Overlay created");

  // Inject script to intercept API responses on streaming sites
  injectApiInterceptor();

  // Start the textTracks processor (for PlutoTV HLS.js timed cues)
  startTextTracksProcessor();

  // Try to restore user-uploaded subtitles from a previous session/navigation.
  // This handles the case where the content script is re-injected (e.g., SPA navigation)
  // and the user's uploaded file would otherwise be lost.
  await restoreUserUpload();

  // Scan for existing subtitle tracks
  await scanForTracks();
  log("Detected tracks:", detectedTracks.length);

  // Watch for dynamically added tracks
  watchForVideoTracks((tracks) => {
    log("New tracks detected:", tracks.length);
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

  log("Content script ready");
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
      // NOTE: Duplicated from lib/language.ts - must be self-contained for injected script context
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
      // NOTE: Duplicated from lib/language.ts - must be self-contained for injected script context
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

      // Watch for CC button clicks (generic) - specific selectors to avoid false positives
      document.addEventListener('click', function(e) {
        const ccSelectors = [
          // YouTube-specific CC button
          '.ytp-subtitles-button',
          // Generic subtitle/CC buttons (more specific to avoid play/pause matches)
          'button[class*="subtitle"]:not(button[aria-label*="play"]):not(button[aria-label*="pause"])',
          'button[class*="caption"]:not(button[aria-label*="play"]):not(button[aria-label*="pause"])',
          'button[aria-label*="subtitle"]:not(button[aria-label*="play"]):not(button[aria-label*="pause"])',
          'button[aria-label*="caption"]:not(button[aria-label*="play"]):not(button[aria-label*="pause"])',
          'button[aria-label*="cc"]:not(button[aria-label*="play"]):not(button[aria-label*="pause"])',
          // Elements with cc/subtitle class (not play/pause buttons)
          '.cc-button:not([aria-label*="play"]):not([aria-label*="pause"])',
          '.subtitle-button:not([aria-label*="play"]):not([aria-label*="pause"])',
          '.caption-button:not([aria-label*="play"]):not([aria-label*="pause"])'
        ];
        const target = e.target as HTMLElement;
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
 * Handles three message types:
 * - FFPROFANITY_SUBTITLES_DETECTED: Track metadata (URL, language, label)
 * - FFPROFANITY_SUBTITLE_CONTENT: Actual subtitle content fetched in page context
 * - FFPROFANITY_SUBTITLE_CAPTURED: Content captured from intercepted network responses
 * - FFPROFANITY_SUBTITLE_CUE: Individual cue from textTracks (timed by HLS.js)
 */
function handleInterceptedMessage(event: MessageEvent): void {
  if (event.source !== window) return;

  // When a user-uploaded subtitle file is active, suppress auto-detected content
  // to prevent accumulation of detected cues alongside user-provided ones
  if (userUploadActive) {
    // Still log for debugging but skip processing
    const msgType = event.data?.type;
    if (msgType === "FFPROFANITY_SUBTITLES_DETECTED" ||
        msgType === "FFPROFANITY_SUBTITLE_CONTENT" ||
        msgType === "FFPROFANITY_SUBTITLE_CAPTURED") {
      debug(`Suppressing auto-detected subtitle (${msgType}) because user upload is active`);
    }
    // Allow FFPROFANITY_SUBTITLE_CUE through only if not from user upload context
    // TextTrack cues from HLS.js (PlutoTV) should also be suppressed
    return;
  }

  // Handle individual cues from textTracks (HLS.js timed cues)
  if (event.data?.type === "FFPROFANITY_SUBTITLE_CUE") {
    if (!videoElement) {
      // Forward to top frame if in iframe
      if (window.self !== window.top) {
        try {
          window.top?.postMessage(event.data, '*');
        } catch (e) { /* Cross-origin blocked */ }
      }
      return;
    }
    textTracksCues.push(event.data);
    return;
  }

  // Handle subtitle content captured from network interception (YouTube timedtext)
  if (event.data?.type === "FFPROFANITY_SUBTITLE_CAPTURED") {
    if (!videoElement) {
      // Forward to top frame if in iframe
      if (window.self !== window.top && event.data?.content) {
        log("Forwarding captured subtitle from iframe to top frame");
        try {
          window.top?.postMessage({
            type: "FFPROFANITY_SUBTITLE_CAPTURED",
            content: event.data.content,
            language: event.data.language,
            isAsr: event.data.isAsr,
            videoId: event.data.videoId,
            url: event.data.url
          }, '*');
        } catch (e) {
          log("Could not forward captured subtitle (cross-origin blocked)");
        }
      }
      log("Skipping captured subtitle - no video element in this frame");
      return;
    }
    const { content, language, isAsr, videoId, url } = event.data;
    log(
      `Captured timedtext content: ${content?.length || 0} bytes for ${language} (video: ${videoId})`,
    );

    if (content && content.length > 10) {
      const label = isAsr ? `${language.toUpperCase()} (Auto-generated)` : language.toUpperCase();
      handleSubtitleContent(
        content,
        language,
        label,
        "youtube-intercepted",
        videoElement ? Math.round(videoElement.currentTime * 1000) : undefined,
      );
    }
    return;
  }

  // Handle subtitle content (fetched in page context with cookies)
  if (event.data?.type === "FFPROFANITY_SUBTITLE_CONTENT") {
    // Skip if no video element - only process subtitles in frame with video
    if (!videoElement) {
      // If we're in an iframe and have content, forward to top frame
      // This handles cases where subtitle fetch happens in iframe contexts
      if (window.self !== window.top && event.data?.content) {
        log("Forwarding subtitle content from iframe to top frame");
        try {
          window.top?.postMessage({
            type: "FFPROFANITY_SUBTITLE_CONTENT",
            content: event.data.content,
            language: event.data.language,
            label: event.data.label,
            source: event.data.source,
            segmentLoadTime: event.data.segmentLoadTime,
            streamType: event.data.streamType,
            url: event.data.url
          }, '*');
        } catch (e) {
          // Cross-origin restrictions may block this
          log("Could not forward content to top frame (cross-origin blocked)");
        }
      }
      log("Skipping subtitle content - no video element in this frame");
      return;
    }
    const { content, language, label, source, segmentLoadTime, streamType, url } =
      event.data;

    // PlutoTV: Skip network-intercepted VTT content (wrong timing)
    // We use textTracks cues instead (correct timing from HLS.js)
    if (source && source.includes('plutotv')) {
      log(
        `Skipping PlutoTV network-intercepted content from ${source} (using textTracks instead)`
      );
      return;
    }

    log(
      `Received subtitle content from ${source}: ${content?.length || 0} bytes for ${language}`,
    );

    // Track the URL so we don't double-fetch it when track metadata arrives
    if (url) {
      processedContentUrls.add(url);
    }

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
    // If we're in an iframe and have subtitles, forward to top frame
    // This handles cases where XHR interception happens in iframe contexts
    if (window.self !== window.top && event.data?.subtitles) {
      log("Forwarding subtitle detection from iframe to top frame");
      try {
        window.top?.postMessage({
          type: "FFPROFANITY_SUBTITLES_DETECTED",
          source: event.data.source,
          subtitles: event.data.subtitles
        }, '*');
      } catch (e) {
        // Cross-origin restrictions may block this
        log("Could not forward to top frame (cross-origin blocked)");
      }
    }
    log("Skipping subtitle detection - no video element in this frame");
    return;
  }

  const { subtitles, source } = event.data;
  log(
    `Received ${subtitles.length} subtitles from ${source}`,
  );

  // Log each subtitle URL for debugging
  for (const sub of subtitles) {
    if (sub.url) {
      log(
        `Subtitle: ${sub.label || sub.language} - ${sub.url.substring(0, 100)}...`,
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
    // For user-initiated subtitle changes, force selection to update
    // PlutoTV's automatic interception should NOT force selection (content comes via FFPROFANITY_SUBTITLE_CONTENT)
    // Sources that should force selection:
    // - 'user-subtitle-selected': User clicked on a subtitle menu item
    // - 'subtitle-selected': Legacy LookMovie auto-selection
    // - 'auto-selected': LookMovie auto-selected "English 1" on page load
    const forceSelection = source.includes('user-subtitle') ||
                          source.includes('subtitle-selected') ||
                          source.includes('auto-selected');
    addDetectedTracks(tracks, forceSelection);
  }

  // Hide native subtitles for streaming sites that show their own overlay
  // LookMovie uses a custom subtitle display element that we need to hide
  hideNativeSubtitlesForSite(source);
}

/**
 * Hide native subtitle overlays for specific streaming sites
 * Each site has its own subtitle display element that needs to be hidden
 */
function hideNativeSubtitlesForSite(source: string): void {
  // Detect site from source or hostname
  const hostname = window.location.hostname.toLowerCase();
  let site: string | undefined;

  // Map hostname patterns to site identifiers
  if (hostname.includes('lookmovie')) {
    site = 'lookmovie';
  } else if (hostname.includes('fmovies')) {
    site = 'fmovies';
  } else if (hostname.includes('123chill')) {
    site = '123chill';
  } else if (hostname.includes('youtube')) {
    site = 'youtube';
  } else if (
    hostname.includes('vidfast') ||
    hostname.includes('vidsrc') ||
    hostname.includes('vidzee') ||
    hostname.includes('vidrock') ||
    hostname.includes('embedsu') ||
    hostname.includes('smashystream') ||
    hostname.includes('vidplay') ||
    hostname.includes('2embed') ||
    hostname.includes('autoembed')
  ) {
    // VidFast, VidSrc, and similar iframe embed players use Video.js
    site = 'videojs-player';
  } else if (source === 'user-upload' || source.startsWith('user-upload')) {
    // User-uploaded subtitles on embedded players - try to detect Video.js
    site = 'videojs-player';
  } else {
    // Fall back to source-based detection
    site = source.split('.')[0];
  }
  
  log(`Hiding native subtitles for ${source} (site: ${site}, host: ${hostname})`);
  
  // Try JavaScript API first (for sites using Video.js)
  // In Firefox, use wrappedJSObject to access page script's window
  try {
    const pageWindow = (window as any).wrappedJSObject || window;
    
    // LookMovie stores player in window.videoJS
    const videoJS = pageWindow.videoJS;
    if (videoJS && typeof videoJS.textTracks === 'function') {
      const tracks = videoJS.textTracks();
      if (tracks && tracks.length > 0) {
        log(`Found ${tracks.length} Video.js text tracks`);
        for (let i = 0; i < tracks.length; i++) {
          const track = tracks[i];
          if (track.kind === 'subtitles' || track.kind === 'captions') {
            if (track.mode !== 'disabled') {
              log(`Disabling track: ${track.label || track.language}, mode was: ${track.mode}`);
              track.mode = 'disabled';
            }
          }
        }
      }
    }
    
    // Check for videojs global players registry
    if (pageWindow.videojs && pageWindow.videojs.players) {
      const players = pageWindow.videojs.players;
      for (const playerId in players) {
        const player = players[playerId];
        if (player && typeof player.textTracks === 'function') {
          const tracks = player.textTracks();
          for (let i = 0; i < tracks.length; i++) {
            const track = tracks[i];
            if (track.kind === 'subtitles' || track.kind === 'captions') {
              if (track.mode !== 'disabled') {
                log(`Disabling videojs.players track: ${track.label || track.language}`);
                track.mode = 'disabled';
              }
            }
          }
        }
      }
    }
  } catch (e) {
    warn('Error disabling Video.js tracks:', e);
  }

  // Also try to disable native <track> elements on video elements
  try {
    const videos = document.querySelectorAll('video');
    for (const video of videos) {
      if (video.textTracks) {
        for (let i = 0; i < video.textTracks.length; i++) {
          const track = video.textTracks[i];
          if ((track.kind === 'subtitles' || track.kind === 'captions') && track.mode !== 'disabled') {
            log(`Disabling native <track> element: ${track.label || track.language}`);
            track.mode = 'disabled';
          }
        }
      }
    }
  } catch (e) {
    warn('Error disabling native <track> elements:', e);
  }

  // Hide subtitle display container via CSS
  const hideSelectors: Record<string, string[]> = {
    'lookmovie': [
      '.vjs-text-track-display',
      '.vjs-text-track-cue',
      '.video-js .vjs-text-track-display'
    ],
    'lookmovie.hls': ['.vjs-text-track-display', '.vjs-text-track-cue'],
    'lookmovie-api': ['.vjs-text-track-display', '.vjs-text-track-cue'],
    'lookmovie.xhr-subtitle': ['.vjs-text-track-display', '.vjs-text-track-cue'],
    'lookmovie.fetch-subtitle': ['.vjs-text-track-display', '.vjs-text-track-cue'],
    'lookmovie.fetch-hls': ['.vjs-text-track-display', '.vjs-text-track-cue'],
    'fmovies': ['.vjs-text-track-display', '.vjs-text-track-cue'],
    '123chill': ['.vjs-text-track-display', '.vjs-text-track-cue'],
    // Video.js-based iframe players (VidFast, VidSrc, etc.)
    'videojs-player': [
      // Video.js native selectors
      '.vjs-text-track-display',
      '.vjs-text-track-cue',
      '.video-js .vjs-text-track-display',
      '.vjs-text-track-display div',
      // Video.js cue container
      '.vjs-text-track-cue > div',
      // Generic subtitle containers
      'video::cue',
      // Plyr.js
      '.plyr__captions',
      '.plyr__caption',
      '.plyr texttrack',
      // JW Player
      '.jw-captions',
      '.jw-text-track-container',
      '.jw-captions-container',
      '.jw-text-track-cue',
      // HTML5 native subtitle elements
      '[class*="subtitle"]:not([class*="ffprofanity"])',
      '[class*="caption"]:not([class*="ffprofanity"]):not([class*="icon"])',
    ],
    'youtube': [
      '.ytp-caption-segment',
      '.caption-window',
      '.ytp-caption-window-container',
      '.ytp-caption-window-rollup',
      '.caption-visual-line'
    ],
    'youtube-intercepted': [
      '.ytp-caption-segment',
      '.caption-window',
      '.ytp-caption-window-container',
      '.ytp-caption-window-rollup',
      '.caption-visual-line'
    ],
    // PlutoTV uses standard video element with textTracks
    'plutotv': ['.vjs-text-track-display', '.vjs-text-track-cue', 'video::cue'],
    'plutotv.xhr-subtitle': ['.vjs-text-track-display', '.vjs-text-track-cue', 'video::cue'],
    'plutotv.xhr-intercepted': ['.vjs-text-track-display', '.vjs-text-track-cue', 'video::cue'],
    'plutotv.fetch-subtitle': ['.vjs-text-track-display', '.vjs-text-track-cue', 'video::cue'],
    'plutotv.fetch-intercepted': ['.vjs-text-track-display', '.vjs-text-track-cue', 'video::cue'],
  };

  const selectors = hideSelectors[site] || hideSelectors[site.split('.')[0]];

  if (selectors) {
    // Inject CSS to hide native subtitles
    const styleId = 'ffprofanity-hide-native-subtitles';
    let style = document.getElementById(styleId) as HTMLStyleElement;

    if (!style) {
      style = document.createElement('style');
      style.id = styleId;
      document.head.appendChild(style);
    }

    // Add CSS rules with visibility:hidden instead of display:none (display:none can break layout)
    const css = selectors.map(s => `${s} { visibility: hidden !important; opacity: 0 !important; }`).join('\n');
    style.textContent = css;

    log(`Injected CSS to hide native subtitles`);
  } else {
    // Fallback: inject generic Video.js selectors for unknown sites
    const fallbackSelectors = [
      '.vjs-text-track-display',
      '.vjs-text-track-cue',
      '.video-js .vjs-text-track-display',
      'video::cue'
    ];
    const styleId = 'ffprofanity-hide-native-subtitles-fallback';
    let style = document.getElementById(styleId) as HTMLStyleElement;

    if (!style) {
      style = document.createElement('style');
      style.id = styleId;
      document.head.appendChild(style);

      const css = fallbackSelectors.map(s => `${s} { visibility: hidden !important; opacity: 0 !important; }`).join('\n');
      style.textContent = css;

      log(`Injected fallback CSS to hide native subtitles for unknown site: ${site}`);
    }
  }
  
  // Schedule another attempt in case player loads later
  setTimeout(() => {
    try {
      const pageWindow = (window as any).wrappedJSObject || window;
      const videoJS = pageWindow.videoJS;
      if (videoJS && typeof videoJS.textTracks === 'function') {
        const tracks = videoJS.textTracks();
        for (let i = 0; i < tracks.length; i++) {
          const track = tracks[i];
          if ((track.kind === 'subtitles' || track.kind === 'captions') && track.mode !== 'disabled') {
            log(`Delayed disable of track: ${track.label || track.language}`);
            track.mode = 'disabled';
          }
        }
      }
    } catch (e) {
      warn('Error in delayed track disable:', e);
    }
  }, 3000);

  // Set up mutation observer to continuously hide subtitle elements as they appear
  const observerId = 'ffprofanity-subtitle-observer';
  if (!document.getElementById(observerId)) {
    const marker = document.createElement('div');
    marker.id = observerId;
    marker.style.display = 'none';
    document.body.appendChild(marker);

    const observer = new MutationObserver(() => {
      // Re-disable any text tracks that might have been re-enabled
      try {
        const videos = document.querySelectorAll('video');
        for (const video of videos) {
          if (video.textTracks) {
            for (let i = 0; i < video.textTracks.length; i++) {
              const track = video.textTracks[i];
              if ((track.kind === 'subtitles' || track.kind === 'captions') && track.mode !== 'disabled') {
                track.mode = 'disabled';
              }
            }
          }
        }
      } catch (e) {
        // Ignore cross-origin errors
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style']
    });

    log('Mutation observer set up to continuously hide subtitles');
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
  // When a user upload is active, reject auto-detected subtitle content
  if (userUploadActive) {
    debug(`handleSubtitleContent: rejecting auto-detected content (source="${source}") because user upload is active`);
    return;
  }

  // Hide native subtitles on streaming sites (prevents double display)
  hideNativeSubtitlesForSite(source);

  // Debug: Log first 500 chars to diagnose format issues
  log(
    `Parsing subtitle content (${content?.length || 0} bytes). First 500 chars:`,
    content?.substring(0, 500)
  );
  
  const rawResult = parseSubtitle(content, 0);

  if (rawResult.cues.length === 0) {
    error("Parse errors:", rawResult.errors);
    showNotification(
      "error",
      `Failed to parse subtitle: ${rawResult.errors.join(", ")}`,
    );
    return;
  }

  let finalCues = rawResult.cues;

  // FMovies/subs from video.textTracks are already perfectly synced with the player
  // plutotv-texttracks: cues from HLS.js textTracks already have correct timing
  // Skip any timing adjustments for these sources
  const isSyncedSource = source === "fmovies" || source === "Wyzie" || source === "Video Track" || source === "plutotv-texttracks" || label === "Video Track";
  
  if (isSyncedSource) {
    // Trust the timestamps as-is - they're already in the video's timeline
    log(
      `Using synced source '${source}': ${finalCues.length} cues, ` +
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
      log(
        `Detected Live TV: short video (${videoDurationMs}ms) with broadcast timestamps (${firstCueMs}ms)${isIncreasingTimestamps ? " [increasing pattern]" : ""}`,
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
        log(
          `Live TV: Broadcast-absolute offset=${offset}ms. ` +
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
          log(
            `Live TV: Segment-relative + mtp offset. ` +
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
            log(
              `Live TV: Segment timestamps ahead of video. ` +
                `firstCue=${firstCueMs}ms, videoPos=${videoPosMs}ms - no offset applied`,
            );
          } else {
            log(
              `Live TV: Segment timestamps already aligned. ` +
                `firstCue=${firstCueMs}ms, videoPos=${videoPosMs}ms`,
            );
          }
        }
      }
    } else {
      // VOD: Timestamps are movie-relative in the VTT files
      // After seeking, old segments from buffer may arrive - skip those that don't match current position
      
      const videoPosMs = videoElement ? Math.round(videoElement.currentTime * 1000) : 0;
      const lastCueMs = rawResult.cues[rawResult.cues.length - 1]?.endMs || firstCueMs;
      
      // Check if segment is relevant to current playback
      // A segment is relevant if its time range overlaps with current video position (±30s tolerance)
      const toleranceMs = 30000;
      const isSegmentRelevant = 
        videoPosMs === 0 || // No video position yet, accept segment
        (firstCueMs <= videoPosMs + toleranceMs && lastCueMs >= videoPosMs - toleranceMs);
      
      if (!isSegmentRelevant) {
        // Segment is from a different part of the video (e.g., old buffer after seeking)
        // Skip it to avoid polluting the cue list with out-of-range cues
        log(
          `VOD: Skipping out-of-range segment. ` +
            `segment=${firstCueMs}-${lastCueMs}ms, videoPos=${videoPosMs}ms`
        );
        return;
      }
      
      if (rawResult.timestampMap) {
        log(
          `VOD: Using movie timeline timestamps. ` +
            `firstCue=${firstCueMs}ms, videoPos=${videoPosMs}ms`,
        );
      }
    }
  } // end else (not syncedSource)
  log(
    `Parsed ${finalCues.length} cues from ${source} (${language})`,
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

  // Reduce logging noise for streaming sources with frequent segment updates
  const isStreamingSource = source.includes('plutotv') || source.includes('youtube');
  if (!isStreamingSource || finalCues.length > 5) {
    log(
      `Loaded subtitle track: ${currentTrack.label} (${finalCues.length} cues)`,
    );
  }
}

/**
 * Auto-select the best detected track
 */
async function autoSelectBestTrack(): Promise<void> {
  if (detectedTracks.length === 0) return;

  const selection = selectBestTrack(detectedTracks, settings);
  log("Auto-selecting track:", selection.track?.label);

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
    log("Scanning for subtitle tracks...");
  }

  // Get tracks from video elements
  const videoTracks = scanPageForTracks();

  // Get tracks from page scripts
  const scriptTracks = extractFromPageScripts();

  // Combine all detected tracks
  const allTracks = [...videoTracks, ...scriptTracks];

  if (allTracks.length > 0) {
    if (shouldLog) {
      log("Found tracks:", allTracks.length);
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
        log(
          "Background-detected tracks:",
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
 * @param tracks - Array of subtitle tracks to add
 * @param forceSelection - If true, switch to the new track even if one is already loaded
 */
function addDetectedTracks(tracks: SubtitleTrack[], forceSelection = false): void {
  // Filter out duplicates
  const newTracks = tracks.filter(
    (track) =>
      !detectedTracks.some((t) => t.url === track.url || t.id === track.id),
  );

  // Add new tracks to the list
  if (newTracks.length > 0) {
    detectedTracks.push(...newTracks);
  }

  // When a user upload is active, don't auto-select or force-select detected tracks
  // Store them for later use but don't switch away from user-provided content
  if (userUploadActive && !forceSelection) {
    log(`User upload active - stored ${newTracks.length} detected tracks but not auto-selecting`);
    // Notify popup of new tracks
    browser.runtime
      .sendMessage({
        type: "tracksUpdated",
        tracks: detectedTracks,
        currentTrack,
      })
      .catch(() => {});
    return;
  }

  if (forceSelection && tracks.length > 0) {
    // User explicitly selected a new track (non-user-upload) - switch to it
    // But if a user upload is active, don't override it with force selections from extractors
    if (userUploadActive) {
      log(`User upload active - ignoring forced track selection for: ${tracks[0]?.label}`);
      browser.runtime
        .sendMessage({
          type: "tracksUpdated",
          tracks: detectedTracks,
          currentTrack,
        })
        .catch(() => {});
      return;
    }

    const trackToSelect = tracks[0];
    const existingTrack = detectedTracks.find(
      (t) => t.url === trackToSelect.url || t.id === trackToSelect.id,
    );

    if (existingTrack) {
      // Preserve the source from the incoming track (e.g., 'lookmovie.user-subtitle-selected')
      // This is critical for processCues to know when to replace vs accumulate cues
      const trackWithCorrectSource = {
        ...existingTrack,
        source: trackToSelect.source
      };
      log(`User changed subtitle, switching to: ${trackWithCorrectSource.label} (source: ${trackWithCorrectSource.source})`);
      selectTrack(trackWithCorrectSource);
      showNotification("success", "Subtitle updated", true);
    } else if (newTracks.length > 0) {
      // Track not in detectedTracks yet (shouldn't happen but fallback)
      const selection = selectBestTrack(newTracks, settings);
      if (selection.track) {
        log(`User changed subtitle, switching to: ${selection.track.label}`);
        selectTrack(selection.track);
        showNotification("success", "Subtitle updated", true);
      }
    }
  } else if (!currentTrack && detectedTracks.length > 0) {
    // Skip auto-selection for HLS manifest sources - they'll send content separately
    // PlutoTV sends both .m3u8 manifest AND .vtt segment content
    // We should wait for the actual content via FFPROFANITY_SUBTITLE_CONTENT
    const isHlsManifestSource = detectedTracks.some(t =>
      t.source.includes('hls') ||
      t.url?.includes('.m3u8')
    );

    if (!isHlsManifestSource) {
      // Respect the autoSelectTrack setting - if disabled, only detect but don't auto-select
      if (!settings.autoSelectTrack) {
        log(`Auto-select disabled - detected ${detectedTracks.length} tracks but not auto-selecting`);
      } else {
        const selection = selectBestTrack(detectedTracks, settings);

        if (selection.track && selection.autoSelected) {
          selectTrack(selection.track);
          showNotification("success", "", true);
        }
      }
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
  log(
    `Selecting track: ${track.label} (${track.language}) from ${track.source}`,
  );
  log(`Track URL: ${track.url?.substring(0, 100)}...`);

  if (!track.url && !track.embedded) {
    warn("Track has no URL and is not embedded");
    return;
  }

  // Skip fetching if content was already processed via intercepted content
  // This prevents double-processing for sites like PlutoTV where both
  // subtitle content AND track metadata are sent
  if (track.url && processedContentUrls.has(track.url)) {
    log(`Skipping fetch for ${track.url.substring(0, 60)} - already processed`);
    currentTrack = track;
    return;
  }

  // When a user upload is active, don't auto-select detected tracks.
  // User must explicitly choose to switch tracks via popup.
  if (userUploadActive && track.source !== 'user' && track.source !== 'user-upload' && track.source !== 'user-selection') {
    log(`User upload active - not auto-selecting detected track: ${track.label} (source: ${track.source})`);
    return;
  }

  currentTrack = track;

  // Note: track selection is in-memory only - not persisted

  // Hide native subtitles on streaming sites when user selects a track
  // This prevents double display (native overlay + our overlay)
  hideNativeSubtitlesForSite(track.source || 'user-selection');

  // Notify page script about track selection (for sites like LookMovie that need to sync)
  window.postMessage({
    type: 'FFPROFANITY_TRACK_SELECTED',
    track: {
      url: track.url,
      label: track.label,
      language: track.language,
    },
  }, '*');

  // If track has URL, fetch it
  if (track.url) {
    try {
      log(`Fetching subtitle URL: ${track.url}`);
      const response = await fetch(track.url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const content = await response.text();
      log(
        `Received ${content.length} bytes from subtitle URL`,
      );
      log(
        `Content preview: ${content.substring(0, 200)}...`,
      );

      await handleSubtitleUpload(content, track.label, track.source);
    } catch (error) {
      error("Failed to fetch subtitle track:", error);
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

  const notifContent = document.createElement("div");
  notifContent.className = "ffprofanity-notification-content";

  const iconSpan = document.createElement("span");
  iconSpan.className = "ffprofanity-notification-icon";
  iconSpan.textContent = type === "success" ? "✓" : type === "error" ? "✗" : "ℹ";
  notifContent.appendChild(iconSpan);

  const textSpan = document.createElement("span");
  textSpan.className = "ffprofanity-notification-text";
  textSpan.textContent = content;
  notifContent.appendChild(textSpan);

  if (autoSelected) {
    const changeBtn = document.createElement("button");
    changeBtn.className = "ffprofanity-notification-change";
    changeBtn.textContent = "Change";
    notifContent.appendChild(changeBtn);
  }

  notificationEl.replaceChildren(notifContent);

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
      try {
        browser.runtime.sendMessage({ type: "openTrackSelector" });
      } catch {
        // Context invalidated or background not ready
      }
    });
  }
}

/**
 * Find video element on page with retry logic
 * Uses polling + mutation observer for dynamic video players
 */
function findVideoElement(): void {
  log("Looking for video element...");

  // First, try immediate search
  const videos = document.querySelectorAll("video");
  if (videos.length > 0) {
    log("Found video immediately:", videos.length);
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
      log(`Found video after ${pollAttempts} polls`);
      clearInterval(pollTimer);
      videoElement = videos[0] as HTMLVideoElement;
      attachVideoListeners(videoElement);
      
      // Find time display element for sites like fmovies where video.currentTime is unreliable
      findTimeDisplayElement();

      // Start monitoring if we have cues and video found
      // Check !animationFrameId to avoid starting duplicate loops
      if (cues.length > 0 && !animationFrameId) {
        log("Video found with cues ready, starting monitoring");
        isActive = true;
        startMonitoring();
      }
    } else if (pollAttempts >= maxPollAttempts) {
      log("No video found after max polls, stopping");
      clearInterval(pollTimer);
    }
  }, pollInterval);

  // Also observe for new video elements (for SPA navigation)
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of Array.from(mutation.addedNodes)) {
        // Check if the added node is a video or contains a video
        if (node instanceof HTMLVideoElement) {
          log("Video element added via mutation");
          videoElement = node;
          attachVideoListeners(videoElement);
          // Start monitoring if we have cues ready
          if (cues.length > 0 && !animationFrameId) {
            log("Video mutation found with cues ready, starting monitoring");
            isActive = true;
            startMonitoring();
          }
        } else if (node instanceof HTMLElement) {
          // Check descendants for video
          const nestedVideos = Array.from(node.querySelectorAll("video"));
          if (nestedVideos.length > 0) {
            log("Video found in added subtree");
            videoElement = nestedVideos[0];
            attachVideoListeners(videoElement);
            // Start monitoring if we have cues ready
            if (cues.length > 0 && !animationFrameId) {
              log("Video subtree found with cues ready, starting monitoring");
              isActive = true;
              startMonitoring();
            }
          }
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
  log("Mutation observer attached");
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
    log('No time display elements found');
    return;
  }
  
  // Sort by position - leftmost is likely current time
  candidates.sort((a, b) => a.position - b.position);
  
  // Take the leftmost as current time, second-leftmost as duration
  timeDisplayElement = candidates[0].element;
  log(`Found time display element: "${candidates[0].element.textContent?.trim()}" (${candidates.length} candidates, using leftmost)`);
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
 * Sites where video.currentTime is unreliable (affected by hover previews, etc.)
 * On these sites, we read the time from DOM elements instead.
 */
const SITES_NEEDING_DISPLAY_TIME = [
  /fmovies\.[a-z]+/i,
  /fmovies\d*\.[a-z]+/i,
  /123movies\.[a-z]+/i,
  /123chill\.[a-z]+/i,
  /lookmovie\.[a-z]+/i,
];

/**
 * Check if current site needs display-based time tracking
 */
function needsDisplayTimeTracking(): boolean {
  try {
    const hostname = window.location.hostname;
    return SITES_NEEDING_DISPLAY_TIME.some(pattern => pattern.test(hostname));
  } catch {
    return false;
  }
}

/**
 * Get current playback time in milliseconds
 * Primary: video.currentTime (reliable on YouTube and most sites)
 * Fallback: time display element (for fmovies and similar sites)
 */
function getCurrentTimeMs(): { timeMs: number; source: string } {
  const now = performance.now();

  // On sites where video.currentTime is unreliable (fmovies), use display element
  if (needsDisplayTimeTracking()) {
    // Re-find time display element periodically
    if (!timeDisplayElement || !timeDisplayElement.isConnected) {
      findTimeDisplayElement();
    }

    if (timeDisplayElement && timeDisplayElement.isConnected) {
      const rect = timeDisplayElement.getBoundingClientRect();
      const style = window.getComputedStyle(timeDisplayElement);
      const isVisible = style.display !== 'none' &&
                        style.visibility !== 'hidden' &&
                        parseFloat(style.opacity) > 0 &&
                        rect.width > 0 && rect.height > 0;

      const timeStr = timeDisplayElement.textContent?.trim() || '';
      const timeMs = parseTimeString(timeStr);

      if (isVisible && timeMs !== null && timeMs >= 0) {
        lastKnownTimeMs = timeMs;
        lastKnownTimeTimestamp = now;
        return { timeMs, source: 'display' };
      }
    }

    // Estimate from last known position if display is hidden
    if (lastKnownTimeMs > 0 && videoElement && !videoElement.paused && lastKnownTimeTimestamp > 0) {
      const elapsedMs = (now - lastKnownTimeTimestamp);
      const estimatedTimeMs = lastKnownTimeMs + (elapsedMs * playbackRate);
      const durationMs = (videoElement.duration || 0) * 1000;
      if (durationMs > 0 && estimatedTimeMs > durationMs) {
        return { timeMs: durationMs, source: 'estimated' };
      }
      return { timeMs: estimatedTimeMs, source: 'estimated' };
    }
  }

  // Default: use video.currentTime (reliable on YouTube and most sites)
  if (videoElement) {
    const videoTime = videoElement.currentTime * 1000;
    lastKnownTimeMs = videoTime;
    lastKnownTimeTimestamp = now;
    return { timeMs: videoTime, source: 'video' };
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
  log(
    `SEEK to ${videoElement.currentTime.toFixed(2)}s (${currentTimeMs}ms), offset: ${settings.offsetMs}ms, total cues: ${cues.length}, profanity cues: ${profanityCount}`,
  );

  if (profanityCue && !isMuted) {
    // Seeking into profanity - mute immediately
    log(
      `SEEK landed in profanity cue ${profanityCue.id}, muting`,
    );
    currentProfanityCue = profanityCue;
    sendMuteNow();
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

  const overlayStyle = document.createElement("style");
  overlayStyle.textContent = `
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
    `;
  overlayContainer.appendChild(overlayStyle);

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
    log("Moved overlay into fullscreen element");
  } else {
    // Move overlay back to body
    document.body.appendChild(overlayContainer);
    log("Moved overlay back to body");
  }
}

/**
 * Create and show an upload overlay on the video page.
 * The overlay contains a file input styled as a drop zone.
 * When a file is selected, it reads the content and processes it
 * as a user upload, then removes the overlay.
 */
function createUploadOverlay(): void {
  // Remove existing overlay if present
  const existing = document.getElementById("ffprofanity-upload-overlay");
  if (existing) existing.remove();

  const backdrop = document.createElement("div");
  backdrop.id = "ffprofanity-upload-overlay";
  backdrop.className = "ffprofanity-upload-backdrop";
  backdrop.innerHTML = `
    <div class="ffprofanity-upload-dialog">
      <div class="ffprofanity-upload-title">Upload Subtitles</div>
      <div class="ffprofanity-upload-desc">Choose a subtitle file (SRT, VTT, ASS/SSA)</div>
      <div class="ffprofanity-upload-dropzone" id="ffprofanity-dropzone">
        <div class="ffprofanity-upload-emoji">📄</div>
        <div class="ffprofanity-upload-hint">Click to choose a file</div>
        <input type="file" id="ffprofanity-file-input" accept=".srt,.vtt,.ass,.ssa">
      </div>
      <div class="ffprofanity-upload-status" id="ffprofanity-upload-status"></div>
      <div class="ffprofanity-upload-actions">
        <button class="ffprofanity-upload-cancel" id="ffprofanity-cancel-btn">Cancel</button>
      </div>
    </div>
  `;

  // Inject styles
  const style = document.createElement("style");
  style.textContent = `
    .ffprofanity-upload-backdrop {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.6);
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    .ffprofanity-upload-dialog {
      background: #fff;
      border-radius: 12px;
      padding: 28px 32px;
      max-width: 400px;
      width: 90%;
      box-shadow: 0 8px 32px rgba(0,0,0,0.3);
      pointer-events: auto;
    }
    .ffprofanity-upload-title {
      font-size: 18px;
      font-weight: 600;
      color: #1a1a1a;
      margin-bottom: 4px;
    }
    .ffprofanity-upload-desc {
      font-size: 13px;
      color: #666;
      margin-bottom: 20px;
    }
    .ffprofanity-upload-dropzone {
      border: 2px dashed #ccc;
      border-radius: 8px;
      padding: 28px 16px;
      text-align: center;
      cursor: pointer;
      transition: border-color 0.2s, background 0.2s;
      position: relative;
    }
    .ffprofanity-upload-dropzone:hover {
      border-color: #4a90d9;
      background: #f0f7ff;
    }
    .ffprofanity-upload-dropzone.dragover {
      border-color: #4a90d9;
      background: #e3f0ff;
    }
    .ffprofanity-upload-emoji {
      font-size: 36px;
      margin-bottom: 8px;
    }
    .ffprofanity-upload-hint {
      font-size: 14px;
      color: #555;
    }
    .ffprofanity-upload-dropzone input[type="file"] {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      opacity: 0;
      cursor: pointer;
    }
    .ffprofanity-upload-status {
      min-height: 0;
      font-size: 13px;
      margin-top: 12px;
      padding: 0;
      border-radius: 4px;
    }
    .ffprofanity-upload-status.status-success {
      background: #d4edda;
      color: #155724;
      padding: 8px 12px;
    }
    .ffprofanity-upload-status.status-error {
      background: #f8d7da;
      color: #721c24;
      padding: 8px 12px;
    }
    .ffprofanity-upload-status.status-info {
      background: #d1ecf1;
      color: #0c5460;
      padding: 8px 12px;
    }
    .ffprofanity-upload-actions {
      display: flex;
      justify-content: flex-end;
      margin-top: 16px;
    }
    .ffprofanity-upload-cancel {
      padding: 8px 20px;
      border-radius: 6px;
      font-size: 14px;
      cursor: pointer;
      border: 1px solid #ccc;
      background: #f5f5f5;
      color: #333;
    }
    .ffprofanity-upload-cancel:hover {
      background: #e8e8e8;
    }
  `;
  backdrop.appendChild(style);
  document.body.appendChild(backdrop);

  // Event: close overlay
  const cancelBtn = backdrop.querySelector("#ffprofanity-cancel-btn") as HTMLButtonElement;
  cancelBtn.addEventListener("click", () => backdrop.remove());

  // Clicking backdrop (outside dialog) also closes
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) backdrop.remove();
  });

  // File input
  const fileInput = backdrop.querySelector("#ffprofanity-file-input") as HTMLInputElement;
  const dropzone = backdrop.querySelector("#ffprofanity-dropzone") as HTMLDivElement;
  const statusEl = backdrop.querySelector("#ffprofanity-upload-status") as HTMLDivElement;

  // Drag-and-drop support
  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });
  dropzone.addEventListener("dragleave", () => {
    dropzone.classList.remove("dragover");
  });
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    const file = e.dataTransfer?.files?.[0];
    if (file) processFile(file);
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) processFile(file);
  });

  function showStatus(message: string, type: "success" | "error" | "info"): void {
    statusEl.textContent = message;
    statusEl.className = `ffprofanity-upload-status status-${type}`;
  }

  function processFile(file: File): void {
    showStatus(`Reading "${file.name}"...`, "info");
    cancelBtn.disabled = true;

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const content = e.target?.result as string;
        if (!content) {
          showStatus("Error: Could not read file content.", "error");
          cancelBtn.disabled = false;
          return;
        }

        // Process as user upload directly — we're in the content script
        // which has the video element
        userUploadActive = true;
        log("User upload active: suppressing auto-detection until unload");
        stopMonitoring();
        await handleSubtitleUpload(content, file.name);
        log(`Upload overlay: upload complete, ${cues.length} cues loaded`);

        showStatus(`✓ "${file.name}" loaded — ${cues.length} cues found`, "success");
        cancelBtn.disabled = false;
        cancelBtn.textContent = "Close";

        // Auto-close overlay after a short delay
        setTimeout(() => backdrop.remove(), 2000);
      } catch (err) {
        error("Failed to process upload in overlay:", err);
        showStatus(`Error: ${err}`, "error");
        cancelBtn.disabled = false;
      }
    };

    reader.onerror = () => {
      showStatus("Error reading file. Please try again.", "error");
      cancelBtn.disabled = false;
    };

    reader.readAsText(file);
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

  // Apply upcoming cues visibility (hidden when profanity-only mode is active)
  nextCuesEl.style.display = (settings.showUpcomingCues && !settings.showProfanityOnly) ? "block" : "none";
}

/**
 * Handle storage change events
 */
function handleStorageChange(
  changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
  _areaName: string,
): void {
  log("Storage change detected:", changes);
  if (changes.settings) {
    const oldSettings = settings;
    const newSettings = changes.settings.newValue as Partial<Settings>;
    log("Settings changed:", {
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
      log(
        `Sensitivity changed from ${oldSettings.sensitivity} to ${settings.sensitivity}, re-computing windows`,
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
      log(
        `Substitution settings changed from ${oldSettings.useSubstitutions}/${oldSettings.substitutionCategory} to ${settings.useSubstitutions}/${settings.substitutionCategory}, re-processing cue text`,
      );
      log(
        "Detector useSubstitutions:",
        detector["useSubstitutions"],
      );
      for (const cue of cues) {
        if (cue.hasProfanity && cue.profanityMatches.length > 0) {
          const detection = detector.detect(cue.text);
          cue.censoredText = detection.censoredText;
          log(
            `Re-processed cue ${cue.id}: "${cue.text.substring(0, 30)}..." -> "${cue.censoredText.substring(0, 30)}..."`,
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
      oldSettings.showProfanityOnly !== settings.showProfanityOnly ||
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
async function handleMessage(message: unknown): Promise<unknown> {
  if (!message || typeof message !== "object") return Promise.resolve();

  const msg = message as Record<string, unknown>;

  switch (msg.type) {
    case "uploadCues": {
      const uploadContent = msg.content as string;
      const uploadFilename = msg.filename as string | undefined;
      log(`Received uploadCues message: ${uploadContent?.length || 0} bytes, filename="${uploadFilename}", hasVideo=${!!videoElement}`);
      if (!videoElement) {
        // This frame doesn't have the video — skip (don't relay).
        // The popup sends to all frames and the frame with the video will handle it.
        log(`uploadCues: no video in this frame, skipping (top frame will handle)`);
        break;
      }
      // User upload: set userUploadActive BEFORE processing to immediately
      // suppress any in-flight auto-detection
      log(`uploadCues: processing user upload "${uploadFilename}" (${uploadContent?.length || 0} bytes)`);
      userUploadActive = true;
      log(`User upload active: suppressing auto-detection until unload`);
      // Stop current monitoring before processing user upload
      stopMonitoring();
      // Process the upload — this will parse, run profanity detection, and start monitoring.
      // handleSubtitleUpload will replace auto-detected cues with user cues (isUserSelection).
      await handleSubtitleUpload(uploadContent, uploadFilename);
      log(`uploadCues: upload complete, ${cues.length} cues loaded, userUploadActive=${userUploadActive}`);
      break;
    }

    case "unloadCues": {
      log(`Received unloadCues message, hasVideo=${!!videoElement}`);
      if (!videoElement) {
        // This frame doesn't have the video — skip (don't relay).
        log(`unloadCues: no video in this frame, skipping`);
        break;
      }
      handleSubtitleUnload();
      break;
    }

    case "showUploadOverlay": {
      // Show an upload overlay on the video page.
      // This avoids the Firefox bug where the popup closes when a
      // native file picker opens — the file input works fine on a normal page.
      log(`Received showUploadOverlay message, hasVideo=${!!videoElement}`);
      if (!videoElement) {
        // This frame doesn't have the video — let the frame that does handle it.
        log(`showUploadOverlay: no video in this frame, skipping`);
        break;
      }
      createUploadOverlay();
      break;
    }

    case "updateOffset":
      const offset = msg.offsetMs as number;
      if (typeof offset === "number") {
        settings.offsetMs = offset;
        storage.setSetting("offsetMs", offset);
      }
      break;

    case "updateSettings":
      // Settings updated from options page
      log(
        "Received updateSettings message:",
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
        userUploadActive,
      });

    case "trackDetected":
      // New track detected by background script
      // Iframes without a video element should skip track processing —
      // they can't display subtitles and waste resources fetching/parsing
      if (!videoElement && msg.track) {
        debug(`trackDetected: skipping in frame without video element (${(msg.track as SubtitleTrack).label})`);
        break;
      }
      if (msg.track) {
        if (userUploadActive) {
          log(`User upload active - storing background-detected track but not selecting: ${(msg.track as SubtitleTrack).label}`);
          // Still add to detectedTracks so popup can show it as an option,
          // but addDetectedTracks with forceSelection=false won't auto-select
          addDetectedTracks([msg.track as SubtitleTrack], false);
        } else {
          addDetectedTracks([msg.track as SubtitleTrack]);
        }
      }
      break;

    case "selectTrack":
      // User selected a track from popup
      if (msg.trackId) {
        const track = detectedTracks.find((t) => t.id === msg.trackId);
        if (track) {
          // If switching away from a user upload, clear the flag to re-enable auto-detection
          if (userUploadActive && track.source !== 'user') {
            userUploadActive = false;
            log("Switched away from user upload, re-enabling auto-detection");
          }
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
        userUploadActive,
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
  source?: string,
): Promise<void> {
  // When a user upload is active, reject auto-detected subtitle content.
  // This prevents detected tracks from replacing user-provided subtitles.
  const isUserUpload = !source || source === 'user-upload' || source === 'user-selection' || source === 'user';

  if (userUploadActive && !isUserUpload) {
    log(`handleSubtitleUpload: rejecting auto-detected content (source="${source}") because user upload is active`);
    return;
  }

  // Hide native subtitles on streaming sites (prevents double display)
  hideNativeSubtitlesForSite(source || 'user-upload');

  log(
    `Parsing subtitle content (${content.length} bytes)`,
  );

  const result = parseSubtitle(content);

  log(
    `Detected format: ${result.format}, cues: ${result.cues.length}, errors: ${result.errors.length}`,
  );

  if (result.errors.length > 0) {
    error("Parse errors:", result.errors);
    showNotification("error", result.errors.join("; "));
    return;
  }

  if (result.cues.length === 0) {
    error("No cues found in subtitle content");
    showNotification("error", "No subtitles found in file");
    return;
  }

  // For uploaded subtitle files, use cues as-is (VOD/static content)
  // Live TV timing offsets are only applied in handleSubtitleContent()
  // for intercepted PlutoTV segments which have context (streamType, segmentLoadTimeMs)
  
  // Tag cues with source for proper replacement/accumulate logic in processCues
  const taggedCues = result.cues.map(cue => ({
    ...cue,
    source: source || 'user-upload'
  }));
  
  processCues(taggedCues);

  // isUserUpload was already determined at the top of this function
  if (isUserUpload) {
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

    // Mark user upload as active to suppress auto-detection
    userUploadActive = true;
    log(`User upload active: suppressing auto-detection until unload`);

    // Persist cues and upload state to storage so they survive content script reinjection
    storage.setCues(cues).catch((err) => warn("Failed to persist cues:", err));
    storage.setUserUploadActive(true).catch((err) => warn("Failed to persist userUploadActive:", err));
    storage.setUserUploadTrack(userTrack).catch((err) => warn("Failed to persist upload track:", err));

    log(`Created track for uploaded file: ${userTrack.label}`);
  } else {
    // Auto-detected track: currentTrack was already set by selectTrack()
    log(`Loaded auto-detected track content: ${filename || source}`);
  }
}

/**
 * Handle unloading a user-uploaded subtitle file
 * Clears cues, resets track state, and re-enables auto-detection
 */
function handleSubtitleUnload(): void {
  log("Unloading user subtitle file, re-enabling auto-detection");

  // Clear all cues
  cues = [];
  cueIndex.build(cues);

  // Reset current track
  currentTrack = null;

  // Remove user-uploaded tracks from detected tracks list
  detectedTracks = detectedTracks.filter(t => t.source !== 'user' && !t.id.startsWith('user-upload-'));

  // Clear the user upload active flag to re-enable auto-detection
  userUploadActive = false;

  // Reset profanity state
  currentProfanityCue = null;
  currentProfanityWindow = null;
  if (isMuted) {
    sendUnmuteNow();
  }

  // Clear stored cues and upload state
  storage.clearUserUploadState().catch((err) => warn("Failed to clear upload state:", err));

  // Show notification
  showNotification("info", "Subtitle file unloaded. Auto-detection re-enabled.");

  // Re-scan for tracks now that auto-detection is re-enabled
  scanForTracks();

  log("User subtitle file unloaded, auto-detection re-enabled");
}

/**
 * Restore user-uploaded subtitles from storage on content script re-injection.
 * This handles the case where the content script is re-loaded (e.g., SPA navigation,
 * extension update) and the user's previously uploaded file would otherwise be lost.
 */
async function restoreUserUpload(): Promise<void> {
  try {
    const [isUploadActive, savedCues, savedTrack] = await Promise.all([
      storage.getUserUploadActive(),
      storage.getCues(),
      storage.getUserUploadTrack(),
    ]);

    if (!isUploadActive || savedCues.length === 0) {
      // No active upload to restore — clear stale data if any
      if (isUploadActive) {
        // Flag set but no cues — stale state, clean up
        await storage.clearUserUploadState();
      }
      return;
    }

    log(`Restoring user upload: ${savedCues.length} cues, track="${savedTrack?.label || 'unknown'}"`);

    // Re-run profanity detection on restored cues (detector settings may have changed)
    const restoredCues = savedCues.map((cue) => {
      const detection = detector.detect(cue.text);
      return {
        ...cue,
        censoredText: detection.censoredText,
        hasProfanity: detection.hasProfanity,
        profanityScore: detection.score,
        profanityMatches: detection.matches,
        ...(detection.hasProfanity && settings.sensitivity !== 'high'
          ? {
              profanityWindows: computeProfanityWindows(
                cue.id,
                cue.startMs,
                cue.endMs,
                cue.text,
                detection.matches,
                settings.sensitivity,
              ),
            }
          : {}),
      };
    });

    cues = restoredCues;
    cueIndex.build(cues);

    // Restore track metadata
    if (savedTrack) {
      if (!detectedTracks.some((t) => t.id === savedTrack.id)) {
        detectedTracks.push(savedTrack);
      }
      currentTrack = savedTrack;
    }

    // Re-enable user upload suppression
    userUploadActive = true;
    log(`User upload restored: suppressing auto-detection`);
  } catch (err) {
    warn("Failed to restore user upload state:", err);
  }
}

/**
 * Process cues with profanity detection
 * For HLS streams, accumulate cues from multiple segments instead of replacing
 */
function processCues(newCues: Cue[]): void {
  log(
    `Processing ${newCues.length} new cues, existing: ${cues.length}`,
  );

  // When a user upload is active, reject all auto-detected cues
  // to prevent detected content from accumulating alongside user-provided subtitles
  const firstCueSource = newCues[0]?.source || '';
  const isUserSource = firstCueSource === 'user-upload' ||
                       firstCueSource === 'user-selection' ||
                       firstCueSource.includes('user-subtitle');
  if (userUploadActive && !isUserSource) {
    log(`Rejecting ${newCues.length} auto-detected cues (source="${firstCueSource}") because user upload is active`);
    return;
  }

  // Process new cues for profanity
  const processedNewCues = newCues.map((cue) => {
    const detection = detector.detect(cue.text);

    if (cue.text.toLowerCase().includes("bullshit")) {
      debug(`DEBUG bullshit cue ${cue.id}:`, {
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
  const isSyncedSource = firstCueSource === 'fmovies' ||
                         firstCueSource === 'wyzie';
  const isYouTubeSource = firstCueSource === 'youtube-intercepted' ||
                          firstCueSource === 'youtube';
  const isPlutoTVSource = firstCueSource.includes('plutotv');
  // User explicitly selected a different subtitle track - replace cues entirely
  // This handles both page-script sources and track.source values
  // user-upload also replaces because a user-uploaded file should fully replace any
  // auto-detected content, not accumulate alongside it
  const isUserSelection = firstCueSource === 'lookmovie.user-subtitle-selected' ||
                          firstCueSource === 'lookmovie.auto-selected' ||
                          firstCueSource === 'user-selection' ||
                          firstCueSource === 'user-upload' ||
                          firstCueSource.includes('user-subtitle');

  if (isUserSelection && cues.length > 0) {
    log(
      `Replacing ${cues.length} cues with ${processedNewCues.length} (user selected different track)`
    );
    cues = processedNewCues;
  } else if (isYouTubeSource && cues.length > 0) {
    // For YouTube, replace cues when we get new timedtext responses
    // This handles both live streams (stream-relative time) and VOD updates
    const existingSource = cues[0]?.source || '';
    if (existingSource === 'youtube-intercepted' || existingSource === 'youtube') {
      // Same source - replace to handle live stream updates
      log(
        `Replacing ${cues.length} YouTube cues with ${processedNewCues.length} (live stream update)`
      );
      cues = processedNewCues;
    } else {
      // Different source - accumulate (e.g., switched from uploaded to auto-generated)
      const existingKeys = new Set(cues.map((c) => `${c.startMs}:${c.text}`));
      const uniqueNewCues = processedNewCues.filter(
        (c) => !existingKeys.has(`${c.startMs}:${c.text}`),
      );
      cues = [...cues, ...uniqueNewCues];
    }
  } else if (isPlutoTVSource) {
    // PlutoTV: HLS segments with incremental cues
    // Accumulate with deduplication, don't replace (VOD content builds up over time)
    log(
      `PlutoTV: accumulating ${processedNewCues.length} cues from ${firstCueSource}`
    );
    const existingKeys = new Set(cues.map((c) => `${c.startMs}:${c.text}`));
    const uniqueNewCues = processedNewCues.filter(
      (c) => !existingKeys.has(`${c.startMs}:${c.text}`),
    );
    if (uniqueNewCues.length > 0) {
      cues = [...cues, ...uniqueNewCues];
      cues.sort((a, b) => a.startMs - b.startMs);
    }
  } else if (isSyncedSource && cues.length > 0 && processedNewCues.length > 100) {
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
      log(
        `Replacing ${cues.length} cues with ${processedNewCues.length} (timing overlap detected)`
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
  log(
    `Processed ${cues.length} cues, ${profanityCues.length} with profanity`,
  );
  if (settings.sensitivity !== "high" && profanityCues.length > 0) {
    const windowCount = profanityCues.reduce(
      (sum, c) => sum + (c.profanityWindows?.length || 0),
      0,
    );
    log(
      `Computed ${windowCount} profanity windows for sensitivity '${settings.sensitivity}'`,
    );
  }

  // Log first few profanity cues for verification (with timestamps)
  if (profanityCues.length > 0) {
    log(
      "First 10 profanity cues:",
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
    log(
      `Starting monitoring: ${cues.length} cues, videoElement=${!!videoElement}`,
    );
    isActive = true;
    startMonitoring();
  } else {
    log(
      `NOT starting monitoring: cues=${cues.length}, videoElement=${!!videoElement}`,
    );
  }
}

/**
 * Start monitoring playback
 */
function startMonitoring(): void {
  if (!videoElement) {
    log("startMonitoring: no videoElement, returning");
    return;
  }

  // Only start if we have both video AND cues
  if (cues.length === 0) {
    log("startMonitoring: no cues, returning");
    return;
  }

  // Detect YouTube ad video: duration=NaN or very short (< 30s) indicates ad
  // Live streams have duration=3600 (YouTube placeholder) or Infinity - NOT ads
  const isLiveStream = videoElement.duration >= 3600 || !isFinite(videoElement.duration);
  const isAdVideo = !isLiveStream && (isNaN(videoElement.duration) || videoElement.readyState < 1);

  // On YouTube, multiple video elements may exist - try to find the main content video
  if (isAdVideo) {
    const allVideos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
    const validVideos = allVideos.filter(v =>
      v.isConnected && v.duration > 30 && !isNaN(v.duration) && v.readyState >= 1
    );

    if (validVideos.length > 0) {
      // Found a valid content video - use it instead
      log(`Found main content video (duration=${validVideos[0].duration?.toFixed(2)}s) instead of ad video`);
      videoElement = validVideos[0];
      attachVideoListeners(videoElement);
      findTimeDisplayElement();
    } else {
      // No valid video found - defer monitoring until ad ends
      log(`Ad video detected (duration=${videoElement.duration}, readyState=${videoElement.readyState}), deferring monitoring...`);
      // Schedule a retry in 500ms
      setTimeout(() => {
        if (cues.length > 0 && isActive) {
          startMonitoring();
        }
      }, 500);
      return;
    }
  }

  // Cancel any existing loop first - critical for multi-frame scenarios
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }

  log("startMonitoring: starting update loop");
  log(
    `Video state: paused=${videoElement.paused}, currentTime=${videoElement.currentTime?.toFixed(2)}, duration=${videoElement.duration?.toFixed(2)}, readyState=${videoElement.readyState}`,
  );

  const updateLoop = () => {
    // Stop if not active
    if (!isActive) {
      animationFrameId = null;
      return;
    }

    // Handle disconnected video OR ad video (YouTube uses separate video for ads)
    // Ad video characteristics: duration=NaN, readyState=0, or very short duration (< 30s)
    // Only switch if current video is actually problematic (disconnected or invalid)
    const currentVideoInvalid = !videoElement?.isConnected ||
      !videoElement ||
      isNaN(videoElement?.duration) ||
      videoElement.readyState < 1;

    if (currentVideoInvalid) {
      // Current video is invalid, try to find a valid content video
      const allVideos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];

      // Filter for valid content videos: connected, valid duration, proper readyState
      const validVideos = allVideos.filter(v => {
        const isConnected = v.isConnected;
        const hasValidDuration = !isNaN(v.duration) && v.duration > 30;
        const hasValidReadyState = v.readyState >= 1;
        return isConnected && (hasValidDuration || hasValidReadyState);
      });

      // Sort by duration descending - longest video is likely the main content
      validVideos.sort((a, b) => (b.duration || 0) - (a.duration || 0));

      const mainVideo = validVideos[0];

      if (mainVideo && mainVideo !== videoElement) {
        log(`Switching to valid video (duration=${mainVideo.duration?.toFixed(2)}s, readyState=${mainVideo.readyState})`);
        videoElement = mainVideo;
        attachVideoListeners(videoElement);
        findTimeDisplayElement();
      } else if (!mainVideo && !videoElement?.isConnected) {
        // No valid video found and current video is disconnected - keep polling
        animationFrameId = requestAnimationFrame(updateLoop);
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

        // After ~5 frames (~80ms), check if we're stable at the new position
        if (pendingSeekFrameCount >= 5) {
          // Legitimate seek confirmed if:
          // 1. We're still near the jumped-to position (not jumping around)
          // 2. Or video is playing normally from this position (time advancing steadily)
          const elapsedSinceSeek = currentTimeMs - (pendingSeekTimeMs || 0);
          const isNearSeekPosition = Math.abs(elapsedSinceSeek) < 5000; // Within 5 seconds of seek target
          const isPlayingFromSeek = elapsedSinceSeek >= 0 && elapsedSinceSeek < 5000; // Playing forward from seek

          if (isNearSeekPosition || isPlayingFromSeek) {
            // Legitimate seek confirmed - accept the new time and continue
            lastStableTimeMs = currentTimeMs;
            pendingSeekTimeMs = null;
            pendingSeekFrameCount = 0;
            updatePlayback(currentTimeMs);
          }
          // Otherwise keep waiting for stabilization (very rare)
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
 * On mobile Firefox, tabs.update({ muted: true }) is not supported,
 * so we mute the video element directly as the primary method.
 */
function sendMuteNow(): void {
  if (isMuted) return; // Already muted

  // For medium/low sensitivity, use window end time; for high, use cue end time
  const unmuteTime = currentProfanityWindow?.endMs || currentProfanityCue?.endMs || 0;
  const reasonInfo = currentProfanityWindow
    ? `window "${currentProfanityWindow.word}"`
    : (currentProfanityCue ? `cue ${currentProfanityCue.id}` : "unknown");

  log(
    `MUTE: ${reasonInfo} at ${videoElement?.currentTime?.toFixed(2)}s, unmute at ${unmuteTime}ms`,
  );

  // Primary method: mute video element directly (works on both desktop and mobile)
  if (videoElement) {
    originalVolume = videoElement.volume;
    videoElement.muted = true;
  }

  // Secondary method: ask background to mute tab (works on desktop only)
  try {
    browser.runtime.sendMessage({
      type: "muteNow",
      reasonId: currentProfanityCue ? `cue-${currentProfanityCue.id}` : "unknown",
      expectedUnmuteAt: unmuteTime,
    });
  } catch {
    warn("Failed to send mute message - background not ready");
  }

  isMuted = true;
}

/**
 * Send unmute message immediately (no debounce for tighter timing)
 * On mobile Firefox, tabs.update({ muted: false }) is not supported,
 * so we unmute the video element directly as the primary method.
 */
function sendUnmuteNow(): void {
  if (!isMuted) return; // Already unmuted

  log(
    `UNMUTE at ${videoElement?.currentTime?.toFixed(2)}s`,
  );

  // Primary method: unmute video element directly (works on both desktop and mobile)
  if (videoElement && originalVolume !== null) {
    videoElement.muted = false;
    videoElement.volume = originalVolume;
    originalVolume = null;
  } else if (videoElement) {
    videoElement.muted = false;
  }

  // Secondary method: ask background to unmute tab (works on desktop only)
  try {
    browser.runtime.sendMessage({
      type: "unmuteNow",
    });
  } catch {
    warn("Failed to send unmute message - background not ready");
  }

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
    debug(
      `updatePlayback: time=${(currentTimeMs / 1000).toFixed(1)}s, cue=${currentCue ? currentCue.id : "none"}, isActive=${isActive}, cues=${cues.length}`,
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
    currentProfanityWindow = muteState.window; // For medium/low sensitivity
    sendMuteNow();
  } else if (!muteState.shouldMute && isMuted) {
    // Leaving the profanity zone
    sendUnmuteNow();
    currentProfanityCue = null;
    currentProfanityWindow = null;
  }

  // Update overlay
  if (currentCue && !(settings.showProfanityOnly && !currentCue.hasProfanity)) {
    // Sanitize text to prevent XSS - both censoredText and text need sanitization
    const rawText = currentCue.hasProfanity
      ? currentCue.censoredText
      : currentCue.text;
    const displayText = sanitizeText(rawText);

    currentCueEl.textContent = displayText;
    currentCueEl.style.display = "block";
    currentCueEl.classList.remove("ffprofanity-hidden");

    // Show next cues preview if enabled (disabled when profanity-only mode is active)
    if (
      settings.showUpcomingCues &&
      !settings.showProfanityOnly &&
      settings.upcomingCuesCount > 0 &&
      nextCuesEl
    ) {
      const nextCues = cueIndex.getNextCues(
        currentTimeMs,
        settings.upcomingCuesCount,
        settings.offsetMs,
      );
      if (nextCues.length > 0) {
        nextCuesEl.replaceChildren();
        for (const c of nextCues) {
          const time = formatTime(c.startMs);
          const rawText = c.hasProfanity ? c.censoredText : c.text;
          const text = sanitizeText(rawText);
          const preview = document.createElement("div");
          preview.className = "ffprofanity-preview";
          preview.textContent = `${time}: ${text.substring(0, 50)}${text.length > 50 ? "..." : ""}`;
          nextCuesEl.appendChild(preview);
        }
      } else {
        nextCuesEl.replaceChildren();
      }
    } else if (nextCuesEl) {
      nextCuesEl.replaceChildren();
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
