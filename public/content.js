"use strict";
(() => {
  // src/lib/storage.ts
  var CURRENT_SCHEMA_VERSION = 1;
  var DEFAULT_SETTINGS = {
    offsetMs: 0,
    sensitivity: "medium",
    fuzzyThreshold: 0.25,
    wordlist: [],
    enabledSites: [],
    optInTFJS: false,
    optInAutoFetch: false
  };
  var StorageManager = class {
    /**
     * Get all cues from storage
     */
    async getCues() {
      const result = await browser.storage.local.get("cues_v1");
      return result.cues_v1 || [];
    }
    /**
     * Save cues to storage
     */
    async setCues(cues2) {
      await browser.storage.local.set({ cues_v1: cues2 });
    }
    /**
     * Clear all cues
     */
    async clearCues() {
      await browser.storage.local.remove("cues_v1");
    }
    /**
     * Get settings from storage
     */
    async getSettings() {
      const result = await browser.storage.local.get("settings");
      return { ...DEFAULT_SETTINGS, ...result.settings || {} };
    }
    /**
     * Save settings to storage
     */
    async setSettings(settings2) {
      const current = await this.getSettings();
      await browser.storage.local.set({ settings: { ...current, ...settings2 } });
    }
    /**
     * Get setting with key
     */
    async getSetting(key) {
      const settings2 = await this.getSettings();
      return settings2[key];
    }
    /**
     * Set single setting
     */
    async setSetting(key, value) {
      const settings2 = await this.getSettings();
      settings2[key] = value;
      await browser.storage.local.set({ settings: settings2 });
    }
    /**
     * Get site-specific preset
     */
    async getPreset(site) {
      const result = await browser.storage.local.get("presets");
      const presets = result.presets || {};
      return presets[site] || null;
    }
    /**
     * Save site-specific preset
     */
    async setPreset(site, preset) {
      const result = await browser.storage.local.get("presets");
      const presets = result.presets || {};
      presets[site] = preset;
      await browser.storage.local.set({ presets });
    }
    /**
     * Clear all storage data
     */
    async clearAll() {
      await browser.storage.local.clear();
    }
    /**
     * Export all data for backup
     */
    async exportData() {
      const [cues2, settings2, presetsResult] = await Promise.all([
        this.getCues(),
        this.getSettings(),
        browser.storage.local.get("presets")
      ]);
      return {
        version: CURRENT_SCHEMA_VERSION,
        cues: cues2,
        settings: settings2,
        presets: presetsResult.presets || {}
      };
    }
    /**
     * Import data from backup
     */
    async importData(data) {
      if (data.version !== CURRENT_SCHEMA_VERSION) {
        console.warn("Storage schema version mismatch, data may need migration");
      }
      await Promise.all([
        this.setCues(data.cues || []),
        this.setSettings(data.settings || {}),
        browser.storage.local.set({ presets: data.presets || {} })
      ]);
    }
  };
  var storage = new StorageManager();

  // src/lib/parser.ts
  function parseSRTTimestamp(timestamp) {
    const match = timestamp.match(/(\d{2}):(\d{2}):(\d{2})[,\.](\d{3})/);
    if (!match) return 0;
    const hours = parseInt(match[1], 10) * 36e5;
    const minutes = parseInt(match[2], 10) * 6e4;
    const seconds = parseInt(match[3], 10) * 1e3;
    const millis = parseInt(match[4], 10);
    return hours + minutes + seconds + millis;
  }
  function parseVTTTimestamp(timestamp) {
    let match = timestamp.match(/(\d{2}):(\d{2}):(\d{2})\.(\d{3})/);
    if (match) {
      const hours = parseInt(match[1], 10) * 36e5;
      const minutes = parseInt(match[2], 10) * 6e4;
      const seconds = parseInt(match[3], 10) * 1e3;
      const millis = parseInt(match[4], 10);
      return hours + minutes + seconds + millis;
    }
    match = timestamp.match(/(\d{2}):(\d{2})\.(\d{3})/);
    if (match) {
      const minutes = parseInt(match[1], 10) * 6e4;
      const seconds = parseInt(match[2], 10) * 1e3;
      const millis = parseInt(match[3], 10);
      return minutes + seconds + millis;
    }
    return 0;
  }
  function parseASSTimestamp(timestamp) {
    const match = timestamp.match(/(\d+):(\d{2}):(\d{2})\.(\d{2})/);
    if (!match) return 0;
    const hours = parseInt(match[1], 10) * 36e5;
    const minutes = parseInt(match[2], 10) * 6e4;
    const seconds = parseInt(match[3], 10) * 1e3;
    const centis = parseInt(match[4], 10) * 10;
    return hours + minutes + seconds + centis;
  }
  function detectFormat(content) {
    const trimmed = content.trim();
    if (trimmed.startsWith("WEBVTT")) return "vtt";
    if (trimmed.match(/^\[Script Info\]/i) || trimmed.match(/^[Ss][Ss][Aa]/)) return "ass";
    if (trimmed.match(/^\d+\s*\r?\n\d{2}:\d{2}:\d{2}[,\.]\d{3}/)) return "srt";
    return null;
  }
  function createCue(id, startMs, endMs, text) {
    return {
      id,
      startMs,
      endMs,
      text,
      censoredText: text,
      hasProfanity: false,
      profanityScore: 0,
      profanityMatches: []
    };
  }
  function parseSRT(content) {
    const cues2 = [];
    const blocks = content.trim().split(/\r?\n\r?\n/);
    let id = 0;
    for (const block of blocks) {
      const lines = block.split(/\r?\n/);
      if (lines.length < 2) continue;
      let idx = 0;
      let cueId = id;
      if (lines[0].match(/^\d+$/)) {
        cueId = parseInt(lines[0], 10);
        idx = 1;
      }
      const timestampLine = lines[idx];
      if (!timestampLine) continue;
      const timestampMatch = timestampLine.match(
        /(\d{2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,\.]\d{3})/
      );
      if (!timestampMatch) continue;
      const startMs = parseSRTTimestamp(timestampMatch[1]);
      const endMs = parseSRTTimestamp(timestampMatch[2]);
      const text = lines.slice(idx + 1).join("\n").trim();
      if (!text) continue;
      cues2.push(createCue(cueId, startMs, endMs, text));
      id++;
    }
    return cues2;
  }
  function parseVTT(content) {
    const cues2 = [];
    const lines = content.split(/\r?\n/);
    let i = 0;
    let id = 0;
    while (i < lines.length && !lines[i].match(/\d{2}:\d{2}/)) {
      i++;
    }
    while (i < lines.length) {
      const timestampMatch = lines[i].match(
        /(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})/
      );
      if (timestampMatch) {
        const startMs = parseVTTTimestamp(timestampMatch[1]);
        const endMs = parseVTTTimestamp(timestampMatch[2]);
        const textLines = [];
        i++;
        while (i < lines.length && lines[i].trim() && !lines[i].match(/\d{2}:\d{2}/)) {
          textLines.push(lines[i].trim());
          i++;
        }
        const text = textLines.join("\n").trim();
        if (text && startMs < endMs) {
          cues2.push(createCue(id, startMs, endMs, text));
          id++;
        }
      } else {
        i++;
      }
    }
    return cues2;
  }
  function parseASS(content) {
    const cues2 = [];
    const lines = content.split(/\r?\n/);
    let inEvents = false;
    let formatFields = [];
    let id = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.match(/^\[Events\]/i)) {
        inEvents = true;
        continue;
      }
      if (trimmed.match(/^\[/) && inEvents) {
        inEvents = false;
        continue;
      }
      if (inEvents) {
        if (trimmed.match(/^Format:/i)) {
          formatFields = trimmed.replace(/^Format:\s*/i, "").split(",").map((f) => f.trim().toLowerCase());
          continue;
        }
        if (trimmed.match(/^Dialogue:/i)) {
          const dialogueContent = trimmed.replace(/^Dialogue:\s*/i, "");
          const parts = dialogueContent.split(",");
          if (parts.length < 10) continue;
          const startIndex = formatFields.indexOf("start");
          const endIndex = formatFields.indexOf("end");
          const textIndex = formatFields.indexOf("text");
          if (startIndex === -1 || endIndex === -1 || textIndex === -1) {
            const startMs = parseASSTimestamp(parts[1] || "0:00:00.00");
            const endMs = parseASSTimestamp(parts[2] || "0:00:00.00");
            const text = parts.slice(9).join(",").replace(/\\N/gi, "\n").replace(/\\n/gi, "\n");
            if (text.trim()) {
              cues2.push(createCue(id, startMs, endMs, text));
              id++;
            }
          } else {
            const startMs = parseASSTimestamp(parts[startIndex] || "0:00:00.00");
            const endMs = parseASSTimestamp(parts[endIndex] || "0:00:00.00");
            const text = parts.slice(textIndex).join(",").replace(/\\N/gi, "\n").replace(/\\n/gi, "\n");
            if (text.trim()) {
              cues2.push(createCue(id, startMs, endMs, text));
              id++;
            }
          }
        }
      }
    }
    return cues2;
  }
  function sanitizeText(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }
  function parseSubtitle(content) {
    const format = detectFormat(content);
    const errors = [];
    if (!format) {
      errors.push("Unable to detect subtitle format. Supported formats: SRT, ASS/SSA, WEBVTT");
      return { cues: [], format: "srt", errors };
    }
    let cues2 = [];
    try {
      switch (format) {
        case "srt":
          cues2 = parseSRT(content);
          break;
        case "ass":
          cues2 = parseASS(content);
          break;
        case "vtt":
          cues2 = parseVTT(content);
          break;
      }
      cues2.sort((a, b) => a.startMs - b.startMs);
      cues2.forEach((cue, index) => {
        cue.id = index;
      });
    } catch (error) {
      errors.push(`Parse error: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
    return { cues: cues2, format, errors };
  }

  // src/lib/detector.ts
  var SUBSTITUTIONS = {
    "@": "a",
    "4": "a",
    "3": "e",
    "1": "i",
    "!": "i",
    "0": "o",
    "5": "s",
    "$": "s",
    "7": "t",
    "+": "t"
  };
  var DEFAULT_WORDLIST = [
    "fuck",
    "shit",
    "ass",
    "bitch",
    "dick",
    "cock",
    "pussy",
    "cunt",
    "bastard",
    "whore",
    "nigger",
    "nigga",
    "faggot",
    "slut",
    "hoe",
    "dildo",
    "vibrator",
    "orgasm",
    "penis",
    "vagina",
    "nipple",
    "motherfucker",
    "bullshit",
    "horseshit"
  ];
  var OBFUSCATION_PATTERNS = [
    // f*ck, f**k style
    { pattern: /f[\W_]*u[\W_]*c[\W_]*k/gi, word: "fuck" },
    // s*it, s**t  
    { pattern: /s[\W_]*h[\W_]*i[\W_]*t/gi, word: "shit" },
    // b*tch
    { pattern: /b[\W_]*i[\W_]*t[\W_]*c[\W_]*h/gi, word: "bitch" },
    // c*nt
    { pattern: /c[\W_]*u[\W_]*n[\W_]*t/gi, word: "cunt" },
    // d*ck
    { pattern: /d[\W_]*i[\W_]*c[\W_]*k/gi, word: "dick" },
    // *ss
    { pattern: /a[\W_]*s[\W_]*s/gi, word: "ass" },
    // p*ssy
    { pattern: /p[\W_]*u[\W_]*s[\W_]*s[\W_]*y/gi, word: "pussy" },
    // b*tard
    { pattern: /b[\W_]*a[\W_]*s[\W_]*t[\W_]*a[\W_]*r[\W_]*d/gi, word: "bastard" }
  ];
  var SENSITIVITY_THRESHOLDS = {
    low: 80,
    medium: 50,
    high: 20
  };
  function normalizeText(text) {
    let normalized = text.toLowerCase();
    for (const [sub, replacement] of Object.entries(SUBSTITUTIONS)) {
      normalized = normalized.replace(new RegExp(`[${sub}]`, "g"), replacement);
    }
    return normalized;
  }
  function tokenize(text) {
    return text.toLowerCase().split(/[\s\p{P}]+/gu).filter((w) => w.length > 0);
  }
  function levenshteinDistance(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }
    return matrix[b.length][a.length];
  }
  function isFuzzyMatch(word, profanityWord, threshold) {
    const distance = levenshteinDistance(word, profanityWord);
    const maxLength = Math.max(word.length, profanityWord.length);
    const ratio = distance / maxLength;
    return ratio <= threshold;
  }
  var ProfanityDetector = class {
    constructor(config = {
      wordlist: DEFAULT_WORDLIST,
      fuzzyThreshold: 0.25,
      sensitivity: "medium"
    }) {
      this.wordlist = new Set(config.wordlist.map((w) => normalizeText(w)));
      this.fuzzyThreshold = config.fuzzyThreshold;
      this.sensitivityThreshold = SENSITIVITY_THRESHOLDS[config.sensitivity];
      this.customPatterns = [...OBFUSCATION_PATTERNS];
    }
    /**
     * Add words to the wordlist
     */
    addWords(words) {
      for (const word of words) {
        this.wordlist.add(normalizeText(word));
      }
    }
    /**
     * Remove words from the wordlist
     */
    removeWords(words) {
      for (const word of words) {
        this.wordlist.delete(normalizeText(word));
      }
    }
    /**
     * Get the current wordlist
     */
    getWordlist() {
      return Array.from(this.wordlist);
    }
    /**
     * Update sensitivity setting
     */
    setSensitivity(sensitivity) {
      this.sensitivityThreshold = SENSITIVITY_THRESHOLDS[sensitivity];
    }
    /**
     * Check if a single word matches the wordlist (exact or fuzzy)
     */
    checkWord(word) {
      const normalized = normalizeText(word);
      if (this.wordlist.has(normalized)) {
        return { match: true, type: "exact", confidence: 100 };
      }
      for (const profanityWord of this.wordlist) {
        if (isFuzzyMatch(normalized, profanityWord, this.fuzzyThreshold)) {
          const distance = levenshteinDistance(normalized, profanityWord);
          const confidence = 100 - distance / Math.max(normalized.length, profanityWord.length) * 100;
          return { match: true, type: "fuzzy", confidence };
        }
      }
      return { match: false, type: "exact", confidence: 0 };
    }
    /**
     * Detect profanity in text and return matches
     */
    detect(text) {
      const matches = [];
      let totalScore = 0;
      for (const { pattern, word } of this.customPatterns) {
        let match;
        const regex = new RegExp(pattern.source, "gi");
        while ((match = regex.exec(text)) !== null) {
          matches.push({
            word: match[0],
            startIndex: match.index,
            endIndex: match.index + match[0].length,
            type: "regex",
            confidence: 95
          });
          totalScore += 95;
        }
      }
      const tokens = tokenize(text);
      let searchIndex = 0;
      for (const token of tokens) {
        const tokenIndex = text.toLowerCase().indexOf(token, searchIndex);
        if (tokenIndex === -1) continue;
        const { match, type, confidence } = this.checkWord(token);
        if (match) {
          const alreadyMatched = matches.some(
            (m) => tokenIndex >= m.startIndex && tokenIndex < m.endIndex || m.startIndex >= tokenIndex && m.startIndex < tokenIndex + token.length
          );
          if (!alreadyMatched) {
            matches.push({
              word: token,
              startIndex: tokenIndex,
              endIndex: tokenIndex + token.length,
              type,
              confidence
            });
            totalScore += confidence;
          }
        }
        searchIndex = tokenIndex + token.length;
      }
      const score = matches.length > 0 ? Math.min(100, totalScore / matches.length) : 0;
      const hasProfanity = score >= this.sensitivityThreshold && matches.length > 0;
      const censoredText = this.censorText(text, matches);
      return {
        hasProfanity,
        score,
        matches,
        censoredText
      };
    }
    /**
     * Replace profanity matches with [CENSORED]
     * Preserves original text positions
     */
    censorText(text, matches) {
      if (matches.length === 0) return text;
      const sortedMatches = [...matches].sort((a, b) => b.startIndex - a.startIndex);
      let result = text;
      for (const match of sortedMatches) {
        result = result.slice(0, match.startIndex) + "[CENSORED]" + result.slice(match.endIndex);
      }
      return result;
    }
  };
  function createDetector(config) {
    return new ProfanityDetector({
      wordlist: DEFAULT_WORDLIST,
      fuzzyThreshold: 0.25,
      sensitivity: "medium",
      ...config
    });
  }

  // src/lib/cueIndex.ts
  var CueIndex = class {
    constructor() {
      this.cues = [];
      this.sortedByStart = [];
    }
    /**
     * Build index from cue list
     */
    build(cues2) {
      this.cues = cues2;
      this.sortedByStart = cues2.map((cue) => ({ cue, start: cue.startMs, end: cue.endMs })).sort((a, b) => a.start - b.start);
    }
    /**
     * Find the active cue at a given timestamp (in ms)
     * Returns the first matching cue or null
     */
    findActive(timestampMs, offsetMs = 0) {
      const adjustedTime = timestampMs + offsetMs;
      let low = 0;
      let high = this.sortedByStart.length - 1;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const node = this.sortedByStart[mid];
        if (node.start <= adjustedTime) {
          if (node.end >= adjustedTime) {
            return node.cue;
          }
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      return null;
    }
    /**
     * Find all active cues at a given timestamp
     * Useful for overlapping subtitles
     */
    findAllActive(timestampMs, offsetMs = 0) {
      const adjustedTime = timestampMs + offsetMs;
      const active = [];
      for (const node of this.sortedByStart) {
        if (node.start <= adjustedTime && node.end >= adjustedTime) {
          active.push(node.cue);
        }
        if (node.start > adjustedTime) break;
      }
      return active;
    }
    /**
     * Get the next N cues after the current timestamp
     * Useful for preview/prefetch
     */
    getNextCues(timestampMs, count, offsetMs = 0) {
      const adjustedTime = timestampMs + offsetMs;
      const next = [];
      for (const node of this.sortedByStart) {
        if (node.start > adjustedTime && next.length < count) {
          next.push(node.cue);
        }
      }
      return next;
    }
    /**
     * Get total duration covered by cues
     */
    getTotalDuration() {
      if (this.cues.length === 0) return 0;
      const lastCue = this.cues[this.cues.length - 1];
      return lastCue.endMs;
    }
    /**
     * Get count of cues
     */
    getCueCount() {
      return this.cues.length;
    }
    /**
     * Clear index
     */
    clear() {
      this.cues = [];
      this.sortedByStart = [];
    }
    /**
     * Get all cues
     */
    getAllCues() {
      return [...this.cues];
    }
  };

  // src/content/index.ts
  var cues = [];
  var detector;
  var settings;
  var cueIndex;
  var overlayContainer = null;
  var currentCueEl = null;
  var nextCuesEl = null;
  var videoElement = null;
  var isActive = false;
  var animationFrameId = null;
  var lastCueId = null;
  async function init() {
    settings = await storage.getSettings();
    detector = createDetector(settings);
    if (settings.wordlist.length > 0) {
      detector.addWords(settings.wordlist);
    }
    cueIndex = new CueIndex();
    findVideoElement();
    createOverlay();
    const savedCues = await storage.getCues();
    if (savedCues.length > 0) {
      processCues(savedCues);
    }
    browser.storage.onChanged.addListener(handleStorageChange);
    browser.runtime.onMessage.addListener(handleMessage);
  }
  function findVideoElement() {
    const videos = document.querySelectorAll("video");
    if (videos.length > 0) {
      videoElement = videos[0];
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
  function createOverlay() {
    if (overlayContainer) return;
    overlayContainer = document.createElement("div");
    overlayContainer.id = "ffprofanity-overlay";
    overlayContainer.className = "ffprofanity-overlay";
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
    currentCueEl = document.createElement("div");
    currentCueEl.className = "ffprofanity-cue";
    currentCueEl.style.display = "none";
    nextCuesEl = document.createElement("div");
    nextCuesEl.className = "ffprofanity-next-cues";
    overlayContainer.appendChild(currentCueEl);
    overlayContainer.appendChild(nextCuesEl);
    document.body.appendChild(overlayContainer);
  }
  function handleStorageChange(changes) {
    if (changes.settings) {
      settings = { ...settings, ...changes.settings.newValue };
      detector = createDetector(settings);
    }
  }
  function handleMessage(message) {
    if (!message || typeof message !== "object") return Promise.resolve();
    const msg = message;
    switch (msg.type) {
      case "uploadCues":
        const content = msg.content;
        handleSubtitleUpload(content);
        break;
      case "updateOffset":
        const offset = msg.offsetMs;
        if (typeof offset === "number") {
          settings.offsetMs = offset;
          storage.setSetting("offsetMs", offset);
        }
        break;
      case "enable":
        isActive = true;
        startMonitoring();
        break;
      case "disable":
        isActive = false;
        stopMonitoring();
        break;
      case "getStatus":
        return Promise.resolve({
          active: isActive,
          cueCount: cues.length,
          hasVideo: !!videoElement
        });
    }
    return Promise.resolve();
  }
  async function handleSubtitleUpload(content) {
    const result = parseSubtitle(content);
    if (result.errors.length > 0) {
      console.error("Parse errors:", result.errors);
      return;
    }
    processCues(result.cues);
    await storage.setCues(cues);
  }
  function processCues(newCues) {
    cues = newCues.map((cue) => {
      const detection = detector.detect(cue.text);
      return {
        ...cue,
        censoredText: detection.censoredText,
        hasProfanity: detection.hasProfanity,
        profanityScore: detection.score,
        profanityMatches: detection.matches
      };
    });
    cueIndex.build(cues);
    if (cues.length > 0 && videoElement) {
      isActive = true;
      startMonitoring();
    }
  }
  function startMonitoring() {
    if (!videoElement || animationFrameId) return;
    const updateLoop = () => {
      if (!isActive || !videoElement) return;
      updatePlayback(videoElement.currentTime * 1e3);
      animationFrameId = requestAnimationFrame(updateLoop);
    };
    animationFrameId = requestAnimationFrame(updateLoop);
  }
  function stopMonitoring() {
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
  }
  function debounce(fn, delay) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }
  var debouncedMute = debounce((tabId, cueId, expectedUnmuteAt) => {
    browser.runtime.sendMessage({
      type: "muteNow",
      tabId,
      reasonId: cueId,
      expectedUnmuteAt
    });
  }, 50);
  var debouncedUnmute = debounce(() => {
    browser.runtime.sendMessage({
      type: "unmuteNow"
    });
  }, 50);
  function updatePlayback(currentTimeMs) {
    if (!videoElement || !currentCueEl) return;
    const effectiveTime = currentTimeMs + settings.offsetMs;
    const currentCue = cueIndex.findActive(currentTimeMs, settings.offsetMs);
    const nextCues = cueIndex.getNextCues(currentTimeMs, 3, settings.offsetMs);
    if (currentCue?.hasProfanity && currentCue.id !== lastCueId) {
      debouncedMute(
        0,
        // will be set by background
        `cue-${currentCue.id}`,
        currentCue.endMs
      );
      lastCueId = currentCue.id;
    } else if (!currentCue?.hasProfanity && lastCueId !== null) {
      debouncedUnmute();
      lastCueId = null;
    }
    if (currentCue) {
      const displayText = currentCue.hasProfanity ? currentCue.censoredText : sanitizeText(currentCue.text);
      currentCueEl.textContent = displayText;
      currentCueEl.style.display = "block";
      currentCueEl.classList.remove("ffprofanity-hidden");
      if (nextCues.length > 0) {
        const previews = nextCues.map((c) => {
          const time = formatTime(c.startMs);
          const text = c.hasProfanity ? c.censoredText : sanitizeText(c.text);
          return `<div class="ffprofanity-preview">${time}: ${text.substring(0, 50)}${text.length > 50 ? "..." : ""}</div>`;
        }).join("");
        nextCuesEl.innerHTML = previews;
      } else {
        nextCuesEl.innerHTML = "";
      }
    } else {
      currentCueEl.classList.add("ffprofanity-hidden");
    }
  }
  function formatTime(ms) {
    const totalSeconds = Math.floor(ms / 1e3);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor(totalSeconds % 3600 / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
      return `${hours}:${minutes.toString(10).padStart(2, "0")}:${seconds.toString(10).padStart(2, "0")}`;
    }
    return `${minutes}:${seconds.toString(10).padStart(2, "0")}`;
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
  document.addEventListener("keydown", (event) => {
    if (event.altKey && event.key === "ArrowLeft") {
      settings.offsetMs -= 500;
      storage.setSetting("offsetMs", settings.offsetMs);
    } else if (event.altKey && event.key === "ArrowRight") {
      settings.offsetMs += 500;
      storage.setSetting("offsetMs", settings.offsetMs);
    }
  });
})();
