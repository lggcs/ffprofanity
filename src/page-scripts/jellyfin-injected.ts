/**
 * jellyfin Page Script - Injected into MAIN world to bypass CSP
 *
 * This script handles:
 * 1. Intercept PlaybackInfo API to capture subtitle URLs
 * 2. Monitor video.textTracks for native VTT/SRT subtitles
 * 3. Monitor hls.js for embedded subtitles in HLS streams
 * 4. Hide Jellyfin's native subtitle overlay
 *
 * Jellyfin subtitle handling:
 * - Native TextTrack: VTT/SRT embedded in video element
 * - ASS/SSA: Rendered via libass-wasm (canvas overlay) - cannot intercept
 * - PGSSUB: Rendered via libpgs (canvas overlay) - cannot intercept
 * - External: Loaded via API, URL in DeliveryUrl field
 */

(function () {
  "use strict";

  // Skip execution in iframes - only run in top frame
  if (window.self !== window.top) {
    return;
  }

  const EXTRACTOR_ID = "jellyfin";
  const sentSubtitles = new Set<string>();
  const sentContent = new Set<string>();

  function log(...args: unknown[]) {
    console.log(`[FFProfanity-jellyfin]`, ...args);
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
   * Format VTT timestamp
   */
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

  /**
   * Strategy 1: Intercept fetch for PlaybackInfo API
   * Jellyfin returns subtitle URLs in /Items/{id}/PlaybackInfo response
   */
  function interceptPlaybackInfo() {
    const originalFetch = window.fetch;

    window.fetch = async function (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      const url =
        typeof input === "string" ? input : (input as Request)?.url || "";

      try {
        const response = await originalFetch.call(this, input, init);

        // Check for PlaybackInfo API response
        if (url.includes("PlaybackInfo") || url.includes("playbackInfo")) {
          try {
            const clone = response.clone();
            const data = await clone.json();

            // Extract MediaStreams for subtitle tracks
            const mediaStreams = data.MediaStreams || [];
            const subtitleStreams = mediaStreams.filter(
              (s: any) => s.Type === "Subtitle",
            );

            if (subtitleStreams.length > 0) {
              const subs: Array<{ url: string; language: string; label: string }> = [];

              for (const stream of subtitleStreams) {
                // Check if this is an external/embedded subtitle with a URL
                const deliveryUrl = stream.DeliveryUrl || stream.Path;
                
                if (deliveryUrl) {
                  // Build full URL if relative
                  let subtitleUrl = deliveryUrl;
                  if (!deliveryUrl.startsWith("http")) {
                    try {
                      const baseUrl = new URL(url).origin;
                      subtitleUrl = baseUrl + (deliveryUrl.startsWith("/") ? "" : "/") + deliveryUrl;
                    } catch (e) {
                      // Use as-is if URL parsing fails
                    }
                  }

                  subs.push({
                    url: subtitleUrl,
                    language: stream.Language || "unknown",
                    label: stream.DisplayTitle || `Track ${stream.Index}`,
                  });

                  log(`Found subtitle: ${stream.DisplayTitle} (${stream.Language}) - ${deliveryUrl}`);
                }
              }

              if (subs.length > 0) {
                sendSubtitles(subs, "playbackInfo");
              }
            }
          } catch (e) {
            log("Error parsing PlaybackInfo response:", e);
          }
        }

        return response;
      } catch (e) {
        throw e;
      }
    };

    log("PlaybackInfo interceptor installed");
  }

  /**
   * Strategy 2: Intercept XHR for PlaybackInfo API
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

      if (url.includes("PlaybackInfo") || url.includes("playbackInfo")) {
        xhr.addEventListener("load", function () {
          try {
            const responseText = xhr.responseText;
            const data = JSON.parse(responseText);

            const mediaStreams = data.MediaStreams || [];
            const subtitleStreams = mediaStreams.filter(
              (s: any) => s.Type === "Subtitle",
            );

            if (subtitleStreams.length > 0) {
              const subs: Array<{ url: string; language: string; label: string }> = [];

              for (const stream of subtitleStreams) {
                const deliveryUrl = stream.DeliveryUrl || stream.Path;
                
                if (deliveryUrl) {
                  let subtitleUrl = deliveryUrl;
                  if (!deliveryUrl.startsWith("http")) {
                    try {
                      const baseUrl = new URL(url).origin;
                      subtitleUrl = baseUrl + (deliveryUrl.startsWith("/") ? "" : "/") + deliveryUrl;
                    } catch (e) {}
                  }

                  subs.push({
                    url: subtitleUrl,
                    language: stream.Language || "unknown",
                    label: stream.DisplayTitle || `Track ${stream.Index}`,
                  });
                }
              }

              if (subs.length > 0) {
                sendSubtitles(subs, "playbackInfo-xhr");
              }
            }
          } catch (e) {
            log("Error parsing XHR PlaybackInfo response:", e);
          }
        });
      }

      return nativeSend.apply(this, arguments as any) as void;
    };

    log("XHR interceptor installed");
  }

  /**
   * Strategy 3: Monitor video.textTracks for native VTT/SRT subtitles
   * Jellyfin can load subtitles as native TextTrack elements
   */
  function monitorVideoTextTracks() {
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
                const trackKey = `jellyfin-${track.label || track.language || i}`;

                if (!sentContent.has(trackKey) || 
                    (sentContent.has(trackKey) && track.cues.length > 0)) {
                  
                  if (!sentContent.has(trackKey)) {
                    sentContent.add(trackKey);

                    // Reconstruct VTT from cues
                    let vttContent = "WEBVTT\n\n";
                    const cues = Array.from(track.cues);
                    cues.forEach((cue, idx) => {
                      const vttcue = cue as VTTCue;
                      const start = formatVTTTime(vttcue.startTime);
                      const end = formatVTTTime(vttcue.endTime);
                      vttContent += idx + 1 + "\n";
                      vttContent += start + " --> " + end + "\n";
                      vttContent += vttcue.text + "\n\n";
                    });

                    log(`Captured ${cues.length} cues from textTrack: ${track.label || track.language}`);
                    sendSubtitleContent(
                      vttContent,
                      track.language || "en",
                      track.label || "Jellyfin Track",
                    );
                  }
                }
              }
            }
          }
        }
      } catch (e) {
        log("Error checking textTracks:", e);
      }
    };

    // Check periodically
    const check = () => {
      checkTextTracks();
      setTimeout(check, 2000);
    };
    setTimeout(check, 500);

    log("TextTrack monitor installed");
  }

  /**
   * Strategy 4: Hook into hls.js for HLS embedded subtitles
   * Jellyfin uses hls.js for HLS streaming
   */
  function interceptHLS() {
    // Wait for hls.js to be loaded
    const checkHLS = () => {
      const hlsInstances = (window as any).hlsjs?.instances || 
                          (window as any).Hls?.instances || [];

      if (hlsInstances.length > 0) {
        for (const hls of hlsInstances) {
          // hls.subtitleTracks contains loaded subtitle tracks
          if (hls.subtitleTracks && hls.subtitleTracks.length > 0) {
            for (const track of hls.subtitleTracks) {
              if (track.url && !sentSubtitles.has(track.url)) {
                sentSubtitles.add(track.url);
                sendSubtitles(
                  [{
                    url: track.url,
                    language: track.lang || "unknown",
                    label: track.name || track.lang || "HLS Track",
                  }],
                  "hls.js"
                );
              }
            }
          }
        }
      }
    };

    // Check periodically for HLS instances
    setInterval(checkHLS, 5000);
    setTimeout(checkHLS, 1000);

    log("HLS hook installed");
  }

  /**
   * Strategy 5: Hide Jellyfin's native subtitle overlay
   * Jellyfin uses custom overlay divs for ASS/PGS subtitles rendered via WASM
   */
  function hideNativeSubtitles() {
    const injectHideCSS = () => {
      const styleId = "ffprofanity-jellyfin-hide";
      if (document.getElementById(styleId)) return;

      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
        /* Jellyfin subtitle overlays */
        .videoSubtitles,
        .videoSubtitlesInner,
        .videoSecondarySubtitlesInner,
        .subtitleContainer,
        div[class*="subtitleOverlay"],
        div[class*="SubtitleOverlay"] {
          visibility: hidden !important;
          opacity: 0 !important;
        }

        /* libass-wasm canvas overlay */
        canvas.libass-js-canvas,
        div.libass-js-container {
          visibility: hidden !important;
          opacity: 0 !important;
        }

        /* Don't hide our overlay */
        #ffprofanity-overlay,
        #ffprofanity-subtitle-overlay {
          visibility: visible !important;
          opacity: 1 !important;
        }
      `;
      document.head.appendChild(style);
      log("Injected CSS to hide native Jellyfin subtitles");
    };

    // Disable video textTrack display mode
    const disableVideoTextTracks = () => {
      const videos = document.querySelectorAll("video");
      for (const video of videos) {
        if (video.textTracks) {
          for (let i = 0; i < video.textTracks.length; i++) {
            const track = video.textTracks[i];
            if (
              (track.kind === "subtitles" || track.kind === "captions") &&
              track.mode !== "disabled" &&
              track.mode !== "hidden"
            ) {
              log(`Disabling textTrack: ${track.label || track.language || i}`);
              // Use 'hidden' to keep cues accessible but not display
              track.mode = "hidden";
            }
          }
        }
      }
    };

    // Listen for messages from content script
    window.addEventListener("message", (event) => {
      if (
        event.source === window &&
        event.data?.type === "FFPROFANITY_HIDE_NATIVE_SUBTITLES"
      ) {
        log("Received HIDE_NATIVE_SUBTITLES message");
        injectHideCSS();
        disableVideoTextTracks();
      }
    });

    // Initial run
    setTimeout(injectHideCSS, 1000);
    setTimeout(disableVideoTextTracks, 1000);
    setTimeout(disableVideoTextTracks, 3000);
    setTimeout(disableVideoTextTracks, 5000);

    // Periodic check
    setInterval(disableVideoTextTracks, 5000);

    log("Native subtitle hiding installed");
  }

  /**
   * Strategy 6: Watch for video player container creation
   * Jellyfin creates player dynamically
   */
  function watchForPlayer() {
    const observer = new MutationObserver((mutations) => {
      let foundVideo = false;

      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLElement) {
            // Check for video element
            if (node.tagName === "VIDEO" || node.querySelector("video")) {
              foundVideo = true;
              break;
            }
            // Check for Jellyfin player container
            if (
              node.classList.contains("videoPlayerContainer") ||
              node.querySelector(".videoPlayerContainer") ||
              node.classList.contains("htmlvideoplayer") ||
              node.querySelector(".htmlvideoplayer")
            ) {
              foundVideo = true;
              break;
            }
          }
        }
        if (foundVideo) break;
      }

      if (foundVideo) {
        log("Video player container detected");
        // Re-run detection
        setTimeout(monitorVideoTextTracks, 500);
        setTimeout(hideNativeSubtitles, 500);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    log("Player observer installed");
  }

  /**
   * Strategy 7: Check for burned-in subtitles (DeliveryMethod: 'Encode')
   * When subtitles are transcoded into video, we cannot filter them
   */
  function checkBurnedIn(data: any): boolean {
    if (!data || !data.MediaSources) return false;

    for (const source of data.MediaSources) {
      const streams = source.MediaStreams || [];
      for (const stream of streams) {
        if (stream.Type === "Subtitle" && stream.DeliveryMethod === "Encode") {
          log(`Warning: Burned-in subtitle detected: ${stream.DisplayTitle}`);
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Initialize
   */
  function init() {
    log("Page script initializing...");

    // Install all interceptors and monitors
    interceptPlaybackInfo();
    interceptXHR();
    monitorVideoTextTracks();
    interceptHLS();
    hideNativeSubtitles();
    watchForPlayer();

    log("Page script ready");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();