/**
 * Content Script
 * Monitors video playback, renders subtitle overlay, and triggers mute/unmute
 */

import { storage } from '../lib/storage';
import { parseSubtitle, sanitizeText } from '../lib/parser';
import { ProfanityDetector, createDetector } from '../lib/detector';
import { CueIndex } from '../lib/cueIndex';
import type { Cue, Settings, DetectionResult } from '../types';

// State
let cues: Cue[] = [];
let detector: ProfanityDetector;
let settings: Settings;
let cueIndex: CueIndex;

// DOM elements
let overlayContainer: HTMLDivElement | null = null;
let currentCueEl: HTMLDivElement | null = null;
let nextCuesEl: HTMLDivElement | null = null;

// Video state
let videoElement: HTMLVideoElement | null = null;
let isActive = false;
let animationFrameId: ReturnType<typeof requestAnimationFrame> | null = null;
let lastCueId: number | null = null;

// Debouncing
let muteDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let unmuteTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Initialize the content script
 */
async function init(): Promise<void> {
  // Load settings
  settings = await storage.getSettings();
  
  // Create detector
  detector = createDetector(settings);
  if (settings.wordlist.length > 0) {
    detector.addWords(settings.wordlist);
  }
  
  // Initialize cue index
  cueIndex = new CueIndex();
  
  // Find video element
  findVideoElement();
  
  // Create overlay
  createOverlay();
  
  // Load saved cues
  const savedCues = await storage.getCues();
  if (savedCues.length > 0) {
    processCues(savedCues);
  }
  
  // Listen for storage changes
  browser.storage.onChanged.addListener(handleStorageChange);
  
  // Listen for messages from popup
  browser.runtime.onMessage.addListener(handleMessage);
}

/**
 * Find video element on page
 */
function findVideoElement(): void {
  const videos = document.querySelectorAll('video');
  if (videos.length > 0) {
    videoElement = videos[0] as HTMLVideoElement;
    
    // Also observe for new video elements
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLVideoElement) {
            videoElement = node;
          }
        }
      }
    });
    
    observer.observe(document.body, { childList: true, subtree: true });
  }
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
      @keyframes fadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @keyframes fadeOut {
        from { opacity: 1; }
        to { opacity: 0; }
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
function handleMessage(message: unknown): Promise<void> {
  if (!message || typeof message !== 'object') return Promise.resolve();
  
  const msg = message as Record<string, unknown>;
  
  switch (msg.type) {
    case 'uploadCues':
      const content = msg.content as string;
      handleSubtitleUpload(content);
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
      });
  }
  
  return Promise.resolve();
}

/**
 * Handle uploaded subtitle file
 */
async function handleSubtitleUpload(content: string): Promise<void> {
  const result = parseSubtitle(content);
  
  if (result.errors.length > 0) {
    console.error('Parse errors:', result.errors);
    return;
  }
  
  processCues(result.cues);
  await storage.setCues(cues);
}

/**
 * Process cues with profanity detection
 */
function processCues(newCues: Cue[]): void {
  cues = newCues.map(cue => {
    const detection = detector.detect(cue.text);
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
 * Debounced mute function
 */
const debouncedMute = debounce((tabId: number, cueId: string, expectedUnmuteAt: number) => {
  browser.runtime.sendMessage({
    type: 'muteNow',
    tabId,
    reasonId: cueId,
    expectedUnmuteAt,
  });
}, 50);

/**
 * Debounced unmute function
 */
const debouncedUnmute = debounce(() => {
  browser.runtime.sendMessage({
    type: 'unmuteNow',
  });
}, 50);

/**
 * Update playback based on current video time
 */
function updatePlayback(currentTimeMs: number): void {
  if (!videoElement || !currentCueEl) return;
  
  const effectiveTime = currentTimeMs + settings.offsetMs;
  const currentCue = cueIndex.findActive(currentTimeMs, settings.offsetMs);
  const nextCues = cueIndex.getNextCues(currentTimeMs, 3, settings.offsetMs);
  
  // Handle muting for profanity
  if (currentCue?.hasProfanity && currentCue.id !== lastCueId) {
    // entering a profanity cue
    debouncedMute(
      0, // will be set by background
      `cue-${currentCue.id}`,
      currentCue.endMs
    );
    lastCueId = currentCue.id;
  } else if (!currentCue?.hasProfanity && lastCueId !== null) {
    // leaving a profanity cue
    debouncedUnmute();
    lastCueId = null;
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