/**
 * Background Service Worker
 * Handles mute/unmute operations, message routing, and subtitle detection
 */

import type {
  MuteNowMessage,
  UnmuteNowMessage,
  CuesMessage,
  Settings,
  SubtitleTrack,
} from "../types";
import { isSubtitleUrl, detectSubtitleFormat } from "../lib/extractor";

// Active mute states per tab
const muteStates = new Map<
  number,
  {
    muted: boolean;
    reasonId: string | null;
    expectedUnmuteAt: number | null;
    safetyTimer: ReturnType<typeof setTimeout> | null;
  }
>();

// Detected subtitle URLs per tab
const detectedSubtitles = new Map<number, SubtitleTrack[]>();

// Pending cues and settings cache
const cuesCache = new Map<
  number,
  {
    cues: CuesMessage["cues"];
    settings: Settings;
  }
>();

// Aggregated status per tab (collected from all frames)
const tabStatus = new Map<
  number,
  {
    hasVideo: boolean;
    active: boolean;
    cueCount: number;
    profanityCount: number;
    currentTrack: SubtitleTrack | null;
    detectedTracks: SubtitleTrack[];
    lastUpdated: number;
  }
>();

/**
 * Mute a tab
 */
async function muteTab(
  tabId: number,
  reasonId: string,
  expectedUnmuteAt: number,
): Promise<void> {
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
  if (safetyDelay > 0 && safetyDelay < 60000) {
    // Max 1 minute safety timer
    const timer = setTimeout(async () => {
      const currentState = muteStates.get(tabId);
      if (currentState?.muted && currentState.reasonId === reasonId) {
        console.log(`Safety timer triggered, unmuting tab ${tabId}`);
        await unmuteTab(tabId, "safety-timer");
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
 * Get aggregated status for a tab (from all frames)
 * Queries each frame individually to collect video/subtitle status
 */
async function getAggregatedStatus(tabId: number): Promise<{
  active: boolean;
  cueCount: number;
  profanityCount: number;
  hasVideo: boolean;
  currentTrack: SubtitleTrack | null;
  detectedTracks: SubtitleTrack[];
}> {
  let hasVideo = false;
  let active = false;
  let totalCues = 0;
  let totalProfanity = 0;
  let currentTrack: SubtitleTrack | null = null;
  const allTracks: SubtitleTrack[] = [];

  try {
    // Get all frames in the tab
    let frames: { frameId: number; url: string }[] = [];
    try {
      frames = await browser.webNavigation.getAllFrames({ tabId });
    } catch (e) {
      // webNavigation permission may not be available, query main frame only
      console.log("[FFProfanity] webNavigation.getAllFrames failed, querying main frame only");
    }

    if (!frames || frames.length === 0) {
      // Fallback: query main frame (frameId 0) directly
      frames = [{ frameId: 0, url: "" }];
    }

    // Query each frame, with error handling for cross-origin frames
    const framePromises = frames.map(async (frame) => {
      try {
        const response = await browser.tabs.sendMessage(
          tabId,
          { type: "getStatus" },
          { frameId: frame.frameId },
        );
        return { frameId: frame.frameId, response };
      } catch (e) {
        // Cross-origin frames may reject messages, that's OK
        return null;
      }
    });

    const results = await Promise.all(framePromises);

    // Process results - prioritize main frame (frameId 0) for currentTrack
    // Sort so main frame comes first
    results.sort((a, b) => {
      if (!a) return 1;
      if (!b) return -1;
      return a.frameId - b.frameId;
    });

    for (const result of results) {
      if (!result || !result.response || typeof result.response !== "object") continue;

      const s = result.response as {
        active?: boolean;
        cueCount?: number;
        profanityCount?: number;
        hasVideo?: boolean;
        currentTrack?: SubtitleTrack | null;
        detectedTracks?: SubtitleTrack[];
      };

      if (s.hasVideo) hasVideo = true;
      if (s.active) active = true;
      if (s.cueCount) totalCues = Math.max(totalCues, s.cueCount);
      if (s.profanityCount)
        totalProfanity = Math.max(totalProfanity, s.profanityCount);
      // Take currentTrack from first frame that has one (main frame comes first due to sort)
      if (s.currentTrack && !currentTrack) currentTrack = s.currentTrack;
      if (s.detectedTracks) {
        for (const track of s.detectedTracks) {
          if (
            !allTracks.some((t) => t.url === track.url || t.id === track.id)
          ) {
            allTracks.push(track);
          }
        }
      }
    }

    console.log(`[FFProfanity] Aggregated status for tab ${tabId}: hasVideo=${hasVideo}, cues=${totalCues}, active=${active}`);
  } catch (error) {
    console.error("[FFProfanity] Error getting frame status:", error);
  }

  // Update cache
  if (hasVideo) {
    tabStatus.set(tabId, {
      hasVideo,
      active,
      cueCount: totalCues,
      profanityCount: totalProfanity,
      currentTrack,
      detectedTracks: allTracks,
      lastUpdated: Date.now(),
    });
  }

  return {
    active,
    cueCount: totalCues,
    profanityCount: totalProfanity,
    hasVideo,
    currentTrack,
    detectedTracks: allTracks,
  };
}

/**
 * Handle messages from content scripts
 */
browser.runtime.onMessage.addListener((message: unknown, sender) => {
  if (!message || typeof message !== "object") return;

  const msg = message as Record<string, unknown>;
  const tabId = sender.tab?.id;

  if (!tabId) return;

  console.log(`Received message from tab ${tabId}:`, msg.type);

  switch (msg.type) {
    case "muteNow": {
      const muteMsg = message as MuteNowMessage;
      muteTab(tabId, muteMsg.reasonId, muteMsg.expectedUnmuteAt);
      break;
    }

    case "unmuteNow": {
      unmuteTab(tabId, "unmute-request");
      break;
    }

    case "getStatus": {
      const state = muteStates.get(tabId);
      return Promise.resolve({
        type: "status",
        muted: state?.muted ?? false,
        tabId,
      });
    }

    case "getAggregatedStatus": {
      // Popup requests aggregated status from all frames
      return getAggregatedStatus(tabId);
    }

    case "frameStatus": {
      // Content script (from any frame) reports its status
      // This allows us to track which frames have videos
      const frameStatus = msg as {
        hasVideo: boolean;
        active: boolean;
        cueCount: number;
        profanityCount: number;
        currentTrack: SubtitleTrack | null;
        detectedTracks: SubtitleTrack[];
      };

      // Update cached status for this tab
      const existing = tabStatus.get(tabId) || {
        hasVideo: false,
        active: false,
        cueCount: 0,
        profanityCount: 0,
        currentTrack: null,
        detectedTracks: [],
        lastUpdated: 0,
      };

      // Merge status (any frame with video means tab has video)
      tabStatus.set(tabId, {
        hasVideo: existing.hasVideo || frameStatus.hasVideo,
        active: existing.active || frameStatus.active,
        cueCount: Math.max(existing.cueCount, frameStatus.cueCount),
        profanityCount: Math.max(
          existing.profanityCount,
          frameStatus.profanityCount,
        ),
        currentTrack: frameStatus.currentTrack || existing.currentTrack,
        detectedTracks: [
          ...existing.detectedTracks,
          ...frameStatus.detectedTracks.filter(
            (t) =>
              !existing.detectedTracks.some(
                (et) => et.url === t.url || et.id === t.id,
              ),
          ),
        ],
        lastUpdated: Date.now(),
      });

      return Promise.resolve({ success: true });
    }

    case "getDetectedTracks": {
      const tracks = detectedSubtitles.get(tabId) || [];
      return Promise.resolve({
        type: "detectedTracks",
        tracks,
        tabId,
      });
    }

    case "clearDetectedTracks": {
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
      (h) => h.name.toLowerCase() === "content-type",
    )?.value;

    const format = detectSubtitleFormat(url, contentType);

    // Extract language from URL or filename
    const langMatch = url.match(/[_\-\/]([a-z]{2,3})(?:[_\-\.]|$)/i);
    const language = langMatch ? langMatch[1].toLowerCase() : undefined;

    // Extract label from filename
    const filenameMatch = url.match(/\/([^\/]+)\.(?:vtt|srt|ass|ssa)$/i);
    const label = filenameMatch
      ? filenameMatch[1].replace(/[_\-\+]/g, " ")
      : `Subtitle (${format.toUpperCase()})`;

    const track: SubtitleTrack = {
      id: `network-${tabId}-${Date.now()}`,
      label,
      language: language || "",
      isSDH: /sdh|cc|hearing|deaf/i.test(label),
      isDefault: false,
      url,
      embedded: false,
      source: "network",
      recommendScore: 0,
    };

    // Add to detected subtitles for this tab
    const existing = detectedSubtitles.get(tabId) || [];

    // Avoid duplicates
    if (!existing.some((t) => t.url === track.url)) {
      detectedSubtitles.set(tabId, [...existing, track]);
      console.log(`Detected subtitle: ${label} (${url})`);

      // Notify content script of new track
      browser.tabs
        .sendMessage(tabId, {
          type: "trackDetected",
          track,
        })
        .catch(() => {
          // Content script may not be ready, ignore
        });
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"],
);

/**
 * Handle tab removal - cleanup state
 */
browser.tabs.onRemoved.addListener((tabId) => {
  muteStates.delete(tabId);
  cuesCache.delete(tabId);
  detectedSubtitles.delete(tabId);
  tabStatus.delete(tabId);
});

/**
 * Handle tab updates - clear detected subtitles on navigation
 */
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    // Clear detected subtitles when navigating to a new page
    detectedSubtitles.delete(tabId);
    tabStatus.delete(tabId);
  }
});

// Initialize extension
browser.runtime.onInstalled.addListener((details) => {
  console.log("Profanity Filter installed:", details.reason);
});

/**
 * Inject page scripts into tabs via scripting.executeScript with world: 'MAIN'
 * This bypasses CSP restrictions on sites like PlutoTV
 * Uses onCommitted for early injection (before page scripts run)
 */
const injectedTabs = new Set<number>();

// Add CORS headers for subtitle requests so content script can fetch them
browser.declarativeNetRequest
  .updateDynamicRules({
    addRules: [
      {
        id: 1,
        priority: 1,
        action: {
          type: "modifyHeaders" as const,
          responseHeaders: [
            {
              header: "Access-Control-Allow-Origin",
              operation: "set" as const,
              value: "*",
            },
            {
              header: "Access-Control-Allow-Methods",
              operation: "set" as const,
              value: "GET, HEAD, OPTIONS",
            },
            {
              header: "Access-Control-Allow-Credentials",
              operation: "set" as const,
              value: "true",
            },
          ],
        },
        condition: {
          urlFilter: "*://*/*.vtt*",
          resourceTypes: ["xmlhttprequest", "other", "media"],
        },
      },
      {
        id: 2,
        priority: 1,
        action: {
          type: "modifyHeaders" as const,
          responseHeaders: [
            {
              header: "Access-Control-Allow-Origin",
              operation: "set" as const,
              value: "*",
            },
          ],
        },
        condition: {
          urlFilter: "*://*/*.vtt*",
          resourceTypes: ["main_frame", "sub_frame"],
        },
      },
    ],
  })
  .catch((err) => {
    // Rules may already exist, ignore error
    if (!err.message?.includes("Duplicate rule id")) {
      console.warn("[FFProfanity] declarativeNetRequest setup:", err);
    }
  });

async function injectPageScriptForUrl(
  tabId: number,
  url: string,
): Promise<boolean> {
  // Prevent double injection
  if (injectedTabs.has(tabId)) {
    return false;
  }

  // PlutoTV injection
  if (/pluto\.tv|plutotv\.com/i.test(url)) {
    try {
      await browser.scripting.executeScript({
        target: { tabId },
        files: ["page-scripts/plutotv-injected.js"],
        world: "MAIN" as any,
      });
      injectedTabs.add(tabId);
      console.log(`[FFProfanity] Injected PlutoTV script into tab ${tabId}`);
      return true;
    } catch (error) {
      console.error(`[FFProfanity] Failed to inject script:`, error);
      injectedTabs.delete(tabId);
      return false;
    }
  }

  // YouTube injection - bypasses CSP by using MAIN world
  if (/youtube\.com|youtu\.be|youtube-nocookie\.com/i.test(url)) {
    try {
      await browser.scripting.executeScript({
        target: { tabId },
        files: ["page-scripts/youtube-injected.js"],
        world: "MAIN" as any,
      });
      injectedTabs.add(tabId);
      console.log(`[FFProfanity] Injected YouTube script into tab ${tabId}`);
      return true;
    } catch (error) {
      console.error(`[FFProfanity] Failed to inject YouTube script:`, error);
      injectedTabs.delete(tabId);
      return false;
    }
  }

  // fmovies injection - bypasses CSP by using MAIN world
  if (/fmovies\.[a-z]+|fmovie\.[a-z]+/i.test(url)) {
    try {
      await browser.scripting.executeScript({
        target: { tabId },
        files: ["page-scripts/fmovies-injected.js"],
        world: "MAIN" as any,
      });
      injectedTabs.add(tabId);
      console.log(`[FFProfanity] Injected fmovies script into tab ${tabId}`);
      return true;
    } catch (error) {
      console.error(`[FFProfanity] Failed to inject fmovies script:`, error);
      injectedTabs.delete(tabId);
      return false;
    }
  }

  // LookMovie injection - bypasses CSP by using MAIN world
  if (/lookmovie\d*\.to|lookmovie\.[a-z]+|lookmovie\d*\.[a-z]+/i.test(url)) {
    try {
      await browser.scripting.executeScript({
        target: { tabId },
        files: ["page-scripts/lookmovie-injected.js"],
        world: "MAIN" as any,
      });
      injectedTabs.add(tabId);
      console.log(`[FFProfanity] Injected LookMovie script into tab ${tabId}`);
      return true;
    } catch (error) {
      console.error(`[FFProfanity] Failed to inject LookMovie script:`, error);
      injectedTabs.delete(tabId);
      return false;
    }
  }

  return false;
}

browser.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  injectedTabs.delete(details.tabId);
  await injectPageScriptForUrl(details.tabId, details.url);
});

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url) {
    await injectPageScriptForUrl(tabId, tab.url);
  }
});
