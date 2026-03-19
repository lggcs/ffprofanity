/**
 * Background Service Worker
 * Handles mute/unmute operations, message routing, and subtitle detection
 */

import type { MuteNowMessage, UnmuteNowMessage, CuesMessage, Settings, SubtitleTrack } from '../types';
import { isSubtitleUrl, detectSubtitleFormat } from '../lib/extractor';

// Active mute states per tab
const muteStates = new Map<number, {
  muted: boolean;
  reasonId: string | null;
  expectedUnmuteAt: number | null;
  safetyTimer: ReturnType<typeof setTimeout> | null;
}>();

// Detected subtitle URLs per tab
const detectedSubtitles = new Map<number, SubtitleTrack[]>();

// Pending cues and settings cache
const cuesCache = new Map<number, {
  cues: CuesMessage['cues'];
  settings: Settings;
}>();

/**
 * Mute a tab
 */
async function muteTab(tabId: number, reasonId: string, expectedUnmuteAt: number): Promise<void> {
  // Clear any existing safety timer
  const state = muteStates.get(tabId);
  if (state?.safetyTimer) {
    clearTimeout(state.safetyTimer);
  }
  
  // Set muted state
  muteStates.set(tabId, {
    muted: true,
    reasonId,
    expectedUnmuteAt,
    safetyTimer: null,
  });
  
  try {
    await browser.tabs.update(tabId, { muted: true });
    console.log(`Tab ${tabId} muted for reason ${reasonId}`);
  } catch (error) {
    console.error(`Failed to mute tab ${tabId}:`, error);
  }
  
  // Set safety timer in case unmute message never arrives
  const safetyDelay = expectedUnmuteAt - Date.now() + 1000; // 1 second buffer
  if (safetyDelay > 0 && safetyDelay < 60000) { // Max 1 minute safety timer
    const timer = setTimeout(async () => {
      const currentState = muteStates.get(tabId);
      if (currentState?.muted && currentState.reasonId === reasonId) {
        console.log(`Safety timer triggered, unmuting tab ${tabId}`);
        await unmuteTab(tabId, 'safety-timer');
      }
    }, safetyDelay);
    
    const currentState = muteStates.get(tabId);
    if (currentState) {
      currentState.safetyTimer = timer;
    }
  }
}

/**
 * Unmute a tab
 */
async function unmuteTab(tabId: number, reasonId: string): Promise<void> {
  const state = muteStates.get(tabId);
  
  // Clear safety timer
  if (state?.safetyTimer) {
    clearTimeout(state.safetyTimer);
  }
  
  // Only unmute if the reason matches or is from safety timer
  if (state?.muted) {
    try {
      await browser.tabs.update(tabId, { muted: false });
      console.log(`Tab ${tabId} unmuted`);
    } catch (error) {
      console.error(`Failed to unmute tab ${tabId}:`, error);
    }
  }
  
  muteStates.set(tabId, {
    muted: false,
    reasonId: null,
    expectedUnmuteAt: null,
    safetyTimer: null,
  });
}

/**
 * Handle messages from content scripts
 */
browser.runtime.onMessage.addListener((message: unknown, sender) => {
  if (!message || typeof message !== 'object') return;

  const msg = message as Record<string, unknown>;
  const tabId = sender.tab?.id;

  if (!tabId) return;

  console.log(`Received message from tab ${tabId}:`, msg.type);

  switch (msg.type) {
    case 'muteNow': {
      const muteMsg = message as MuteNowMessage;
      muteTab(tabId, muteMsg.reasonId, muteMsg.expectedUnmuteAt);
      break;
    }

    case 'unmuteNow': {
      unmuteTab(tabId, 'unmute-request');
      break;
    }

    case 'getStatus': {
      const state = muteStates.get(tabId);
      return Promise.resolve({
        type: 'status',
        muted: state?.muted ?? false,
        tabId,
      });
    }

    case 'getDetectedTracks': {
      const tracks = detectedSubtitles.get(tabId) || [];
      return Promise.resolve({
        type: 'detectedTracks',
        tracks,
        tabId,
      });
    }

    case 'clearDetectedTracks': {
      detectedSubtitles.delete(tabId);
      return Promise.resolve({ success: true });
    }
  }
});

/**
 * Intercept network requests to detect subtitle files
 */
browser.webRequest.onCompleted.addListener(
  (details) => {
    const url = details.url;
    
    // Check if this looks like a subtitle file
    if (!isSubtitleUrl(url)) return;
    
    const tabId = details.tabId;
    if (tabId < 0) return; // Not a valid tab
    
    // Get content type from response headers
    const contentType = details.responseHeaders?.find(
      h => h.name.toLowerCase() === 'content-type'
    )?.value;
    
    const format = detectSubtitleFormat(url, contentType);
    
    // Extract language from URL or filename
    const langMatch = url.match(/[_\-\/]([a-z]{2,3})(?:[_\-\.]|$)/i);
    const language = langMatch ? langMatch[1].toLowerCase() : undefined;
    
    // Extract label from filename
    const filenameMatch = url.match(/\/([^\/]+)\.(?:vtt|srt|ass|ssa)$/i);
    const label = filenameMatch 
      ? filenameMatch[1].replace(/[_\-\+]/g, ' ') 
      : `Subtitle (${format.toUpperCase()})`;
    
    const track: SubtitleTrack = {
      id: `network-${tabId}-${Date.now()}`,
      label,
      language: language || '',
      isSDH: /sdh|cc|hearing|deaf/i.test(label),
      isDefault: false,
      url,
      embedded: false,
      source: 'network',
      recommendScore: 0,
    };
    
    // Add to detected subtitles for this tab
    const existing = detectedSubtitles.get(tabId) || [];
    
    // Avoid duplicates
    if (!existing.some(t => t.url === track.url)) {
      detectedSubtitles.set(tabId, [...existing, track]);
      console.log(`Detected subtitle: ${label} (${url})`);
      
      // Notify content script of new track
      browser.tabs.sendMessage(tabId, {
        type: 'trackDetected',
        track,
      }).catch(() => {
        // Content script may not be ready, ignore
      });
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

/**
 * Handle tab removal - cleanup state
 */
browser.tabs.onRemoved.addListener((tabId) => {
  muteStates.delete(tabId);
  cuesCache.delete(tabId);
  detectedSubtitles.delete(tabId);
});

/**
 * Handle tab updates - clear detected subtitles on navigation
 */
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    // Clear detected subtitles when navigating to a new page
    detectedSubtitles.delete(tabId);
  }
});

// Initialize extension
browser.runtime.onInstalled.addListener((details) => {
  console.log('Profanity Filter installed:', details.reason);
});