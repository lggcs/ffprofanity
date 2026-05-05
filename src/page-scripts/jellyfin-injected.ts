/**
 * jellyfin Page Script - Injected into MAIN world to bypass CSP
 *
 * This script handles:
 * 1. Intercept PlaybackInfo API to capture subtitle URLs
 * 2. Monitor video.textTracks for native VTT/SRT subtitles
 * 3. Monitor hls.js for embedded subtitles in HLS streams
 * 4. Hide Jellyfin's native subtitle overlay
 */

import {
  formatVTTTime,
} from "../lib/page-script-helpers";
import {
  createSendSubtitles,
  createSendSubtitleContent,
  createLog,
  type SubtitleTrack,
} from "../lib/network-interception";

const log = createLog();
const sendSubtitles = createSendSubtitles("jellyfin");
const sendSubtitleContent = createSendSubtitleContent("jellyfin");

function interceptPlaybackInfo(): void {
  const originalFetch = window.fetch;

  (window as any).fetch = async function (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === "string" ? input : (input as Request)?.url || "";

    try {
      const response = await originalFetch.call(this, input, init);

      if (url.includes("PlaybackInfo") || url.includes("playbackInfo")) {
        try {
          const clone = response.clone();
          const data = await clone.json();

          const mediaStreams = data.MediaStreams || [];
          const subtitleStreams = mediaStreams.filter((s: any) => s.Type === "Subtitle");

          if (subtitleStreams.length > 0) {
            const subs: SubtitleTrack[] = [];

            for (const stream of subtitleStreams) {
              const deliveryUrl = stream.DeliveryUrl || stream.Path;

              if (deliveryUrl) {
                let subtitleUrl = deliveryUrl;
                if (!deliveryUrl.startsWith("http")) {
                  try {
                    const baseUrl = new URL(url).origin;
                    subtitleUrl = baseUrl + (deliveryUrl.startsWith("/") ? "" : "/") + deliveryUrl;
                  } catch { /* use as-is */ }
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

function interceptXHRPlaybackInfo(): void {
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
          const subtitleStreams = mediaStreams.filter((s: any) => s.Type === "Subtitle");

          if (subtitleStreams.length > 0) {
            const subs: SubtitleTrack[] = [];

            for (const stream of subtitleStreams) {
              const deliveryUrl = stream.DeliveryUrl || stream.Path;

              if (deliveryUrl) {
                let subtitleUrl = deliveryUrl;
                if (!deliveryUrl.startsWith("http")) {
                  try {
                    const baseUrl = new URL(url).origin;
                    subtitleUrl = baseUrl + (deliveryUrl.startsWith("/") ? "" : "/") + deliveryUrl;
                  } catch { /* use as-is */ }
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

  log("XHR PlaybackInfo interceptor installed");
}

function monitorVideoTextTracks(): void {
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
              sendSubtitleContent(vttContent, track.language || "en", track.label || "Jellyfin Track");
            }
          }
        }
      }
    } catch (e) {
      log("Error checking textTracks:", e);
    }
  };

  const check = () => {
    checkTextTracks();
    setTimeout(check, 2000);
  };
  setTimeout(check, 500);

  log("TextTrack monitor installed");
}

function interceptHLS(): void {
  const checkHLS = () => {
    const hlsInstances =
      (window as any).hlsjs?.instances ||
      (window as any).Hls?.instances ||
      [];

    if (hlsInstances.length > 0) {
      for (const hls of hlsInstances) {
        if (hls.subtitleTracks && hls.subtitleTracks.length > 0) {
          for (const track of hls.subtitleTracks) {
            sendSubtitles(
              [{
                url: track.url,
                language: track.lang || "unknown",
                label: track.name || track.lang || "HLS Track",
              }],
              "hls.js",
            );
          }
        }
      }
    }
  };

  setInterval(checkHLS, 5000);
  setTimeout(checkHLS, 1000);

  log("HLS hook installed");
}

function hideNativeSubtitles(): void {
  const injectHideCSS = () => {
    const styleId = "ffprofanity-jellyfin-hide";
    if (document.getElementById(styleId)) return;

    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      .videoSubtitles,
      .videoSubtitlesInner,
      .videoSecondarySubtitlesInner,
      .subtitleContainer,
      div[class*="subtitleOverlay"],
      div[class*="SubtitleOverlay"] {
        visibility: hidden !important;
        opacity: 0 !important;
      }
      canvas.libass-js-canvas,
      div.libass-js-container {
        visibility: hidden !important;
        opacity: 0 !important;
      }
      #ffprofanity-overlay,
      #ffprofanity-subtitle-overlay {
        visibility: visible !important;
        opacity: 1 !important;
      }
    `;
    document.head.appendChild(style);
    log("Injected CSS to hide native Jellyfin subtitles");
  };

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
            track.mode = "hidden";
          }
        }
      }
    }
  };

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

  setTimeout(injectHideCSS, 1000);
  setTimeout(disableVideoTextTracks, 1000);
  setTimeout(disableVideoTextTracks, 3000);
  setTimeout(disableVideoTextTracks, 5000);
  setInterval(disableVideoTextTracks, 5000);

  log("Native subtitle hiding installed");
}

function watchForPlayer(): void {
  const observer = new MutationObserver((mutations) => {
    let foundVideo = false;

    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLElement) {
          if (node.tagName === "VIDEO" || node.querySelector("video")) {
            foundVideo = true;
            break;
          }
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
      setTimeout(monitorVideoTextTracks, 500);
      setTimeout(hideNativeSubtitles, 500);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  log("Player observer installed");
}

function init(): void {
  // Skip execution in iframes
  if (window.self !== window.top) return;

  log("Page script initializing...");
  interceptPlaybackInfo();
  interceptXHRPlaybackInfo();
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