/**
 * LookMovie Page Script - Injected via browser.scripting.executeScript with world: 'MAIN'
 *
 * This script handles:
 * 1. VideoJS player text track extraction
 * 2. XHR/Fetch interception for HLS manifests and subtitle URLs
 * 3. Auto-enabling captions and selecting English track
 * 4. Hiding native subtitles
 */

(function () {
  "use strict";

  const EXTRACTOR_ID = "lookmovie";
  const sentSubtitles = new Set<string>();
  let lastTracksHash = "";

  function log(...args: unknown[]): void {
    console.log("[LookMovie]", ...args);
  }

  interface SubtitleTrack {
    url: string;
    language: string;
    label: string;
  }

  function sendSubtitles(subs: SubtitleTrack[], source: string): void {
    if (!subs || subs.length === 0) return;

    // Deduplicate by content hash
    const key = JSON.stringify(subs);
    if (sentSubtitles.has(key)) return;
    sentSubtitles.add(key);

    log(`Sending ${subs.length} subtitles from ${source}`);
    window.postMessage(
      {
        type: "FFPROFANITY_SUBTITLES_DETECTED",
        source: source,
        subtitles: subs,
      },
      "*",
    );

    // Hide native subtitles after capturing (prevents double display)
    setTimeout(() => hideNativeSubtitles(), 500);
  }

  // ========================================
  // Strategy 1: VideoJS Player Detection
  // ========================================
  function extractFromVideoJS(): SubtitleTrack[] {
    const subs: SubtitleTrack[] = [];

    try {
      // Method 1a: Check for videojs global - MUST check typeof first
      if (typeof (window as any).videojs !== "undefined" && (window as any).videojs) {
        log("VideoJS found, checking for players...");

        // Safely get players
        const getPlayerIds = (window as any).videojs.getPlayerIds;
        if (typeof getPlayerIds === "function") {
          const players = getPlayerIds.call((window as any).videojs) || [];
          log("VideoJS player IDs:", players);

          for (const playerId of players) {
            const getPlayer = (window as any).videojs.getPlayer;
            if (typeof getPlayer !== "function") continue;

            const player = getPlayer.call((window as any).videojs, playerId);
            if (!player) {
              log("No player for ID:", playerId);
              continue;
            }
            log(
              "Got player for:",
              playerId,
              "has remoteTextTrackEls:",
              typeof (player as any).remoteTextTrackEls,
            );

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
                  log("Found VideoJS remote track:", trackEl.src);
                }
              }
            }

            // Also check textTracks directly
            if (typeof (player as any).textTracks === "function") {
              const textTracks = (player as any).textTracks() || [];
              for (let i = 0; i < textTracks.length; i++) {
                const track = textTracks[i];
                if (track.kind === "subtitles" || track.kind === "captions") {
                  // Try to find URL from various sources
                  const remoteEls =
                    typeof (player as any).remoteTextTrackEls === "function"
                      ? (player as any).remoteTextTrackEls()
                      : [];
                  const trackEl = remoteEls[i];
                  const url = trackEl?.src;
                  if (url && !subs.some((s) => s.url === url)) {
                    subs.push({
                      url: url,
                      language: track.language || "unknown",
                      label: track.label || "Unknown",
                    });
                    log("Found VideoJS text track:", url);
                  }
                }
              }
            }
          }
        }
      }

      // Method 1b: Check for 'player' global variable (some sites use this)
      if ((window as any).player && typeof (window as any).player === "object") {
        const player = (window as any).player;
        log("Found window.player global");
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
              log("Found player global track:", trackEl.src);
            }
          }
        }
      }

      // Method 1c: Check videojs.players object directly
      if ((window as any).videojs && (window as any).videojs.players) {
        const playerIds = Object.keys((window as any).videojs.players);
        log("videojs.players keys:", playerIds);

        for (const playerId of playerIds) {
          const playerData = (window as any).videojs.players[playerId];
          if (playerData && typeof playerData === "object") {
            log("Checking player data for:", playerId);
            // Check if playerData is the player instance itself
            if (typeof playerData.remoteTextTrackEls === "function") {
              const trackEls = playerData.remoteTextTrackEls() || [];
              log("Found", trackEls.length, "track elements in players object");
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
                    label: label,
                  });
                  log("Found players object track:", trackEl.src);
                }
              }
            }
          }
        }
      }
    } catch (e) {
      log("VideoJS extraction error:", (e as Error).message || e);
    }

    return subs;
  }

  // ========================================
  // Strategy 2: movie_storage global (legacy LookMovie)
  // ========================================
  function extractFromMovieStorage(): SubtitleTrack[] {
    const subs: SubtitleTrack[] = [];

    try {
      const tracks = (window as any).movie_storage?.text_tracks;
      if (!tracks || !Array.isArray(tracks) || tracks.length === 0) {
        // Try alternative property names
        const altTracks =
          (window as any).movie_storage?.subs ||
          (window as any).movie_storage?.subtitles ||
          (window as any).movie_storage?.cc ||
          (window as any).movie_storage?.captions;
        if (altTracks && Array.isArray(altTracks)) {
          return altTracks.map((t: any) => ({
            url: t.file || t.url || t.src,
            language: t.language || t.lang || "en",
            label: t.label || t.name || "English",
          })).filter((s: SubtitleTrack) => s.url);
        }
        return subs;
      }

      return tracks.map((t: any) => ({
        url: t.file || t.url || t.src,
        language: t.language || "en",
        label: t.label || "English",
      })).filter((s: SubtitleTrack) => s.url);
    } catch (e) {
      log("movie_storage extraction error:", (e as Error).message || e);
    }

    return subs;
  }

  // Poll for text_tracks changes
  let lastTextTracksJson = "";
  let textTracksCheckInterval: ReturnType<typeof setInterval> | null = null;

  function setupTextTracksWatcher(): void {
    if (textTracksCheckInterval) {
      clearInterval(textTracksCheckInterval);
    }

    textTracksCheckInterval = setInterval(() => {
      const tracks = (window as any).movie_storage?.text_tracks;
      if (tracks && Array.isArray(tracks)) {
        const tracksJson = JSON.stringify(tracks);
        if (
          tracksJson !== lastTextTracksJson &&
          tracksJson !== "[]" &&
          tracksJson !== ""
        ) {
          lastTextTracksJson = tracksJson;
          log("text_tracks changed, length:", tracks.length);
          checkAndSendTracks("lookmovie.text_tracks_poll");
        }
      }
    }, 500);
  }

  // ========================================
  // Strategy 3: Video Element Track Elements
  // ========================================
  function extractFromVideoElements(): SubtitleTrack[] {
    const subs: SubtitleTrack[] = [];
    const videos = Array.from(document.querySelectorAll("video"));

    for (const video of videos) {
      // Check <track> elements
      const trackElements = Array.from(
        video.querySelectorAll('track[kind="subtitles"], track[kind="captions"]'),
      ) as HTMLTrackElement[];
      for (const track of trackElements) {
        const url = track.src;
        if (url) {
          subs.push({
            url: url,
            language: track.srclang || "unknown",
            label: track.label || "Unknown",
          });
          log("Found video track element:", url);
        }
      }

      // Check textTracks API
      const textTracks = Array.from(video.textTracks);
      for (const textTrack of textTracks) {
        if (textTrack.kind === "subtitles" || textTrack.kind === "captions") {
          // Try to get URL from cues if available
          if (textTrack.cues && textTrack.cues.length > 0) {
            // Track is loaded but we can't get URL from cues
            // Still mark it as available
            log("Found loaded textTrack:", textTrack.label, textTrack.language);
          }
        }
      }
    }

    return subs;
  }

  // ========================================
  // Combine all strategies
  // ========================================
  function checkAndSendTracks(source: string): void {
    const allSubs: SubtitleTrack[] = [];

    // Strategy 1: VideoJS
    const videojsSubs = extractFromVideoJS();
    allSubs.push(...videojsSubs);

    // Strategy 2: movie_storage (legacy)
    const storageSubs = extractFromMovieStorage();
    allSubs.push(...storageSubs);

    // Strategy 3: Video elements
    const videoSubs = extractFromVideoElements();
    allSubs.push(...videoSubs);

    if (allSubs.length > 0) {
      sendSubtitles(allSubs, source);
    }
  }

  // ========================================
  // Watch for VideoJS player initialization
  // Use polling and events only - property interceptors break page initialization
  // ========================================
  function watchForVideoJS(): void {
    // Check if VideoJS is already loaded
    if (typeof (window as any).videojs !== "undefined") {
      log("VideoJS already available");
      setTimeout(() => checkAndSendTracks("lookmovie.videojs-ready"), 100);
      setTimeout(() => checkAndSendTracks("lookmovie.videojs-delayed"), 2000);
    }

    // Poll for videojs becoming available
    let videojsCheckCount = 0;
    const videojsCheckInterval = setInterval(() => {
      videojsCheckCount++;
      if (typeof (window as any).videojs !== "undefined") {
        clearInterval(videojsCheckInterval);
        log("VideoJS detected via polling");
        setTimeout(() => checkAndSendTracks("lookmovie.videojs-polled"), 100);
        setTimeout(() => checkAndSendTracks("lookmovie.videojs-polled-delayed"), 2000);
      } else if (videojsCheckCount > 200) {
        clearInterval(videojsCheckInterval);
      }
    }, 100);

    // Watch for player element creation
    const playerObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of Array.from(mutation.addedNodes)) {
          if (node instanceof HTMLVideoElement) {
            log("Video element added");
            setTimeout(() => checkAndSendTracks("lookmovie.video-added"), 200);
            setTimeout(() => checkAndSendTracks("lookmovie.video-added-delayed"), 1000);
          }
        }
      }
    });
    playerObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ========================================
  // Hijack XHR for HLS manifest and subtitle files
  // ========================================
  function interceptXHR(): void {
    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;

    (XMLHttpRequest.prototype as any).open = function (method: string, url: string) {
      (this as any)._ffprofanity_url = url;
      return originalXHROpen.apply(this, arguments as any);
    };

    (XMLHttpRequest.prototype as any).send = function () {
      const xhr = this;

      xhr.addEventListener("load", function () {
        const reqUrl = (xhr as any)._ffprofanity_url || "";

        // Check if responseText is accessible (only for '' or 'text' responseType)
        const canReadResponseText =
          xhr.responseType === "" || xhr.responseType === "text";

        // Strategy 2a: HLS Manifest subtitle extraction
        if (
          canReadResponseText &&
          (reqUrl.includes(".m3u8") ||
            reqUrl.includes("master") ||
            reqUrl.includes("playlist"))
        ) {
          try {
            const content = xhr.responseText;
            const subs = parseHLSManifest(content, reqUrl);
            if (subs.length > 0) {
              log("Found", subs.length, "subs in HLS manifest:", reqUrl.substring(0, 60));
              sendSubtitles(subs, "lookmovie.hls");
            }
          } catch (e) {
            /* Not valid HLS */
          }
        }

        // Strategy 3: Direct subtitle URLs (.vtt, .srt, .ass)
        if (canReadResponseText && /\.(vtt|srt|ass|ssa)/i.test(reqUrl)) {
          log("XHR subtitle URL:", reqUrl);
          const lang = extractLanguageFromUrl(reqUrl);
          sendSubtitles(
            [
              {
                url: reqUrl,
                language: lang,
                label: getLanguageName(lang),
              },
            ],
            "lookmovie.xhr-subtitle",
          );
        }
      });

      return originalXHRSend.apply(this, arguments as any);
    };
  }

  // ========================================
  // Hijack fetch API
  // ========================================
  function interceptFetch(): void {
    const originalFetch = window.fetch;

    window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      const url =
        typeof input === "string" ? input : (input as Request).url || "";

      return originalFetch.apply(this, arguments as any).then((response) => {
        // Direct subtitle URLs
        if (/\.(vtt|srt|ass|ssa)/i.test(url)) {
          log("Fetch subtitle URL:", url);
          const lang = extractLanguageFromUrl(url);
          sendSubtitles(
            [
              {
                url: url,
                language: lang,
                label: getLanguageName(lang),
              },
            ],
            "lookmovie.fetch-subtitle",
          );
        }

        // HLS manifests
        if (
          url.includes(".m3u8") ||
          url.includes("master") ||
          url.includes("playlist")
        ) {
          response.clone().text().then((content) => {
            const subs = parseHLSManifest(content, url);
            if (subs.length > 0) {
              sendSubtitles(subs, "lookmovie.fetch-hls");
            }
          }).catch(() => {});
        }

        return response;
      });
    };
  }

  // ========================================
  // Helper: Parse HLS manifest for subtitles
  // ========================================
  function parseHLSManifest(content: string, baseUrl: string): SubtitleTrack[] {
    const subs: SubtitleTrack[] = [];
    const lines = content.split("\n");
    let currentSub: { language?: string; label?: string; groupId?: string } | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // #EXT-X-MEDIA:TYPE=SUBTITLES
      if (line.startsWith("#EXT-X-MEDIA:TYPE=SUBTITLES")) {
        currentSub = { language: undefined, label: undefined, groupId: undefined };

        // Parse attributes
        const langMatch = line.match(/LANGUAGE="([^"]+)"/i);
        const nameMatch = line.match(/NAME="([^"]+)"/i);
        const groupIdMatch = line.match(/GROUP-ID="([^"]+)"/i);

        if (langMatch) currentSub.language = langMatch[1].toLowerCase();
        if (nameMatch) currentSub.label = nameMatch[1];
        if (groupIdMatch) currentSub.groupId = groupIdMatch[1];
      }

      // URI line after EXT-X-MEDIA
      if (currentSub && !line.startsWith("#") && line.length > 0) {
        const subUrl = new URL(line, baseUrl).href;
        subs.push({
          url: subUrl,
          language: currentSub.language || "unknown",
          label: currentSub.label || currentSub.language || "Unknown",
        });
        currentSub = null;
      }
    }

    return subs;
  }

  // ========================================
  // Helper: Extract language from URL
  // NOTE: Duplicated from lib/language.ts for injected script context
  // ========================================
  function extractLanguageFromUrl(url: string): string {
    const patterns = [
      /[?&]lang=([a-z]{2,3})/i,
      /\/([a-z]{2,3})_[a-f0-9]+\.vtt$/i,
      /\/([a-z]{2,3})\/[^/]+\.vtt$/i,
      /[_\-\.]([a-z]{2,3})\.(vtt|srt|ass)$/i,
    ];
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) return match[1].toLowerCase();
    }
    return "unknown";
  }

  // ========================================
  // Helper: Language code to name
  // NOTE: Duplicated from lib/language.ts for injected script context
  // ========================================
  function getLanguageName(code: string): string {
    const names: Record<string, string> = {
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
    return names[code.toLowerCase()] || code.toUpperCase();
  }

  // ========================================
  // Helper: Recursively find subtitles in objects
  // ========================================
  function findSubtitlesRecursive(obj: any): SubtitleTrack[] {
    const subs: SubtitleTrack[] = [];
    if (!obj || typeof obj !== "object") return subs;

    // Check for subtitle-like objects
    const urlKeys = ["file", "url", "src", "downloadLink", "path"];
    for (const key of urlKeys) {
      if (
        typeof obj[key] === "string" &&
        /\.(vtt|srt|ass|ssa)/i.test(obj[key])
      ) {
        subs.push({
          url: obj[key],
          language:
            obj.language || obj.lang || obj.code || extractLanguageFromUrl(obj[key]),
          label: obj.label || obj.name || "Detected",
        });
      }
    }

    // Recurse into arrays and objects
    if (Array.isArray(obj)) {
      for (const item of obj) {
        subs.push(...findSubtitlesRecursive(item));
      }
    } else {
      const priorityKeys = [
        "subtitles",
        "subs",
        "captions",
        "cc",
        "text_tracks",
        "tracks",
      ];
      for (const key of priorityKeys) {
        if (obj[key]) {
          subs.push(...findSubtitlesRecursive(obj[key]));
        }
      }
    }

    return subs;
  }

  // ========================================
  // Auto-enable captions and select English
  // ========================================
  function tryEnableCaptions(): void {
    log("tryEnableCaptions: attempting to enable captions...");

    // LookMovie-specific: Check .vjs-subtitles-language-toggle for CC menu
    // Structure:
    // <button class="vjs-subtitles-language-toggle">CC</button>
    // <ul class="vjs-subtitles-language-items">...</ul>

    const ccSelectors = [
      ".vjs-subtitles-language-toggle",
      ".vjs-subs-caps-button",
      ".vjs-captions-button",
      ".vjs-subtitles-button",
      'button[aria-label*="caption"]',
      'button[aria-label*="subtitle"]',
      'button[aria-label*="subtitles"]',
      'button[class*="subtitle"]',
    ];

    for (const selector of ccSelectors) {
      const ccButton = document.querySelector(selector) as HTMLButtonElement;
      if (ccButton) {
        // Check if already enabled
        const isPressed =
          ccButton.getAttribute("aria-pressed") === "true" ||
          ccButton.classList.contains("vjs-enabled") ||
          ccButton.classList.contains("vjs-playing");

        if (!isPressed) {
          // Check if we've already tried
          if ((window as any).__ffprofanity_lm_cc_clicked) {
            log("CC button already clicked");
            return;
          }
          (window as any).__ffprofanity_lm_cc_clicked = true;

          log("Clicking CC button to enable captions");
          ccButton.click();

          // Re-check after click
          setTimeout(() => checkAndSendTracks("lookmovie.cc-auto-click"), 500);
          setTimeout(() => checkAndSendTracks("lookmovie.cc-auto-click-delayed"), 2000);

          // After clicking CC, try to select "English 1" or first English option
          setTimeout(() => selectEnglishSubtitle(), 300);
          return;
        } else {
          log("Captions already enabled");
          // Still try to select English subtitle if not already selected
          setTimeout(() => selectEnglishSubtitle(), 300);
          return;
        }
      }
    }
    log("No CC button found");
  }

  // ========================================
  // Select English subtitle from language menu
  // LookMovie has: English 1, English 2, English 3 - prefer "English 1"
  // ========================================
  function selectEnglishSubtitle(): void {
    // Check if already showing English
    const showingItem = document.querySelector(
      ".vjs-subtitles-language-item.showing",
    );
    if (
      showingItem &&
      showingItem.textContent &&
      showingItem.textContent.includes("English")
    ) {
      log(
        "English subtitle already selected:",
        showingItem.textContent?.trim(),
      );
      // Hide native subtitles after capturing
      setTimeout(() => hideNativeSubtitles(), 500);
      return;
    }

    // Find "English 1" or first English option
    const items = Array.from(
      document.querySelectorAll(".vjs-subtitles-language-item"),
    );
    let targetItem: Element | null = null;

    for (const item of items) {
      const text = item.textContent?.trim() || "";
      if (text === "English 1") {
        targetItem = item;
        break; // Exact match takes priority
      } else if (!targetItem && text.startsWith("English")) {
        targetItem = item;
      }
    }

    if (targetItem && !targetItem.classList.contains("showing")) {
      log("Selecting subtitle:", targetItem.textContent?.trim());
      (targetItem as HTMLElement).click();

      // Trigger track detection after selection, then hide native subtitles
      setTimeout(() => checkAndSendTracks("lookmovie.subtitle-selected"), 500);
      setTimeout(
        () => checkAndSendTracks("lookmovie.subtitle-selected-delayed"),
        2000,
      );
      setTimeout(() => hideNativeSubtitles(), 1000);
    } else if (!targetItem) {
      log("No English subtitle option found in menu");
    }
  }

  // ========================================
  // Turn off native subtitles by clicking "Off" in menu
  // LookMovie uses a custom subtitle overlay, not VideoJS native tracks
  // We need to: 1) Open CC menu, 2) Find "Off" button, 3) Click it
  // ========================================
  function hideNativeSubtitles(): boolean {
    log("hideNativeSubtitles: attempting to disable native subtitles");

    // LookMovie has a custom subtitle menu structure:
    // <button class="vjs-subtitles-language-toggle">...</button>
    // <ul class="vjs-subtitles-language-items">
    //   <li class="vjs-subtitles-language-item"><span>Off</span></li>
    //   <li class="vjs-subtitles-language-item showing"><span>English 1</span></li>
    // </ul>

    // First, find the "Off" button directly (might already exist)
    const offButton = findOffButton();
    if (offButton) {
      log('hideNativeSubtitles: Found "Off" button directly, clicking');
      offButton.click();
      return true;
    }

    // Menu might be closed, need to open it first
    const ccButton = findCCButton();
    if (ccButton) {
      log('hideNativeSubtitles: Opening CC menu to access "Off" button');
      ccButton.click();

      // Wait for menu to render, then find and click Off
      setTimeout(() => {
        const offBtn = findOffButton();
        if (offBtn) {
          log('hideNativeSubtitles: Found "Off" button after opening menu, clicking');
          offBtn.click();
        } else {
          log('hideNativeSubtitles: Still no "Off" button found after opening menu');
        }
      }, 200);
      return true;
    }

    log("hideNativeSubtitles: No CC button or Off button found");
    return false;
  }

  // ========================================
  // Find the "Off" button in the subtitle menu
  // ========================================
  function findOffButton(): HTMLElement | null {
    // Look for "Off" text in menu items
    const items = Array.from(
      document.querySelectorAll(".vjs-subtitles-language-item, .vjs-menu-item"),
    );
    for (const item of items) {
      const text = item.textContent?.trim();
      if (text === "Off") {
        return item as HTMLElement;
      }
    }

    // Also check for buttons with "Off" text
    const buttons = Array.from(document.querySelectorAll("button"));
    for (const btn of buttons) {
      const btnText = btn.textContent?.trim();
      if (btnText === "Off") {
        return btn;
      }
    }

    return null;
  }

  // ========================================
  // Find the CC/subtitles toggle button
  // ========================================
  function findCCButton(): HTMLElement | null {
    const selectors = [
      ".vjs-subtitles-language-toggle",
      ".vjs-subs-caps-button",
      ".vjs-captions-button",
      ".vjs-subtitles-button",
      'button[aria-label*="caption"]',
      'button[aria-label*="subtitle"]',
      'button[class*="subtitle"]',
    ];

    for (const selector of selectors) {
      const btn = document.querySelector(selector) as HTMLElement;
      if (btn) {
        return btn;
      }
    }

    return null;
  }

  // ========================================
  // Listen for user subtitle selection changes
  // When user clicks a different subtitle, we should use that one
  // ========================================
  function setupSubtitleChangeListener(): void {
    document.addEventListener(
      "click",
      (e) => {
        const target = e.target as HTMLElement;

        // Check if clicking on a subtitle language item
        const subtitleItem = target.closest(".vjs-subtitles-language-item");
        if (subtitleItem && !subtitleItem.classList.contains("showing")) {
          const selectedText = subtitleItem.textContent?.trim();
          log("User selected subtitle:", selectedText);

          // Clear the "already clicked" flag so we can process the new selection
          (window as any).__ffprofanity_lm_cc_clicked = false;

          // Trigger subtitle detection for the new track
          // Wait a bit for the player to switch tracks
          setTimeout(() => {
            checkAndSendTracks("lookmovie.user-subtitle-change");
            // Then turn off native subtitles again
            setTimeout(() => hideNativeSubtitles(), 300);
          }, 500);
        }
      },
      true,
    );
  }

  // ========================================
  // Watch for video player changes (ads -> main content)
  // LookMovie plays 10-second ads before the main video
  // ========================================
  function watchForPlayerTransition(): void {
    log("Watching for player transitions (ad -> content)");

    // Watch for video element source changes
    let lastSrc = "";
    const checkVideoSrc = () => {
      const video = document.querySelector("video");
      if (video && video.src && video.src !== lastSrc) {
        lastSrc = video.src;
        log("Video source changed:", video.src.substring(0, 60));
        // Re-check for subtitles when video source changes
        setTimeout(() => checkAndSendTracks("lookmovie.video-src-change"), 500);
        setTimeout(
          () => checkAndSendTracks("lookmovie.video-src-delayed"),
          2000,
        );
        setTimeout(() => checkAndSendTracks("lookmovie.video-src-slow"), 5000);
      }
    };

    // Poll for video src changes
    setInterval(checkVideoSrc, 1000);

    // Also watch for video element events
    document.addEventListener(
      "playing",
      (e) => {
        if (e.target instanceof HTMLVideoElement) {
          log("Video playing event");
          checkVideoSrc();
          setTimeout(() => checkAndSendTracks("lookmovie.video-playing"), 500);
        }
      },
      true,
    );

    // Watch for player ready state
    document.addEventListener(
      "loadedmetadata",
      (e) => {
        if (e.target instanceof HTMLVideoElement) {
          log("Video loadedmetadata event");
          setTimeout(() => checkAndSendTracks("lookmovie.video-metadata"), 200);
        }
      },
      true,
    );
  }

  // ========================================
  // Setup CC button click detection
  // ========================================
  function setupCCButtonDetection(): void {
    // Click detection for .vjs-subtitles-language-toggle items
    // When user opens the CC menu, we can intercept the tracks
    const ccButtonSelectors = [
      ".vjs-subtitles-language-toggle",
      ".vjs-subs-caps-button",
      ".vjs-captions-button",
      ".vjs-subtitles-button",
    ];

    for (const selector of ccButtonSelectors) {
      const btn = document.querySelector(selector);
      if (btn) {
        btn.addEventListener("click", () => {
          log("CC button clicked");
          setTimeout(() => checkAndSendTracks("lookmovie.cc-clicked"), 300);
          setTimeout(() => checkAndSendTracks("lookmovie.cc-clicked-delayed"), 1000);
        });
        log("Attached click listener to CC button:", selector);
      }
    }

    // Also listen for menu opening
    document.addEventListener(
      "click",
      (e) => {
        const target = e.target as HTMLElement;
        for (const sel of ccButtonSelectors) {
          if (
            target.matches &&
            (target.matches(sel) || target.closest?.(sel))
          ) {
            log("CC container clicked");
            setTimeout(
              () => checkAndSendTracks("lookmovie.cc-container-click"),
              300,
            );
            break;
          }
        }
      },
      true,
    );
  }

  // ========================================
  // Initialize
  // ========================================
  function init(): void {
    log("Extractor initializing");

    // Setup interceptors
    interceptXHR();
    interceptFetch();

    // Setup watchers
    watchForVideoJS();
    setupCCButtonDetection();
    setupSubtitleChangeListener();
    watchForPlayerTransition();

    // Listen for content script message to hide native subtitles
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      if (event.data?.type === "FFPROFANITY_HIDE_NATIVE_SUBTITLES") {
        log("Received HIDE_NATIVE_SUBTITLES message");
        // Try multiple times as the menu may need to be opened first
        hideNativeSubtitles();
        setTimeout(() => hideNativeSubtitles(), 500);
        setTimeout(() => hideNativeSubtitles(), 1500);
        setTimeout(() => hideNativeSubtitles(), 3000);
      }
    });

    // Setup movie_storage watcher (polling + property intercept)
    if ((window as any).movie_storage) {
      setupTextTracksWatcher();
      // Initial check
      const tracks = (window as any).movie_storage.text_tracks;
      if (tracks && tracks.length > 0) {
        checkAndSendTracks("lookmovie.storage-initial");
      }
    } else {
      // Poll for movie_storage to appear
      let attempts = 0;
      const checkInterval = setInterval(() => {
        attempts++;
        if ((window as any).movie_storage) {
          clearInterval(checkInterval);
          setupTextTracksWatcher();
          const tracks = (window as any).movie_storage.text_tracks;
          if (tracks && tracks.length > 0) {
            checkAndSendTracks("lookmovie.storage-found");
          }
        } else if (attempts > 100) {
          clearInterval(checkInterval);
        }
      }, 200);
    }

    // Delayed checks for dynamic content (including after ad playback)
    setTimeout(() => checkAndSendTracks("lookmovie.init-500"), 500);
    setTimeout(() => checkAndSendTracks("lookmovie.init-2000"), 2000);
    setTimeout(() => checkAndSendTracks("lookmovie.init-5000"), 5000);
    // Extra delayed check for ad-supported sites like LookMovie
    setTimeout(() => checkAndSendTracks("lookmovie.init-10000"), 10000);
    setTimeout(() => checkAndSendTracks("lookmovie.init-15000"), 15000);
    setTimeout(() => checkAndSendTracks("lookmovie.init-20000"), 20000);

    // Try to auto-enable captions (VideoJS lazy-loads subtitles)
    setTimeout(tryEnableCaptions, 2000);
    setTimeout(tryEnableCaptions, 5000);
    setTimeout(tryEnableCaptions, 10000);

    log("Extractor ready");
  }

  // Run
  init();
})();