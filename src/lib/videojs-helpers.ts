/**
 * Shared Video.js detection helpers for page scripts
 *
 * Bundled into each page script IIFE by esbuild — no runtime module loading.
 */

import { SubtitleTrack } from "./network-interception";
import { extractLanguageFromUrl, getLanguageName } from "./page-script-helpers";

/**
 * Extract subtitle tracks from Video.js player instances
 * Checks window.videojs, window.player, and videojs.players
 */
export function extractFromVideoJS(): SubtitleTrack[] {
  const subs: SubtitleTrack[] = [];

  try {
    // Method 1a: Check for videojs global
    if (typeof (window as any).videojs !== "undefined" && (window as any).videojs) {
      const getPlayerIds = (window as any).videojs.getPlayerIds;
      if (typeof getPlayerIds === "function") {
        const players = getPlayerIds.call((window as any).videojs) || [];

        for (const playerId of players) {
          const getPlayer = (window as any).videojs.getPlayer;
          if (typeof getPlayer !== "function") continue;

          const player = getPlayer.call((window as any).videojs, playerId);
          if (!player) continue;

          // Get remote text track elements (these have .src URLs)
          if (typeof (player as any).remoteTextTrackEls === "function") {
            const trackEls = (player as any).remoteTextTrackEls() || [];
            for (let i = 0; i < trackEls.length; i++) {
              const trackEl = trackEls[i];
              if (trackEl && trackEl.src) {
                const track =
                  typeof (player as any).textTracks === "function"
                    ? (player as any).textTracks()[i]
                    : null;
                subs.push({
                  url: trackEl.src,
                  language:
                    track?.language ||
                    trackEl.getAttribute?.("srclang") ||
                    "unknown",
                  label:
                    track?.label || trackEl.getAttribute?.("label") || "Unknown",
                });
              }
            }
          }

          // Also check textTracks directly
          if (typeof (player as any).textTracks === "function") {
            const textTracks = (player as any).textTracks() || [];
            for (let i = 0; i < textTracks.length; i++) {
              const track = textTracks[i];
              if (track.kind === "subtitles" || track.kind === "captions") {
                const remoteEls =
                  typeof (player as any).remoteTextTrackEls === "function"
                    ? (player as any).remoteTextTrackEls()
                    : [];
                const trackEl = remoteEls[i];
                const url = trackEl?.src;
                if (url && !subs.some((s) => s.url === url)) {
                  subs.push({
                    url,
                    language: track.language || "unknown",
                    label: track.label || "Unknown",
                  });
                }
              }
            }
          }
        }
      }
    }

    // Method 1b: Check for 'player' global variable
    if ((window as any).player && typeof (window as any).player === "object") {
      const player = (window as any).player;
      if (typeof player.remoteTextTrackEls === "function") {
        const trackEls = player.remoteTextTrackEls() || [];
        for (let i = 0; i < trackEls.length; i++) {
          const trackEl = trackEls[i];
          if (trackEl && trackEl.src) {
            subs.push({
              url: trackEl.src,
              language: trackEl.getAttribute?.("srclang") || "unknown",
              label: trackEl.getAttribute?.("label") || "Unknown",
            });
          }
        }
      }
    }

    // Method 1c: Check videojs.players object directly
    if ((window as any).videojs && (window as any).videojs.players) {
      const playerIds = Object.keys((window as any).videojs.players);

      for (const playerId of playerIds) {
        const playerData = (window as any).videojs.players[playerId];
        if (playerData && typeof playerData === "object") {
          if (typeof playerData.remoteTextTrackEls === "function") {
            const trackEls = playerData.remoteTextTrackEls() || [];
            for (let i = 0; i < trackEls.length; i++) {
              const trackEl = trackEls[i];
              if (trackEl && trackEl.src) {
                const urlLang = extractLanguageFromUrl(trackEl.src);
                const lang =
                  trackEl.getAttribute?.("srclang") || urlLang || "unknown";
                const label =
                  trackEl.getAttribute?.("label") ||
                  getLanguageName(lang) ||
                  "Unknown";
                subs.push({
                  url: trackEl.src,
                  language: lang,
                  label,
                });
              }
            }
          }
        }
      }
    }
  } catch (e) {
    // Silently ignore errors
  }

  return subs;
}

/**
 * Extract subtitle tracks from <track> elements inside <video> elements
 */
export function extractFromVideoTrackElements(): SubtitleTrack[] {
  const subs: SubtitleTrack[] = [];
  const videos = Array.from(document.querySelectorAll("video"));

  for (const video of videos) {
    const trackElements = Array.from(
      video.querySelectorAll('track[kind="subtitles"], track[kind="captions"]'),
    ) as HTMLTrackElement[];
    for (const track of trackElements) {
      const url = track.src;
      if (url) {
        subs.push({
          url,
          language: track.srclang || "unknown",
          label: track.label || "Unknown",
        });
      }
    }
  }

  return subs;
}

/**
 * Poll for Video.js player instances and call a callback when found
 */
export function watchForVideoJS(
  onFound: (subs: SubtitleTrack[]) => void,
  opts: { pollInterval?: number; maxPolls?: number; source?: string } = {},
): void {
  const { pollInterval = 200, maxPolls = 50, source = "videojs-poll" } = opts;
  let count = 0;

  const poll = setInterval(() => {
    count++;
    if (typeof (window as any).videojs !== "undefined") {
      clearInterval(poll);
      const subs = extractFromVideoJS();
      if (subs.length > 0) {
        onFound(subs);
      }
    } else if (count > maxPolls) {
      clearInterval(poll);
    }
  }, pollInterval);
}

/**
 * Disable Video.js subtitle display (text track mode = 'disabled')
 */
export function disableVideoJSTextTracks(): void {
  try {
    // Check window.videoJS
    const videoJS = (window as any).videoJS;
    if (videoJS && typeof videoJS.textTracks === "function") {
      const tracks = videoJS.textTracks();
      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i];
        if (
          (track.kind === "subtitles" || track.kind === "captions") &&
          track.mode !== "disabled"
        ) {
          track.mode = "disabled";
        }
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
                track.mode = "disabled";
              }
            }
          }
        } catch {
          // Ignore per-player errors
        }
      }
    }
  } catch {
    // Ignore errors
  }
}

/**
 * Click CC/subtitle buttons to trigger subtitle loading
 */
export function clickCCButton(selectors: string[]): HTMLButtonElement | null {
  for (const selector of selectors) {
    const ccButton = document.querySelector(selector) as HTMLButtonElement | null;
    if (!ccButton) continue;

    const isPressed =
      ccButton.getAttribute("aria-pressed") === "true" ||
      ccButton.classList.contains("vjs-enabled") ||
      ccButton.classList.contains("vjs-playing");

    if (!isPressed) {
      ccButton.click();
      return ccButton;
    }
  }
  return null;
}