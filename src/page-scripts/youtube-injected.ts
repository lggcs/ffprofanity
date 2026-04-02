/**
 * YouTube Page Script - Injected via browser.scripting.executeScript with world: 'MAIN'
 * This script runs in the page context to access ytInitialPlayerResponse
 * It bypasses CSP by being injected by the extension's background script
 * 
 * PO Token (POT) requirement:
 * YouTube requires PO Tokens for timedtext API when exp=xpe is present.
 * Real browsers generate POT via Web Integrity attestation, but automated
 * environments cannot. We intercept YouTube's own timedtext responses
 * which have proper POT already applied.
 */

export function youTubePageScript(): void {
  "use strict";

  const EXTRACTOR_ID = "youtube-ytInitialPlayerResponse";
  const sentSubtitleUrls = new Set<string>();
  const capturedTimedtext: Map<string, string> = new Map();

  function log(...args: unknown[]): void {
    console.log("[FFProfanity-YouTube]", ...args);
  }

  /**
   * Emit captured subtitle content to content script
   * Called immediately when we intercept timedtext responses
   */
  function emitSubtitleContent(url: string, content: string): void {
    try {
      const urlObj = new URL(url);
      const params = urlObj.searchParams;
      const videoId = params.get("v");
      const lang = params.get("lang") || "unknown";
      const kind = params.get("kind") || "";
      const isAsr = kind === "asr";

      log("Emitting captured subtitle:", videoId, lang, "isAsr:", isAsr, "bytes:", content.length);

      // Notify content script that we captured subtitles
      window.postMessage(
        {
          type: "FFPROFANITY_SUBTITLE_CAPTURED",
          source: EXTRACTOR_ID,
          videoId: videoId,
          language: lang,
          isAsr: isAsr,
          content: content,
          url: url,
        },
        "*",
      );
    } catch (e) {
      log("Error emitting subtitle content:", e);
    }
  }

  /**
   * Convert subtitle URL to WebVTT format
   */
  function ensureVttFormat(url: string): string | null {
    if (!url) return null;

    try {
      const urlObj = new URL(url);
      const params = urlObj.searchParams;

      // YouTube supports: vtt, json3, srv1, srv2, srv3, ttml
      // We need VTT for our parser
      if (params.get("fmt") !== "vtt") {
        params.set("fmt", "vtt");
      }

      return urlObj.toString();
    } catch {
      // Fallback: simple string replacement
      if (url.includes("fmt=")) {
        return url.replace(/fmt=[^&]+/, "fmt=vtt");
      }
      return url + (url.includes("?") ? "&" : "?") + "fmt=vtt";
    }
  }

  /**
   * Extract language info from track object
   */
  function getTrackLanguage(track: any): string {
    return track.languageCode || track.lang || "unknown";
  }

  /**
   * Extract label from track object
   */
  function getTrackLabel(track: any): string {
    if (track.name) {
      if (typeof track.name === "string") return track.name;
      if (track.name.simpleText) return track.name.simpleText;
      if (track.name.runs && track.name.runs[0]) return track.name.runs[0].text;
    }

    const lang = getTrackLanguage(track);
    const langNames: Record<string, string> = {
      en: "English",
      es: "Spanish",
      fr: "French",
      de: "German",
      it: "Italian",
      pt: "Portuguese",
      ru: "Russian",
      ja: "Japanese",
      ko: "Korean",
      zh: "Chinese",
      ar: "Arabic",
      hi: "Hindi",
      nl: "Dutch",
      pl: "Polish",
      sv: "Swedish",
      da: "Danish",
      fi: "Finnish",
      no: "Norwegian",
      tr: "Turkish",
      id: "Indonesian",
      th: "Thai",
      vi: "Vietnamese",
      uk: "Ukrainian",
      cs: "Czech",
    };
    return langNames[lang] || String(lang).toUpperCase();
  }

  // =========================================================================
  // CRITICAL: Set up interception IMMEDIATELY before anything else
  // This must happen before YouTube's player initializes and makes timedtext requests
  // =========================================================================
  
  log("Setting up XHR/fetch interception IMMEDIATELY...");
  
  // Intercept XHR to capture timedtext responses
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  
  XMLHttpRequest.prototype.open = function(method: string, url: string | URL, ...args: any[]) {
    (this as any)._ffprofanity_url = url.toString();
    return (originalXHROpen as any).apply(this, [method, url, ...args]);
  };
  
  XMLHttpRequest.prototype.send = function(body?: any) {
    const url = (this as any)._ffprofanity_url as string;
    
    if (url && url.includes("timedtext")) {
      const self = this;
      this.addEventListener("load", function() {
        const content = self.responseText;
        if (content && content.length > 10) {
          log("Captured timedtext via XHR:", url.substring(0, 100), "(", content.length, "bytes)");
          capturedTimedtext.set(url, content);
          emitSubtitleContent(url, content);
        }
      });
    }
    
    return (originalXHRSend as any).apply(this, [body]);
  };
  
  // Intercept fetch to capture timedtext responses
  const originalFetch = window.fetch;
  
  window.fetch = function(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input :
                (input as Request).url || (input as URL).toString();
    
    return (originalFetch as any).apply(this, [input, init]).then(async (response: Response) => {
      if (url && url.includes("timedtext")) {
        const clone = response.clone();
        try {
          const content = await clone.text();
          if (content && content.length > 10) {
            log("Captured timedtext via fetch:", url.substring(0, 100), "(", content.length, "bytes)");
            capturedTimedtext.set(url, content);
            emitSubtitleContent(url, content);
          } else {
            log("Empty timedtext response via fetch:", url.substring(0, 100));
          }
        } catch (e) {
          log("Error capturing timedtext fetch:", e);
        }
      }
      return response;
    });
  };
  
  log("XHR/fetch interception set up successfully");

  /**
   * Try to fetch subtitle content
   * First checks if we already captured it, otherwise tries direct fetch
   */
  async function fetchSubtitleContent(
    url: string,
    language: string,
    label: string,
  ): Promise<string | null> {
    // Check if we already captured this
    const cached = capturedTimedtext.get(url);
    if (cached) {
      log("Using cached timedtext for", language);
      window.postMessage(
        {
          type: "FFPROFANITY_SUBTITLE_CONTENT",
          source: EXTRACTOR_ID,
          language: language,
          label: label,
          content: cached,
        },
        "*",
      );
      return cached;
    }

    // We need to try fetching - but this may fail without POT
    // The interception handlers will capture successful responses
    try {
      log("Fetching subtitle:", language, url.substring(0, 80) + "...");

      const response = await fetch(url, {
        credentials: "include",
        headers: {
          Accept: "text/vtt,application/vtt,text/plain,*/*",
        },
      });

      if (!response.ok) {
        console.warn(
          "[FFProfanity-YouTube] Fetch failed:",
          response.status,
          response.statusText,
        );
        return null;
      }

      const text = await response.text();

      if (!text || text.length < 10) {
        console.warn("[FFProfanity-YouTube] Empty or too short response");
        return null;
      }

      log("Fetched", text.length, "bytes for", language);

      // Cache it
      capturedTimedtext.set(url, text);

      // Send the actual subtitle content back
      window.postMessage(
        {
          type: "FFPROFANITY_SUBTITLE_CONTENT",
          source: EXTRACTOR_ID,
          language: language,
          label: label,
          content: text,
        },
        "*",
      );

      return text;
    } catch (error) {
      console.error("[FFProfanity-YouTube] Fetch error:", error);
      return null;
    }
  }

  /**
   * Send detected subtitle tracks to content script
   */
  function sendSubtitleTracks(tracks: any[]): void {
    if (!tracks || tracks.length === 0) return;

    // Deduplicate by URL
    const uniqueTracks = tracks.filter((t) => {
      if (!t.url) return false;
      if (sentSubtitleUrls.has(t.url)) return false;
      sentSubtitleUrls.add(t.url);
      return true;
    });

    if (uniqueTracks.length === 0) return;

    log("Found", uniqueTracks.length, "caption tracks");

    // Send track metadata first
    window.postMessage(
      {
        type: "FFPROFANITY_SUBTITLES_DETECTED",
        source: EXTRACTOR_ID,
        subtitles: uniqueTracks.map((t) => ({
          url: t.url,
          language: t.language,
          label: t.label,
          isAsr: t.isAsr,
        })),
      },
      "*",
    );

    // Try to fetch - but the main mechanism is intercepting YouTube's own requests
    // Auto-fetch the first English track, or first track
    const englishTrack =
      uniqueTracks.find((t) => t.language === "en") || uniqueTracks[0];
    if (englishTrack) {
      fetchSubtitleContent(
        englishTrack.url,
        englishTrack.language,
        englishTrack.label,
      );
    }
  }

  /**
   * Extract caption tracks from ytInitialPlayerResponse
   */
  function extractFromInitialPlayerResponse(): void {
    try {
      const ypr = (window as any).ytInitialPlayerResponse;

      if (!ypr) {
        log("No ytInitialPlayerResponse found");
        return;
      }

      const captionTracks =
        ypr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

      if (!captionTracks || !Array.isArray(captionTracks)) {
        log("No captionTracks found");
        return;
      }

      log("Found", captionTracks.length, "caption tracks in page");

      const subtitles = captionTracks
        .map((track: any) => {
          const rawUrl = track.baseUrl || track.url;
          // Keep the original URL - it has POT params we need
          const vttUrl = ensureVttFormat(rawUrl);

          const isAsr =
            track.kind === "asr" ||
            (track.captionTrack && track.captionTrack.kind === "asr") ||
            track.trackName === "auto-generated";

          return {
            url: vttUrl,
            language: getTrackLanguage(track),
            label: getTrackLabel(track) + (isAsr ? " (Auto)" : ""),
            isAsr: isAsr,
          };
        })
        .filter((s: any) => s.url);

      sendSubtitleTracks(subtitles);
    } catch (e) {
      console.warn("[FFProfanity-YouTube] Error extracting:", e);
    }
  }

  /**
   * Watch for YouTube SPA navigation
   */
  function setupNavigationWatcher(): void {
    let lastUrl = location.href;

    const checkForNavigation = () => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        log("Navigation detected, re-extracting subtitles");
        sentSubtitleUrls.clear();
        // Clear cache for new video
        capturedTimedtext.clear();
        setTimeout(extractFromInitialPlayerResponse, 500);
        setTimeout(extractFromInitialPlayerResponse, 2000);
      }
    };

    // Override pushState/replaceState to detect navigation
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    if (originalPushState) {
      history.pushState = function (...args: any[]) {
        (originalPushState as any).apply(this, args);
        checkForNavigation();
      };
    }

    if (originalReplaceState) {
      history.replaceState = function (...args: any[]) {
        (originalReplaceState as any).apply(this, args);
        checkForNavigation();
      };
    }

    // Also listen for popstate
    window.addEventListener("popstate", checkForNavigation);
  }

  /**
   * Setup periodic extraction attempts
   */
  function setupResponseWatcher(): void {
    // Try multiple times during page load
    setTimeout(extractFromInitialPlayerResponse, 100);
    setTimeout(extractFromInitialPlayerResponse, 500);
    setTimeout(extractFromInitialPlayerResponse, 1000);
    setTimeout(extractFromInitialPlayerResponse, 2000);
    setTimeout(extractFromInitialPlayerResponse, 3000);
    setTimeout(extractFromInitialPlayerResponse, 5000);
  }

  /**
   * Listen for caption button clicks to trigger subtitle loading
   */
  function setupCaptionButtonListener(): void {
    // YouTube's captions are lazily loaded - they're fetched when user clicks CC button
    // We monitor for caption button clicks to capture the timedtext requests

    document.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      // Check if it's a caption/subtitle button
      const isCaptionButton =
        target.classList.contains("ytp-subtitles-button") ||
        target.closest(".ytp-subtitles-button");

      if (isCaptionButton) {
        log("Caption button clicked, will capture timedtext");
        // The fetch interception will capture the response
        // Re-extract in case new tracks are available
        setTimeout(() => extractFromInitialPlayerResponse(), 500);
        setTimeout(() => extractFromInitialPlayerResponse(), 2000);
      }
    }, true);
  }

  /**
   * Try to programmatically enable captions to trigger timedtext loading
   * This simulates a CC button click to make YouTube fetch the captions
   */
  function tryEnableCaptions(): void {
    // Find the CC button
    const ccButton = document.querySelector('.ytp-subtitles-button') as HTMLButtonElement;
    if (!ccButton) {
      log("No CC button found");
      return;
    }

    // Check if captions are already enabled (button has aria-pressed="true")
    const isEnabled = ccButton.getAttribute('aria-pressed') === 'true';

    if (isEnabled) {
      log("Captions already enabled, timedtext should be loading");
      
      // For live streams, check if tracks exist - if not, captions may not be available
      const ypr = (window as any).ytInitialPlayerResponse;
      const captionTracks = ypr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (!captionTracks || captionTracks.length === 0) {
        // Check if we've already tried to toggle captions for this stream
        if ((window as any).__ffprofanity_caption_toggled) {
          log("Live stream: No caption tracks available after toggle - stream may not have captions");
          return;
        }
        // Toggle captions OFF then ON to trigger timedtext fetch
        log("Live stream with no tracks - toggling captions to trigger timedtext");
        (window as any).__ffprofanity_caption_toggled = true;
        ccButton.click(); // OFF
        setTimeout(() => {
          ccButton.click(); // ON
          setTimeout(() => extractFromInitialPlayerResponse(), 500);
        }, 100);
        return;
      }
      return;
    }

    // Check if we've already tried (avoid infinite loop)
    if ((window as any).__ffprofanity_caption_triggered) {
      log("Already tried enabling captions");
      return;
    }
    (window as any).__ffprofanity_caption_triggered = true;

    log("Clicking CC button to trigger caption loading");

    // Simulate click to enable captions
    ccButton.click();

    // Optionally click again to toggle back off if user doesn't want captions
    // But keep them on for a moment so timedtext loads
    setTimeout(() => {
      // Check if there are actual captions now
      const tracks = document.querySelectorAll('track');
      log("After CC click, found", tracks.length, "track elements");

      // Re-extract to get any new tracks
      extractFromInitialPlayerResponse();
    }, 1000);
  }

  function init(): void {
    log("YouTube extractor initialized via MAIN world injection");

    // Interception is already set up above (IIFE)

    // Run immediately if ready
    if (
      document.readyState === "complete" ||
      document.readyState === "interactive"
    ) {
      extractFromInitialPlayerResponse();
      // Try to enable captions to trigger timedtext loading
      setTimeout(tryEnableCaptions, 1500);
    } else {
      document.addEventListener("DOMContentLoaded", () => {
        extractFromInitialPlayerResponse();
        // Try to enable captions after page loads
        setTimeout(tryEnableCaptions, 1500);
      });
    }

    // Setup watchers
    setupNavigationWatcher();
    setupResponseWatcher();
    setupCaptionButtonListener();

    // Also try on player ready (for embedded players or late initialization)
    // Watch for video element and try enabling captions when it appears
    const videoObserver = new MutationObserver(() => {
      const video = document.querySelector('video');
      const ccButton = document.querySelector('.ytp-subtitles-button');
      if (video && ccButton && !(window as any).__ffprofanity_caption_triggered) {
        setTimeout(tryEnableCaptions, 500);
      }
    });
    videoObserver.observe(document.body, { childList: true, subtree: true });
    
    // Disconnect after a few seconds to avoid overhead
    setTimeout(() => videoObserver.disconnect(), 10000);

    log("ytInitialPlayerResponse extraction ready");
    log("Network interception active - will capture timedtext responses");
  }

  init();
}

// Self-execute when loaded
if (typeof window !== "undefined") {
  youTubePageScript();
}