/**
 * Content Script
 * Monitors video playback, renders subtitle overlay, and triggers mute/unmute
 */

import { storage } from '../lib/storage';
import { parseSubtitle, sanitizeText } from '../lib/parser';
import { ProfanityDetector, createDetector } from '../lib/detector';
import { CueIndex } from '../lib/cueIndex';
import { selectBestTrack, formatTrackLabel, createTrackFromUser } from '../lib/tracks';
import { scanPageForTracks, extractFromPageScripts, watchForVideoTracks } from '../lib/extractor';
import { getAllMatchingExtractors, extractLanguageFromUrl, isSubtitleUrl } from '../extractors';
import type { Cue, Settings, DetectionResult, SubtitleTrack } from '../types';

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
let lastCueId: number | null = null;
let currentProfanityCue: Cue | null = null; // Track current profanity cue for mute state
let playbackRate: number = 1.0; // Track playback speed
let isMuted: boolean = false; // Track mute state to avoid redundant messages

// Debouncing
let muteDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let unmuteTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Initialize the content script
 */
async function init(): Promise<void> {
  console.log('[FFProfanity] Content script initializing...');
  
  // Load settings
  settings = await storage.getSettings();
  console.log('[FFProfanity] Settings loaded:', { offsetMs: settings.offsetMs, sensitivity: settings.sensitivity });

  // Create detector
  // Only pass wordlist if user has custom words; otherwise use defaults
  const detectorConfig = {
    ...settings,
    wordlist: settings.wordlist.length > 0 ? settings.wordlist : undefined,
  };
  detector = createDetector(detectorConfig);
  if (settings.wordlist.length > 0) {
    detector.addWords(settings.wordlist);
  }

  // Initialize cue index
  cueIndex = new CueIndex();

  // Find video element
  findVideoElement();
  console.log('[FFProfanity] Video element found:', !!videoElement);

  // Create overlay
  createOverlay();
  console.log('[FFProfanity] Overlay created');

  // Inject script to intercept API responses on streaming sites
  injectApiInterceptor();

  // Clear any old saved cues - user prefers per-session only
  await storage.clearCues();

  // Scan for existing subtitle tracks
  await scanForTracks();
  console.log('[FFProfanity] Detected tracks:', detectedTracks.length);

  // Watch for dynamically added tracks
  watchForVideoTracks((tracks) => {
    console.log('[FFProfanity] New tracks detected:', tracks.length);
    addDetectedTracks(tracks);
  });

  // Listen for storage changes
  browser.storage.onChanged.addListener(handleStorageChange);

  // Listen for messages from background and popup
  browser.runtime.onMessage.addListener(handleMessage);

  console.log('[FFProfanity] Content script ready');
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
    .map(e => (e as any).getInjectedScript?.() || '')
    .filter((s: string) => s.length > 0)
    .join('\n\n');

  const script = document.createElement('script');
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

  (document.head || document.documentElement).appendChild(script);
  script.remove();

  // Listen for messages from the injected script
  window.addEventListener('message', handleInterceptedMessage);
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
  if (event.data?.type === 'FFPROFANITY_SUBTITLE_CONTENT') {
    const { content, language, label, source } = event.data;
    console.log(`[FFProfanity] Received subtitle content from ${source}: ${content?.length || 0} bytes for ${language}`);

    if (content && content.length > 10) {
      // Parse and use directly
      handleSubtitleContent(content, language, label, source);
    }
    return;
  }

  // Handle track metadata
  if (event.data?.type !== 'FFPROFANITY_SUBTITLES_DETECTED') return;

  const { subtitles, source } = event.data;
  console.log(`[FFProfanity] Received ${subtitles.length} subtitles from ${source}`);

  // Log each subtitle URL for debugging
  for (const sub of subtitles) {
    if (sub.url) {
      console.log(`[FFProfanity] Subtitle: ${sub.label || sub.language} - ${sub.url.substring(0, 100)}...`);
    }
  }

  const tracks: SubtitleTrack[] = [];

  for (const sub of subtitles) {
    if (!sub.url) continue;

    const track: SubtitleTrack = {
      id: `intercepted-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      url: sub.url,
      label: sub.label || sub.language || 'Detected',
      language: sub.language || '',
      isSDH: /sdh|cc|hearing|deaf/i.test(sub.label || ''),
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
 * Handle subtitle content received from page context (YouTube)
 * This bypasses the need to fetch with credentials from content script
 */
function handleSubtitleContent(content: string, language: string, label: string, source: string): void {
  // Parse the content
  const result = parseSubtitles(content);

  if (result.cues.length === 0) {
    console.error('[FFProfanity] Parse errors:', result.errors);
    showParseError(result.errors);
    return;
  }

  console.log(`[FFProfanity] Parsed ${result.cues.length} cues from ${source} (${language})`);

  // Store as a virtual track
  const trackId = `content-${Date.now()}`;

  // Process the cues directly
  processCues(result.cues);

  // Update status
  currentTrack = {
    id: trackId,
    url: '',
    label: label || language || 'YouTube',
    language: language || 'en',
    isSDH: false,
    isDefault: true,
    embedded: false,
    source: source,
    recommendScore: 10, // High score since we already have content
  };

  detectedTracks = [currentTrack];

  console.log(`[FFProfanity] Loaded subtitle track: ${currentTrack.label} (${result.cues.length} cues)`);
}

/**
 * Auto-select the best detected track
 */
async function autoSelectBestTrack(): Promise<void> {
  if (detectedTracks.length === 0) return;
  
  const best = selectBestTrack(detectedTracks, settings);
  console.log('[FFProfanity] Auto-selecting track:', best?.label);
  
  if (best) {
    await selectTrack(best);
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
    console.log('[FFProfanity] Scanning for subtitle tracks...');
  }

  // Get tracks from video elements
  const videoTracks = scanPageForTracks();

  // Get tracks from page scripts
  const scriptTracks = extractFromPageScripts();

  // Combine all detected tracks
  const allTracks = [...videoTracks, ...scriptTracks];

  if (allTracks.length > 0) {
    if (shouldLog) {
      console.log('[FFProfanity] Found tracks:', allTracks.length);
    }
    addDetectedTracks(allTracks);
  }

  // Request any tracks detected by background script
  try {
    const response = await browser.runtime.sendMessage({ type: 'getDetectedTracks' });
    if (response?.tracks?.length > 0) {
      if (shouldLog) {
        console.log('[FFProfanity] Background-detected tracks:', response.tracks.length);
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
  const newTracks = tracks.filter(track =>
    !detectedTracks.some(t => t.url === track.url || t.id === track.id)
  );

  if (newTracks.length === 0) return;

  detectedTracks.push(...newTracks);

  // Note: tracks are in-memory only - not persisted

  // If no current track, auto-select best one
  if (!currentTrack && detectedTracks.length > 0) {
    const selection = selectBestTrack(detectedTracks, settings);

    if (selection.track && selection.autoSelected) {
      selectTrack(selection.track);
      showNotification('success', '', true);
    }
  }

  // Notify popup of new tracks
  browser.runtime.sendMessage({
    type: 'tracksUpdated',
    tracks: detectedTracks,
    currentTrack,
  }).catch(() => {
    // Popup may not be open, ignore
  });
}

/**
 * Select and load a subtitle track
 */
async function selectTrack(track: SubtitleTrack): Promise<void> {
  console.log(`[FFProfanity] Selecting track: ${track.label} (${track.language}) from ${track.source}`);
  console.log(`[FFProfanity] Track URL: ${track.url?.substring(0, 100)}...`);

  if (!track.url && !track.embedded) {
    console.warn('[FFProfanity] Track has no URL and is not embedded');
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
      console.log(`[FFProfanity] Received ${content.length} bytes from subtitle URL`);
      console.log(`[FFProfanity] Content preview: ${content.substring(0, 200)}...`);

      await handleSubtitleUpload(content, track.label);
    } catch (error) {
      console.error('[FFProfanity] Failed to fetch subtitle track:', error);
      showNotification('error', `Failed to load subtitles: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
          text: vtCue.text || '',
          censoredText: '',
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
function showNotification(type: 'success' | 'error' | 'info', message: string, autoSelected = false): void {
  if (!overlayContainer) return;
  
  // Remove existing notification
  if (notificationEl) {
    notificationEl.remove();
  }
  
  notificationEl = document.createElement('div');
  notificationEl.className = 'ffprofanity-notification';
  
  let content = '';
  if (autoSelected && currentTrack) {
    content = `✓ Loaded: ${formatTrackLabel(currentTrack)} (auto-detected)`;
  } else {
    content = message;
  }
  
  notificationEl.innerHTML = `
    <div class="ffprofanity-notification-content">
      <span class="ffprofanity-notification-icon">${type === 'success' ? '✓' : type === 'error' ? '✗' : 'ℹ'}</span>
      <span class="ffprofanity-notification-text">${content}</span>
      ${autoSelected ? `<button class="ffprofanity-notification-change">Change</button>` : ''}
    </div>
  `;
  
  overlayContainer.appendChild(notificationEl);
  
  // Auto-hide after 3 seconds
  setTimeout(() => {
    if (notificationEl) {
      notificationEl.classList.add('ffprofanity-notification-hidden');
      setTimeout(() => notificationEl?.remove(), 300);
    }
  }, 3000);
  
  // Change button click handler
  const changeBtn = notificationEl.querySelector('.ffprofanity-notification-change');
  if (changeBtn) {
    changeBtn.addEventListener('click', () => {
      browser.runtime.sendMessage({ type: 'openTrackSelector' });
    });
  }
}

/**
 * Find video element on page with retry logic
 * Uses polling + mutation observer for dynamic video players
 */
function findVideoElement(): void {
  console.log('[FFProfanity] Looking for video element...');
  
  // First, try immediate search
  const videos = document.querySelectorAll('video');
  if (videos.length > 0) {
    console.log('[FFProfanity] Found video immediately:', videos.length);
    videoElement = videos[0] as HTMLVideoElement;
    attachVideoListeners(videoElement);
    return;
  }

  // Poll for video element (streaming sites load dynamically)
  let pollAttempts = 0;
  const maxPollAttempts = 20; // Poll for up to 10 seconds
  const pollInterval = 500;

  const pollTimer = setInterval(() => {
    pollAttempts++;
    const videos = document.querySelectorAll('video');
    
    if (videos.length > 0) {
      console.log(`[FFProfanity] Found video after ${pollAttempts} polls`);
      clearInterval(pollTimer);
      videoElement = videos[0] as HTMLVideoElement;
      attachVideoListeners(videoElement);
      
      // Start monitoring if we have cues
      if (cues.length > 0 && !isActive) {
        isActive = true;
        startMonitoring();
      }
    } else if (pollAttempts >= maxPollAttempts) {
      console.log('[FFProfanity] No video found after max polls, stopping');
      clearInterval(pollTimer);
    }
  }, pollInterval);

  // Also observe for new video elements (for SPA navigation)
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        // Check if the added node is a video or contains a video
        if (node instanceof HTMLVideoElement) {
          console.log('[FFProfanity] Video element added via mutation');
          videoElement = node;
          attachVideoListeners(videoElement);
        } else if (node instanceof HTMLElement) {
          // Check descendants for video
          const nestedVideos = node.querySelectorAll('video');
          if (nestedVideos.length > 0) {
            console.log('[FFProfanity] Video found in added subtree');
            videoElement = nestedVideos[0] as HTMLVideoElement;
            attachVideoListeners(videoElement);
          }
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
  console.log('[FFProfanity] Mutation observer attached');
}

/**
 * Attach event listeners to video element
 */
function attachVideoListeners(video: HTMLVideoElement): void {
  // Handle seek events - check if we landed in profanity
  video.addEventListener('seeked', handleVideoSeeked);
  
  // Handle playback rate changes
  video.addEventListener('ratechange', handleRateChange);
  
  // Handle play/pause for state tracking
  video.addEventListener('play', () => {
    if (cues.length > 0) {
      isActive = true;
      startMonitoring();
    }
  });
  
  video.addEventListener('pause', () => {
    // Don't stop monitoring on pause, just let the loop continue
    // This ensures we're ready when playback resumes
  });
}

/**
 * Handle seek events - immediately mute if landing in profanity
 */
function handleVideoSeeked(): void {
  if (!videoElement || !isActive || cues.length === 0) return;

  const currentTimeMs = videoElement.currentTime * 1000;
  const profanityCue = cueIndex.findProfanityCue(currentTimeMs, settings.offsetMs);

  // Debug: show cue count and offset
  const profanityCount = cues.filter(c => c.hasProfanity).length;
  console.log(`[FFProfanity] SEEK to ${videoElement.currentTime.toFixed(2)}s (${currentTimeMs}ms), offset: ${settings.offsetMs}ms, total cues: ${cues.length}, profanity cues: ${profanityCount}`);

  if (profanityCue && !isMuted) {
    // Seeking into profanity - mute immediately
    console.log(`[FFProfanity] SEEK landed in profanity cue ${profanityCue.id}, muting`);
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

  overlayContainer = document.createElement('div');
  overlayContainer.id = 'ffprofanity-overlay';
  overlayContainer.className = 'ffprofanity-overlay';
  overlayContainer.innerHTML = `
    <style>
      .ffprofanity-overlay {
        position: fixed;
        bottom: 80px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2147483647;
        font-family: Arial, Helvetica, sans-serif;
        text-align: center;
        pointer-events: none;
      }
      .ffprofanity-cue {
        background: rgba(0, 0, 0, 0.8);
        color: #ffffff;
        padding: 8px 16px;
        border-radius: 4px;
        font-size: 20px;
        text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.8);
        max-width: 80vw;
        line-height: 1.4;
        animation: fadeIn 0.2s ease-out;
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
        background: rgba(0, 0, 0, 0.5);
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

  currentCueEl = document.createElement('div');
  currentCueEl.className = 'ffprofanity-cue';
  currentCueEl.style.display = 'none';

  nextCuesEl = document.createElement('div');
  nextCuesEl.className = 'ffprofanity-next-cues';

  overlayContainer.appendChild(currentCueEl);
  overlayContainer.appendChild(nextCuesEl);
  document.body.appendChild(overlayContainer);
}

/**
 * Handle storage change events
 */
function handleStorageChange(changes: Record<string, { newValue: unknown; oldValue: unknown }>): void {
  if (changes.settings) {
    settings = { ...settings, ...(changes.settings.newValue as Partial<Settings>) };
    detector = createDetector(settings);
  }
}

/**
 * Handle messages from background and popup
 */
function handleMessage(message: unknown): Promise<unknown> {
  if (!message || typeof message !== 'object') return Promise.resolve();

  const msg = message as Record<string, unknown>;

  switch (msg.type) {
    case 'uploadCues':
      const content = msg.content as string;
      const filename = msg.filename as string | undefined;
      handleSubtitleUpload(content, filename);
      break;

    case 'updateOffset':
      const offset = msg.offsetMs as number;
      if (typeof offset === 'number') {
        settings.offsetMs = offset;
        storage.setSetting('offsetMs', offset);
      }
      break;

    case 'enable':
      isActive = true;
      startMonitoring();
      break;

    case 'disable':
      isActive = false;
      stopMonitoring();
      break;

    case 'getStatus':
      return Promise.resolve({
        active: isActive,
        cueCount: cues.length,
        hasVideo: !!videoElement,
        currentTrack,
        detectedTracks,
      });

    case 'trackDetected':
      // New track detected by background script
      if (msg.track) {
        addDetectedTracks([msg.track as SubtitleTrack]);
      }
      break;

    case 'selectTrack':
      // User selected a track from popup
      if (msg.trackId) {
        const track = detectedTracks.find(t => t.id === msg.trackId);
        if (track) {
          selectTrack(track);
        }
      }
      break;

    case 'getTracks':
      // Return available tracks to popup
      return Promise.resolve({
        type: 'tracks',
        tracks: detectedTracks,
        currentTrack,
      });
  }

  return Promise.resolve();
}

/**
 * Handle uploaded subtitle file
 */
async function handleSubtitleUpload(content: string, filename?: string): Promise<void> {
  console.log(`[FFProfanity] Parsing subtitle content (${content.length} bytes)`);

  const result = parseSubtitle(content);

  console.log(`[FFProfanity] Detected format: ${result.format}, cues: ${result.cues.length}, errors: ${result.errors.length}`);

  if (result.errors.length > 0) {
    console.error('[FFProfanity] Parse errors:', result.errors);
    showNotification('error', result.errors.join('; '));
    return;
  }

  if (result.cues.length === 0) {
    console.error('[FFProfanity] No cues found in subtitle content');
    showNotification('error', 'No subtitles found in file');
    return;
  }

  processCues(result.cues);
  // Note: cues are NOT saved to storage - per-session only

  // Create a track entry for user uploads
  const userTrack: SubtitleTrack = {
    id: `user-upload-${Date.now()}`,
    label: filename || 'Uploaded subtitles',
    language: 'unknown',
    isSDH: false,
    isDefault: true,
    source: 'user',
    embedded: false,
    recommendScore: 10, // User uploads should be preferred
  };

  // Set as current track (in-memory only)
  if (!detectedTracks.some(t => t.id === userTrack.id)) {
    detectedTracks.push(userTrack);
  }
  currentTrack = userTrack;

  console.log(`[FFProfanity] Created track for uploaded file: ${userTrack.label}`);
}

/**
 * Process cues with profanity detection
 */
function processCues(newCues: Cue[]): void {
  cues = newCues.map(cue => {
    const detection = detector.detect(cue.text);
    
    // Debug: log any cue containing "bullshit"
    if (cue.text.toLowerCase().includes('bullshit')) {
      console.log(`[FFProfanity] DEBUG bullshit cue ${cue.id}:`, {
        text: cue.text,
        hasProfanity: detection.hasProfanity,
        score: detection.score,
        matches: detection.matches,
        censoredText: detection.censoredText
      });
    }
    
    return {
      ...cue,
      censoredText: detection.censoredText,
      hasProfanity: detection.hasProfanity,
      profanityScore: detection.score,
      profanityMatches: detection.matches,
    };
  });

  // Build index for fast lookup
  cueIndex.build(cues);

  // Log summary
  const profanityCues = cues.filter(c => c.hasProfanity);
  console.log(`[FFProfanity] Processed ${cues.length} cues, ${profanityCues.length} with profanity`);

  // Log first few profanity cues for verification (with timestamps)
  if (profanityCues.length > 0) {
    console.log(`[FFProfanity] First 10 profanity cues:`,
      profanityCues.slice(0, 10).map(c => ({
        id: c.id,
        time: `${Math.floor(c.startMs / 60000)}:${Math.floor((c.startMs % 60000) / 1000).toString().padStart(2, '0')}`,
        text: c.text.substring(0, 40),
        hasProfanity: c.hasProfanity
      }))
    );
  }

  // Start monitoring if we have a video
  if (cues.length > 0 && videoElement) {
    isActive = true;
    startMonitoring();
  }
}

/**
 * Start monitoring playback
 */
function startMonitoring(): void {
  if (!videoElement || animationFrameId) return;
  
  const updateLoop = () => {
    if (!isActive || !videoElement) return;
    
    updatePlayback(videoElement.currentTime * 1000);
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
  delay: number
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
  
  console.log(`[FFProfanity] MUTE: ${currentProfanityCue ? `cue ${currentProfanityCue.id}` : 'unknown'} at ${videoElement?.currentTime?.toFixed(2)}s`);
  
  browser.runtime.sendMessage({
    type: 'muteNow',
    reasonId: currentProfanityCue ? `cue-${currentProfanityCue.id}` : 'unknown',
    expectedUnmuteAt: currentProfanityCue?.endMs || 0,
  });
  isMuted = true;
}

/**
 * Send unmute message immediately (no debounce for tighter timing)
 */
function sendUnmuteNow(): void {
  if (!isMuted) return; // Already unmuted
  
  console.log(`[FFProfanity] UNMUTE at ${videoElement?.currentTime?.toFixed(2)}s`);
  
  browser.runtime.sendMessage({
    type: 'unmuteNow',
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
  const profanityCue = cueIndex.findProfanityCue(currentTimeMs, settings.offsetMs);
  const nextCues = cueIndex.getNextCues(currentTimeMs, 3, settings.offsetMs);

  // Handle muting: use profanity-specific check with pre-mute buffer
  if (profanityCue && !isMuted) {
    // Entering a profanity cue (with MUTE_ADVANCE_MS buffer already applied)
    currentProfanityCue = profanityCue;
    sendMuteNow();
  } else if (!profanityCue && isMuted) {
    // Leaving the profanity zone (with MUTE_DELAY_MS buffer applied)
    sendUnmuteNow();
    currentProfanityCue = null;
  }

  // Update overlay
  if (currentCue) {
    const displayText = currentCue.hasProfanity
      ? currentCue.censoredText
      : sanitizeText(currentCue.text);

    currentCueEl.textContent = displayText;
    currentCueEl.style.display = 'block';
    currentCueEl.classList.remove('ffprofanity-hidden');

    // Show next cues preview
    if (nextCues.length > 0) {
      const previews = nextCues
        .map(c => {
          const time = formatTime(c.startMs);
          const text = c.hasProfanity ? c.censoredText : sanitizeText(c.text);
          return `<div class="ffprofanity-preview">${time}: ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}</div>`;
        })
        .join('');
      nextCuesEl.innerHTML = previews;
    } else {
      nextCuesEl.innerHTML = '';
    }
  } else {
    currentCueEl.classList.add('ffprofanity-hidden');
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
    return `${hours}:${minutes.toString(10).padStart(2, '0')}:${seconds.toString(10).padStart(2, '0')}`;
  }
  return `${minutes}:${seconds.toString(10).padStart(2, '0')}`;
}

/**
 * Handle file input from options page
 */
function setupFileInput(): void {
  document.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement;
    if (target.type === 'file' && target.accept?.includes('.srt,.vtt,.ass')) {
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
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Keyboard shortcuts
document.addEventListener('keydown', (event) => {
  if (event.altKey && event.key === 'ArrowLeft') {
    settings.offsetMs -= 500;
    storage.setSetting('offsetMs', settings.offsetMs);
  } else if (event.altKey && event.key === 'ArrowRight') {
    settings.offsetMs += 500;
    storage.setSetting('offsetMs', settings.offsetMs);
  }
});