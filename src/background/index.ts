/**
 * Background Service Worker
 * Handles mute/unmute operations and message routing
 */

import type { MuteNowMessage, UnmuteNowMessage, CuesMessage, Settings } from './types';

// Active mute states per tab
const muteStates = new Map<number, {
  muted: boolean;
  reasonId: string | null;
  expectedUnmuteAt: number | null;
  safetyTimer: ReturnType<typeof setTimeout> | null;
}>();

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
  }
});

/**
 * Handle tab removal - cleanup state
 */
browser.tabs.onRemoved.addListener((tabId) => {
  muteStates.delete(tabId);
  cuesCache.delete(tabId);
});

// Initialize extension
browser.runtime.onInstalled.addListener((details) => {
  console.log('Profanity Filter installed:', details.reason);
});