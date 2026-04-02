/**
 * fmovies Page Script - Injected into MAIN world to bypass CSP
 *
 * This script handles:
 * 1. Fetch/XHR interception to capture subtitle URLs from sub.wyzie.io
 * 2. Video textTrack monitoring for loaded subtitles
 * 3. Auto-selection of English CC track when subtitle modal opens
 *
 * fmovies subtitle selector structure (from inspection):
 * - Language items have flag image, language name, language code
 * - CC badge indicates captioned content: <div>CC</div> with cyan gradient style
 * - English with CC: flag=US, text="English", code="en", plus CC badge
 */

(function () {
  "use strict";

  const EXTRACTOR_ID = "fmovies";
  const sentSubtitles = new Set<string>();
  const sentContent = new Set<string>();
  let ccAutoClicked = false;

  function log(...args: unknown[]) {
    console.log(`[FFProfanity-fmovies]`, ...args);
  }

  /**
   * Send detected subtitle URLs to content script
   */
  function sendSubtitles(
    subs: Array<{ url: string; language: string; label: string }>,
    source: string,
  ) {
    if (!subs || subs.length === 0) return;

    const uniqueSubs = subs.filter((s) => {
      if (!s.url) return false;
      if (sentSubtitles.has(s.url)) return false;
      sentSubtitles.add(s.url);
      return true;
    });

    if (uniqueSubs.length === 0) return;

    log(`Sending ${uniqueSubs.length} subtitles from ${source}`);
    window.postMessage(
      {
        type: "FFPROFANITY_SUBTITLES_DETECTED",
        source: `${EXTRACTOR_ID}.${source}`,
        subtitles: uniqueSubs,
      },
      "*",
    );
  }

  /**
   * Send subtitle content directly to content script
   */
  function sendSubtitleContent(
    content: string,
    language: string,
    label: string,
  ) {
    const contentHash = content.length + "_" + content.indexOf("-->");
    if (sentContent.has(contentHash)) return;
    sentContent.add(contentHash);

    log(`Sending subtitle content: ${content.length} bytes for ${language}`);
    window.postMessage(
      {
        type: "FFPROFANITY_SUBTITLE_CONTENT",
        source: EXTRACTOR_ID,
        content,
        language,
        label,
      },
      "*",
    );
  }

  /**
   * Extract language from URL patterns
   */
  function extractLanguageFromUrl(url: string): string | null {
    const patterns = [
      /[?&]lang=([a-z]{2,3})/i,
      /[?&]language=([a-z]{2,3})/i,
      /[_\-\.]([a-z]{2,3})\.(vtt|srt|ass|ssa)$/i,
      /\/([a-z]{2,3})_[a-f0-9]+\.vtt/i,
    ];
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) return match[1].toLowerCase();
    }
    return null;
  }

  /**
   * Strategy 1: Intercept fetch requests to capture subtitle URLs
   */
  function interceptFetch() {
    const originalFetch = window.fetch;

    window.fetch = async function (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      const url =
        typeof input === "string" ? input : (input as Request)?.url || "";

      try {
        const response = await originalFetch.call(this, input, init);

        // Check for sub.wyzie.io subtitle URLs
        const isSubtitleUrl =
          url.includes("sub.wyzie.io/c/") &&
          (url.includes("format=srt") || url.includes("format=vtt"));

        if (isSubtitleUrl) {
          try {
            const clone = response.clone();
            const text = await clone.text();

            if (text.includes("-->")) {
              const language = extractLanguageFromUrl(url) || "en";
              log(`Captured subtitle from fetch: ${url.substring(0, 100)}`);
              sendSubtitleContent(text, language, "Wyzie");
            }
          } catch (e) {
            log("Error reading subtitle fetch response:", e);
          }
        }

        return response;
      } catch (e) {
        throw e;
      }
    };

    log("Fetch interceptor installed");
  }

  /**
   * Strategy 2: Intercept XHR requests
   */
  function interceptXHR() {
    const nativeOpen = XMLHttpRequest.prototype.open;
    const nativeSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (
      method: string,
      url: string,
    ): XMLHttpRequest {
      (this as any)._ffprofanity_url = url;
      return nativeOpen.apply(this, arguments as any) as XMLHttpRequest;
    };

    XMLHttpRequest.prototype.send = function (): void {
      const url = (this as any)._ffprofanity_url || "";
      const xhr = this;

      if (url.includes("sub.wyzie.io") || url.includes(".vtt") || url.includes(".srt")) {
        xhr.addEventListener("load", function () {
          try {
            const responseText = xhr.responseText;
            if (responseText && responseText.includes("-->")) {
              const language = extractLanguageFromUrl(url) || "en";
              log(`Captured subtitle from XHR: ${url.substring(0, 100)}`);
              sendSubtitleContent(responseText, language, "XHR");
            }
          } catch (e) {
            log("Error reading XHR response:", e);
          }
        });
      }

      return nativeSend.apply(this, arguments as any) as void;
    };

    log("XHR interceptor installed");
  }

  /**
   * Strategy 3: Monitor video textTracks for dynamically loaded subtitles
   * This is the PRIMARY method - subtitles from textTracks are already synced
   */
  function monitorVideoTextTracks() {
    let lastCueCount = 0;

    const checkTextTracks = () => {
      try {
        const videos = document.querySelectorAll("video");
        for (const video of videos) {
          if (video.textTracks && video.textTracks.length > 0) {
            for (let i = 0; i < video.textTracks.length; i++) {
              const track = video.textTracks[i];
              if (
                (track.kind === "subtitles" || track.kind === "captions") &&
                track.cues &&
                track.cues.length > 0
              ) {
                const cues = Array.from(track.cues);
                const trackKey =
                  track.label || track.language || String(i);

                if (
                  cues.length > 0 &&
                  !sentContent.has(trackKey) &&
                  cues.length !== lastCueCount
                ) {
                  sentContent.add(trackKey);
                  lastCueCount = cues.length;

                  // Reconstruct VTT from cues
                  let vttContent = "WEBVTT\n\n";
                  cues.forEach((cue, idx) => {
                    const vttcue = cue as VTTCue;
                    const start = formatVTTTime(vttcue.startTime);
                    const end = formatVTTTime(vttcue.endTime);
                    vttContent += idx + 1 + "\n";
                    vttContent += start + " --> " + end + "\n";
                    vttContent += vttcue.text + "\n\n";
                  });

                  log(
                    `Captured ${cues.length} cues from textTrack: ${track.label || track.language}`,
                  );
                  sendSubtitleContent(
                    vttContent,
                    track.language || "en",
                    track.label || "Video Track",
                  );
                }
              }
            }
          }
        }
      } catch (e) {
        log("Error checking textTracks:", e);
      }
    };

    function formatVTTTime(seconds: number): string {
      const hrs = Math.floor(seconds / 3600);
      const mins = Math.floor((seconds % 3600) / 60);
      const secs = Math.floor(seconds % 60);
      const ms = Math.floor((seconds % 1) * 1000);
      return (
        String(hrs).padStart(2, "0") +
        ":" +
        String(mins).padStart(2, "0") +
        ":" +
        String(secs).padStart(2, "0") +
        "." +
        String(ms).padStart(3, "0")
      );
    }

    // Check periodically
    let interval = 1000;
    const check = () => {
      checkTextTracks();
      if (interval < 5000) {
        interval = Math.min(interval * 1.5, 5000);
      }
      setTimeout(check, interval);
    };
    setTimeout(check, 500);

    log("TextTrack monitor installed");
  }

  /**
   * Strategy 4: Auto-click English CC subtitle when modal opens
   * fmovies shows subtitles in a language selection modal
   * We detect the modal and click on the English option with CC badge
   */
  function setupAutoCCSelection() {
    // Look for language selector items
    // Structure from user inspection:
    // <div class="flex items-center space-x-3">
    //   <div class="w-10 h-10 rounded-xl..."><img src="...flagsapi.com/US/flat/24.png"...></div>
    //   <div class="flex flex-col items-start">
    //     <div class="text-sm font-medium text-white">English</div>
    //     <div class="text-[11px] text-white/50">en</div>
    //   </div>
    // </div>
    // <div class="flex items-center space-x-2">
    //   <div class="px-2 py-1 rounded-lg text-[10px] font-medium" style="background: linear-gradient(135deg, rgba(97, 218, 251, 0.15)...)">CC</div>
    // </div>

    const findAndClickEnglishCC = () => {
      if (ccAutoClicked) return false;

      // Look for subtitle/language selector items
      // The CC badge has cyan gradient background: rgba(97, 218, 251, ...)
      const ccBadges = document.querySelectorAll(
        'div[style*="rgba(97, 218, 251"]',
      );

      for (const badge of ccBadges) {
        // Check if this is a CC badge (contains "CC" text)
        if (badge.textContent?.trim() !== "CC") continue;

        // Find the parent language item container
        // Walk up to find the language item
        let container = badge.parentElement;
        for (let i = 0; i < 5 && container; i++) {
          container = container?.parentElement || null;
        }

        if (!container) continue;

        // Look for English language text within this container
        const englishText = container.querySelector(
          '.text-sm.font-medium.text-white',
        );
        if (englishText?.textContent?.toLowerCase().includes("english")) {
          // Found English with CC badge - click it
          log("Found English with CC badge, clicking...");
          const clickable =
            container.closest("button") ||
            container.closest('[role="button"]') ||
            container.closest("div.cursor-pointer") ||
            container;
          if (clickable instanceof HTMLElement) {
            clickable.click();
            ccAutoClicked = true;
            log("Clicked English CC subtitle");
            return true;
          }
        }
      }

      // Alternative: Look for language items with "en" code
      const langItems = document.querySelectorAll('.text-\\[11px\\].text-white\\/50');
      for (const item of langItems) {
        if (item.textContent?.trim().toLowerCase() === "en") {
          // Check if there's a CC sibling
          const parent = item.closest(".flex.items-center");
          if (parent) {
            const nextSibling = parent?.nextElementSibling;
            if (nextSibling?.textContent?.includes("CC")) {
              log("Found English (en) with CC badge");
              const clickable =
                parent.closest("button") ||
                parent.closest('[role="button"]') ||
                parent.closest("div.cursor-pointer") ||
                parent;
              if (clickable instanceof HTMLElement) {
                clickable.click();
                ccAutoClicked = true;
                log("Clicked English CC subtitle");
                return true;
              }
            }
          }
        }
      }

      return false;
    };

    // Watch for modal opening with MutationObserver
    const modalObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLElement) {
            // Check if a modal or dropdown appeared
            if (
              node.classList.contains("modal") ||
              node.classList.contains("dropdown") ||
              node.querySelector('[class*="subtitle"]') ||
              node.querySelector('[class*="language"]')
            ) {
              setTimeout(() => findAndClickEnglishCC(), 100);
              return;
            }
          }
        }
      }
    });

    modalObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });

    // Also try on click events (when user opens subtitle selector)
    document.addEventListener(
      "click",
      (e) => {
        const target = e.target as HTMLElement;
        // Check if click is on subtitle/language button
        if (
          target.closest('[class*="subtitle"]') ||
          target.closest('[class*="language"]') ||
          target.closest('[aria-label*="subtitle"]') ||
          target.closest('[aria-label*="language"]')
        ) {
          setTimeout(() => findAndClickEnglishCC(), 100);
          setTimeout(() => findAndClickEnglishCC(), 500);
          setTimeout(() => findAndClickEnglishCC(), 1000);
        }
      },
      true,
    );

    // Also poll periodically when video is playing
    setInterval(() => {
      if (!ccAutoClicked) {
        // Check if subtitle modal is visible
        const visibleModal = document.querySelector(
          '.modal[style*="display: block"], .dropdown:not(.hidden), [class*="subtitle-selector"]:not(.hidden)',
        );
        if (visibleModal) {
          findAndClickEnglishCC();
        }
      }
    }, 2000);

    log("Auto CC selection installed");
  }

  /**
   * Strategy 5: Hide native subtitles
   * After capturing subtitles, disable native display to prevent double-view
   * Uses both JavaScript API (textTrack.mode = 'disabled') and CSS injection
   */
  function hideNativeSubtitles() {
    // Method 1: Disable video element textTracks directly
    const disableVideoTextTracks = () => {
      const videos = document.querySelectorAll("video");
      for (const video of videos) {
        if (video.textTracks) {
          for (let i = 0; i < video.textTracks.length; i++) {
            const track = video.textTracks[i];
            if (
              (track.kind === "subtitles" || track.kind === "captions") &&
              track.mode !== "disabled"
            ) {
              log(
                `Disabling textTrack: ${track.label || track.language || i}`,
              );
              track.mode = "disabled";
            }
          }
        }
      }
    };

    // Method 2: Check for Video.js player
    const disableVideoJSTracks = () => {
      // Check window.videoJS
      const videoJS = (window as any).videoJS;
      if (videoJS && typeof videoJS.textTracks === "function") {
        try {
          const tracks = videoJS.textTracks();
          for (let i = 0; i < tracks.length; i++) {
            const track = tracks[i];
            if (
              (track.kind === "subtitles" || track.kind === "captions") &&
              track.mode !== "disabled"
            ) {
              log(`Disabling Video.js track: ${track.label || track.language}`);
              track.mode = "disabled";
            }
          }
        } catch (e) {
          // Ignore errors
        }
      }

      // Check window.videojs.players
      const videojs = (window as any).videojs;
      if (videojs && videojs.players) {
        for (const playerId in videojs.players) {
          try {
            const player = videojs.players[playerId];
            if (player && typeof player.textTracks === "function") {
              const tracks = player.textTracks();
              for (let i = 0; i < tracks.length; i++) {
                const track = tracks[i];
                if (
                  (track.kind === "subtitles" || track.kind === "captions") &&
                  track.mode !== "disabled"
                ) {
                  log(`Disabling videojs.players track: ${track.label || track.language}`);
                  track.mode = "disabled";
                }
              }
            }
          } catch (e) {
            // Ignore errors
          }
        }
      }
    };

    // Method 3: Inject CSS to hide subtitle display elements
    const injectHideCSS = () => {
      const styleId = "ffprofanity-hide-native-subtitles";
      if (document.getElementById(styleId)) return;

      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
        /* Video.js subtitle display */
        .vjs-text-track-display { visibility: hidden !important; opacity: 0 !important; }
        .vjs-text-track-cue { visibility: hidden !important; opacity: 0 !important; }
        .video-js .vjs-text-track-display { visibility: hidden !important; opacity: 0 !important; }
        
        /* fmovies-specific subtitle containers */
        .vjs-text-track-display div { visibility: hidden !important; opacity: 0 !important; }
        div[class*="cue"] { visibility: hidden !important; opacity: 0 !important; }
        
        /* Generic subtitle overlays */
        [class*="subtitle-display"] { visibility: hidden !important; }
        [class*="captions-display"] { visibility: hidden !important; }
      `;
      document.head.appendChild(style);
      log("Injected CSS to hide native subtitles");
    };

    // Listen for messages from content script
    window.addEventListener("message", (event) => {
      if (
        event.source === window &&
        event.data?.type === "FFPROFANITY_HIDE_NATIVE_SUBTITLES"
      ) {
        log("Received HIDE_NATIVE_SUBTITLES message");
        disableVideoTextTracks();
        disableVideoJSTracks();
        injectHideCSS();
      }
    });

    // Run immediately and periodically
    const runHide = () => {
      disableVideoTextTracks();
      disableVideoJSTracks();
    };

    // Initial run after a delay
    setTimeout(runHide, 1000);
    setTimeout(runHide, 3000);
    setTimeout(runHide, 5000);
    setTimeout(injectHideCSS, 1000);

    // Also run periodically when video is playing
    setInterval(runHide, 10000);

    // Watch for new video elements
    const videoObserver = new MutationObserver(() => {
      const videos = document.querySelectorAll("video");
      if (videos.length > 0) {
        runHide();
      }
    });

    videoObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });

    log("Native subtitle hiding installed");
  }

  /**
   * Initialize
   */
  function init() {
    log("Page script initializing...");

    // Install interceptors
    interceptFetch();
    interceptXHR();
    monitorVideoTextTracks();
    setupAutoCCSelection();
    hideNativeSubtitles();

    log("Page script ready");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();