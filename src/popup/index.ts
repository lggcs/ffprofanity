/**
 * Popup UI
 * Quick controls for enable/disable and current status
 */

import "../styles/popup.css";
import type { Settings, SubtitleTrack } from "../types";
import { error } from '../lib/logger';

// State
let isActive = false;
let hasVideo = false;
let currentTrack: SubtitleTrack | null = null;
let detectedTracks: SubtitleTrack[] = [];
let settings: Partial<Settings> = {};
// Whether a user-uploaded subtitle file is currently active
let isUserUploadActive = false;

// DOM Elements - initialized in init()
let statusEl: HTMLElement;
let trackSection: HTMLElement;
let currentTrackName: HTMLElement;
let trackList: HTMLElement;
let trackOptions: HTMLElement;
let mainView: HTMLElement;
let settingsView: HTMLElement;
let showUpcomingCheckbox: HTMLInputElement;
let showProfanityOnlyCheckbox: HTMLInputElement;

async function init(): Promise<void> {
  // Get DOM elements
  mainView = document.getElementById("mainView") as HTMLElement;
  settingsView = document.getElementById("settingsView") as HTMLElement;
  statusEl = document.getElementById("status") as HTMLElement;
  trackSection = document.getElementById("trackSection") as HTMLElement;
  currentTrackName = document.getElementById("currentTrackName") as HTMLElement;
  trackList = document.getElementById("trackList") as HTMLElement;
  trackOptions = document.getElementById("trackOptions") as HTMLElement;

  // Load current status
  await loadStatus();

  // Load settings for the settings view
  await loadSettings();

  // Setup event handlers
  setupEventHandlers();

  // Show current drift-correction state (content script may not respond —
  // e.g. popup opened on a non-video tab — in which case defaults remain)
  refreshDriftStatus();
}

function setupEventHandlers(): void {
  // Main view buttons
  const toggleBtn = document.getElementById("toggle") as HTMLButtonElement;
  const optionsBtn = document.getElementById("options") as HTMLButtonElement;
  const changeTrackBtn = document.getElementById("changeTrackBtn") as HTMLButtonElement;
  const unloadBtn = document.getElementById("unloadBtn") as HTMLButtonElement;
  const uploadBtn = document.getElementById("uploadBtn") as HTMLButtonElement;
  const openFullOptions = document.getElementById("openFullOptions") as HTMLAnchorElement;

  toggleBtn.addEventListener("click", handleToggle);
  optionsBtn.addEventListener("click", showSettingsView);
  changeTrackBtn.addEventListener("click", handleChangeOrUpload);
  unloadBtn.addEventListener("click", handleUnload);
  uploadBtn.addEventListener("click", handleUploadClick);

  // Drift / sync correction controls
  const syncNowBtn = document.getElementById("syncNowBtn") as HTMLButtonElement | null;
  const resetSyncBtn = document.getElementById("resetSyncBtn") as HTMLButtonElement | null;
  syncNowBtn?.addEventListener("click", handleSyncNow);
  resetSyncBtn?.addEventListener("click", handleResetSync);
  
  // Full options link opens in new tab
  openFullOptions.addEventListener("click", (e) => {
    e.preventDefault();
    browser.tabs.create({ url: browser.runtime.getURL("options.html") });
  });

  // Settings view buttons
  const backBtn = document.getElementById("backBtn") as HTMLButtonElement;
  const saveSettingsBtn = document.getElementById("saveSettings") as HTMLButtonElement;
  const offsetBackBtn = document.getElementById("offsetBack") as HTMLButtonElement;
  const offsetForwardBtn = document.getElementById("offsetForward") as HTMLButtonElement;
  const offsetSlider = document.getElementById("offsetSlider") as HTMLInputElement;
  const sensitivitySelect = document.getElementById("sensitivity") as HTMLSelectElement;
  showUpcomingCheckbox = document.getElementById("showUpcomingCues") as HTMLInputElement;
  showProfanityOnlyCheckbox = document.getElementById("showProfanityOnly") as HTMLInputElement;
  const useSubstitutionsCheckbox = document.getElementById("useSubstitutions") as HTMLInputElement;
  const substitutionCategorySelect = document.getElementById("substitutionCategory") as HTMLSelectElement;
  const fontSizeSelect = document.getElementById("fontSize") as HTMLSelectElement;
  const positionSelect = document.getElementById("position") as HTMLSelectElement;

  backBtn.addEventListener("click", showMainView);
  saveSettingsBtn.addEventListener("click", saveSettings);
  
  offsetBackBtn.addEventListener("click", () => adjustOffset(-500));
  offsetForwardBtn.addEventListener("click", () => adjustOffset(500));
  offsetSlider.addEventListener("input", updateOffsetDisplay);
  
  // Toggle substitution category visibility
  useSubstitutionsCheckbox.addEventListener("change", () => {
    substitutionCategorySelect.classList.toggle("hidden", !useSubstitutionsCheckbox.checked);
  });

  // Disable upcoming cues when profanity-only is active
  showProfanityOnlyCheckbox.addEventListener("change", () => {
    updatePopupUpcomingCuesState();
  });

  // Show/hide upcoming count when upcoming cues toggled
  showUpcomingCheckbox.addEventListener("change", () => {
    updatePopupUpcomingCuesState();
  });
}

function updatePopupUpcomingCuesState(): void {
  const isProfanityOnly = showProfanityOnlyCheckbox.checked;
  showUpcomingCheckbox.disabled = isProfanityOnly;
  if (isProfanityOnly) {
    showUpcomingCheckbox.checked = false;
  }
  // Show/hide upcoming count section based on whether upcoming cues are enabled
  const upcomingCountSection = document.getElementById("upcomingCountSection");
  if (upcomingCountSection) {
    upcomingCountSection.style.display =
      showUpcomingCheckbox.checked && !isProfanityOnly ? "block" : "none";
  }
}

/**
 * True when the popup is running as a regular tab instead of a desktop
 * panel — Firefox Android opens action popups as tabs.
 */
async function isRunningAsTab(): Promise<boolean> {
  const [selfTab] = await browser.tabs.query({ active: true, currentWindow: true });
  return selfTab?.url?.startsWith("moz-extension://") ?? false;
}

/**
 * Resolve the tab the content script lives in (the video tab).
 *
 * On Firefox Android the action popup opens as its own tab, so the naive
 * "active tab" query resolves to the popup itself and every per-tab
 * message targets the wrong tab. Detect that case and fall back to the
 * most recently active regular web tab instead.
 */
async function getVideoTabId(): Promise<number | null> {
  const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
  const activeUrl = activeTab?.url;
  if (
    activeUrl &&
    (activeUrl.startsWith("moz-extension://") ||
      activeUrl.startsWith("about:") ||
      activeUrl.startsWith("chrome://"))
  ) {
    const candidates = await browser.tabs.query({ active: false });
    const videoTab = candidates
      .filter((t) => {
        const url = t.url ?? "";
        return (
          (url.startsWith("http://") || url.startsWith("https://")) &&
          !t.discarded
        );
      })
      .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
    return videoTab?.id ?? null;
  }
  return activeTab?.id ?? null;
}

async function loadSettings(): Promise<void> {
  try {
    const result = await browser.storage.local.get("settings") as { settings?: Partial<Settings> };
    settings = result.settings || {};

    // Update settings view with loaded values
    const offsetSlider = document.getElementById("offsetSlider") as HTMLInputElement;
    const offsetValue = document.getElementById("offsetValue") as HTMLElement;
    const sensitivitySelect = document.getElementById("sensitivity") as HTMLSelectElement;
    const useSubstitutionsCheckbox = document.getElementById("useSubstitutions") as HTMLInputElement;
    const substitutionCategorySelect = document.getElementById("substitutionCategory") as HTMLSelectElement;
    const fontSizeSelect = document.getElementById("fontSize") as HTMLSelectElement;
    const positionSelect = document.getElementById("position") as HTMLSelectElement;

    // Color settings
    const fontColorInput = document.getElementById("fontColor") as HTMLInputElement;
    const fontColorText = document.getElementById("fontColorText") as HTMLInputElement;
    const backgroundColorInput = document.getElementById("backgroundColor") as HTMLInputElement;
    const backgroundColorText = document.getElementById("backgroundColorText") as HTMLInputElement;
    const backgroundOpacitySlider = document.getElementById("backgroundOpacity") as HTMLInputElement;
    const opacityValue = document.getElementById("opacityValue") as HTMLElement;

    offsetSlider.value = String(settings.offsetMs || 0);
    offsetValue.textContent = `${settings.offsetMs || 0}ms`;
    sensitivitySelect.value = settings.sensitivity || "medium";
    showUpcomingCheckbox.checked = settings.showUpcomingCues === true;
    showProfanityOnlyCheckbox.checked = settings.showProfanityOnly === true;
    useSubstitutionsCheckbox.checked = settings.useSubstitutions !== false;  // Default to true
    substitutionCategorySelect.value = settings.substitutionCategory || "monkeys";
    fontSizeSelect.value = settings.fontSize || "medium";
    positionSelect.value = settings.position || "bottom";

    // Load color settings
    const fontColor = settings.fontColor || "#ffffff";
    const bgColor = settings.backgroundColor || "#000000";
    const bgOpacity = settings.backgroundOpacity ?? 80;

    fontColorInput.value = fontColor;
    fontColorText.value = fontColor;
    backgroundColorInput.value = bgColor;
    backgroundColorText.value = bgColor;
    backgroundOpacitySlider.value = String(bgOpacity);
    opacityValue.textContent = `${bgOpacity}%`;

    // Load upcoming cues count
    const upcomingCuesCountSelect = document.getElementById("upcomingCuesCount") as HTMLSelectElement;
    if (upcomingCuesCountSelect) {
      upcomingCuesCountSelect.value = String(settings.upcomingCuesCount ?? 2);
    }

    // Show/hide category select based on substitutions checkbox
    substitutionCategorySelect.classList.toggle("hidden", !useSubstitutionsCheckbox.checked);

    // Disable upcoming cues when profanity-only is active
    updatePopupUpcomingCuesState();

    // Setup color input sync
    setupColorSync();
  } catch (err) {
    error("Failed to load settings:", err);
  }
}

function setupColorSync(): void {
  // Sync color picker with text input
  const fontColorPicker = document.getElementById("fontColor") as HTMLInputElement;
  const fontColorText = document.getElementById("fontColorText") as HTMLInputElement;
  const bgColorPicker = document.getElementById("backgroundColor") as HTMLInputElement;
  const bgColorText = document.getElementById("backgroundColorText") as HTMLInputElement;

  fontColorPicker.addEventListener("input", () => {
    fontColorText.value = fontColorPicker.value;
  });
  fontColorText.addEventListener("input", () => {
    if (/^#[0-9A-Fa-f]{6}$/.test(fontColorText.value)) {
      fontColorPicker.value = fontColorText.value;
    }
  });

  bgColorPicker.addEventListener("input", () => {
    bgColorText.value = bgColorPicker.value;
  });
  bgColorText.addEventListener("input", () => {
    if (/^#[0-9A-Fa-f]{6}$/.test(bgColorText.value)) {
      bgColorPicker.value = bgColorText.value;
    }
  });
}

async function saveSettings(): Promise<void> {
  try {
    const offsetSlider = document.getElementById("offsetSlider") as HTMLInputElement;
    const sensitivitySelect = document.getElementById("sensitivity") as HTMLSelectElement;
    const showUpcomingCheckbox = document.getElementById("showUpcomingCues") as HTMLInputElement;
    const showProfanityOnlyCheckbox = document.getElementById("showProfanityOnly") as HTMLInputElement;
    const useSubstitutionsCheckbox = document.getElementById("useSubstitutions") as HTMLInputElement;
    const substitutionCategorySelect = document.getElementById("substitutionCategory") as HTMLSelectElement;
    const fontSizeSelect = document.getElementById("fontSize") as HTMLSelectElement;
    const positionSelect = document.getElementById("position") as HTMLSelectElement;

    // Color settings
    const fontColorInput = document.getElementById("fontColor") as HTMLInputElement;
    const backgroundColorInput = document.getElementById("backgroundColor") as HTMLInputElement;
    const backgroundOpacitySlider = document.getElementById("backgroundOpacity") as HTMLInputElement;

    const newSettings: Partial<Settings> = {
      offsetMs: parseInt(offsetSlider.value, 10),
      sensitivity: sensitivitySelect.value as "low" | "medium" | "high",
      showUpcomingCues: showUpcomingCheckbox.checked,
      showProfanityOnly: showProfanityOnlyCheckbox.checked,
      useSubstitutions: useSubstitutionsCheckbox.checked,
      substitutionCategory: substitutionCategorySelect.value as "silly" | "polite" | "random" | "monkeys" | "custom",
      fontSize: fontSizeSelect.value as "small" | "medium" | "large" | "xlarge",
      position: positionSelect.value as "bottom" | "middle" | "top",
      fontColor: fontColorInput.value,
      backgroundColor: backgroundColorInput.value,
      backgroundOpacity: parseInt(backgroundOpacitySlider.value, 10),
      upcomingCuesCount: parseInt(
        (document.getElementById("upcomingCuesCount") as HTMLSelectElement).value,
        10,
      ),
    };

    // Save to storage
    const existingSettings = (await browser.storage.local.get("settings")) as { settings?: Settings };
    await browser.storage.local.set({
      settings: {
        ...existingSettings.settings,
        ...newSettings,
      },
    });

    // Verify the write actually landed — Firefox Android can silently drop
    // pending writes when the popup tab is discarded after a Save tap
    const verifyRead = (await browser.storage.local.get("settings")) as { settings?: Settings };
    const merged = { ...existingSettings.settings, ...newSettings };
    const writeLanded =
      verifyRead.settings !== undefined &&
      Object.keys(merged).every(
        (key) =>
          JSON.stringify(verifyRead.settings?.[key as keyof Settings]) ===
          JSON.stringify(merged[key as keyof Settings]),
      );
    if (!writeLanded) {
      const saveBtnRetry = document.getElementById("saveSettings") as HTMLButtonElement;
      saveBtnRetry.textContent = "Save failed — try again";
      saveBtnRetry.disabled = false;
      error("Settings write did not persist after re-read; not switching views");
      return;
    }

    // Notify content scripts in all tabs of settings change
    const tabs = await browser.tabs.query({});
    for (const tab of tabs) {
      if (tab.id) {
        browser.tabs.sendMessage(tab.id, {
          type: "updateSettings",
          settings: newSettings,
        }).catch(() => {}); // Ignore errors for inactive tabs
      }
    }

    // Show success notification briefly
    const saveBtn = document.getElementById("saveSettings") as HTMLButtonElement;
    const originalText = saveBtn.textContent;
    saveBtn.textContent = "Saved!";
    saveBtn.disabled = true;
    setTimeout(() => {
      saveBtn.textContent = originalText;
      saveBtn.disabled = false;
    }, 1500);

    // On desktop the panel auto-returns to the main view. When running as
    // a tab (Firefox Android), stay put — the user still has the panel
    // visible and there is no tab-discard race to race against here.
    if (!(await isRunningAsTab())) {
      setTimeout(showMainView, 800);
    }
  } catch (err) {
    error("Failed to save settings:", err);
  }
}

function adjustOffset(amount: number): void {
  const offsetSlider = document.getElementById("offsetSlider") as HTMLInputElement;
  const offsetValue = document.getElementById("offsetValue") as HTMLElement;
  
  const current = parseInt(offsetSlider.value, 10);
  const newValue = Math.max(-10000, Math.min(10000, current + amount));
  offsetSlider.value = String(newValue);
  offsetValue.textContent = `${newValue}ms`;
}

function updateOffsetDisplay(): void {
  const offsetSlider = document.getElementById("offsetSlider") as HTMLInputElement;
  const offsetValue = document.getElementById("offsetValue") as HTMLElement;
  offsetValue.textContent = `${offsetSlider.value}ms`;
}

function showSettingsView(): void {
  mainView.classList.add("hidden");
  settingsView.classList.remove("hidden");
}

function showMainView(): void {
  settingsView.classList.add("hidden");
  mainView.classList.remove("hidden");
}

async function loadStatus(): Promise<void> {
  try {
    // Get current tab (popup may be running as its own tab on Firefox Android)
    const tabId = await getVideoTabId();
    if (!tabId) return;

    // Try to get status from background (aggregates from all frames)
    try {
      const response = (await browser.runtime.sendMessage({
        type: "getAggregatedStatus",
        tabId,
      })) as {
        active: boolean;
        cueCount: number;
        hasVideo: boolean;
        currentTrack: SubtitleTrack | null;
        detectedTracks: SubtitleTrack[];
        userUploadActive?: boolean;
      };

      isActive = response.active;
      currentTrack = response.currentTrack || null;
      detectedTracks = response.detectedTracks || [];
      isUserUploadActive = response.userUploadActive === true;

      updateStatus(response);
      updateTrackSection();
    } catch {
      // Background script not available, try direct content script query
      try {
        const response = (await browser.tabs.sendMessage(tabId, {
          type: "getStatus",
        })) as {
          active: boolean;
          cueCount: number;
          hasVideo: boolean;
          currentTrack: SubtitleTrack | null;
          detectedTracks: SubtitleTrack[];
          userUploadActive?: boolean;
        };

        isActive = response.active;
        currentTrack = response.currentTrack || null;
        detectedTracks = response.detectedTracks || [];
        isUserUploadActive = response.userUploadActive === true;

        updateStatus(response);
        updateTrackSection();
      } catch {
        // Content script not loaded or doesn't support this
        updateStatus({ active: false, cueCount: 0, hasVideo: false });
        updateTrackSection();
      }
    }
  } catch (err) {
    error("Failed to load status:", err);
  }
}

function updateStatus(status: {
  active: boolean;
  cueCount: number;
  profanityCount?: number;
  hasVideo: boolean;
}): void {
  const statusIndicator = document.getElementById(
    "statusIndicator",
  ) as HTMLElement;
  const statusText = document.getElementById("statusText") as HTMLElement;
  const toggleBtn = document.getElementById("toggle") as HTMLButtonElement;
  const statsSection = document.getElementById("statsSection") as HTMLElement;
  const totalCuesEl = document.getElementById("totalCues") as HTMLElement;
  const profanityCountEl = document.getElementById(
    "profanityCount",
  ) as HTMLElement;

  if (!status.hasVideo) {
    hasVideo = false;
    statusIndicator.className = "status-indicator status-warning";
    statusText.textContent = "No video detected";
    toggleBtn.disabled = true;
    statsSection.classList.add("hidden");
  } else {
    hasVideo = true;
    if (status.active) {
      statusIndicator.className = "status-indicator status-active";
      statusText.textContent = "Active";
      toggleBtn.textContent = "Disable";
      toggleBtn.disabled = false;

      // Show stats
      if (status.cueCount > 0) {
        statsSection.classList.remove("hidden");
        totalCuesEl.textContent = status.cueCount.toString();
        profanityCountEl.textContent = (status.profanityCount || 0).toString();
      } else {
        statsSection.classList.add("hidden");
      }
    } else {
      statusIndicator.className = "status-indicator status-inactive";
      statusText.textContent = "Disabled";
      toggleBtn.textContent = "Enable";
      toggleBtn.disabled = false;
      statsSection.classList.add("hidden");
    }
  }
}

function updateTrackSection(): void {
  const unloadBtn = document.getElementById("unloadBtn") as HTMLButtonElement;
  const changeTrackBtn = document.getElementById("changeTrackBtn") as HTMLButtonElement;

  // Show track section when a video is detected, even if no tracks were found.
  // This ensures the upload button is always accessible when the user might
  // want to manually upload subtitles (e.g. on streaming sites where auto-
  // detection found nothing).
  if (hasVideo || detectedTracks.length > 0 || currentTrack) {
    trackSection.classList.remove("hidden");

    if (currentTrack) {
      const label = currentTrack.isSDH
        ? `${currentTrack.label} ★`
        : currentTrack.label;
      currentTrackName.textContent = label;
    } else if (detectedTracks.length === 0) {
      currentTrackName.textContent = "No subtitles detected";
    } else {
      currentTrackName.textContent = "None selected";
    }

    // Change button label based on context: "Upload" when no tracks detected,
    // "Change" when there are tracks to choose from
    if (changeTrackBtn) {
      changeTrackBtn.textContent = detectedTracks.length === 0 && !currentTrack ? "Upload" : "Change";
    }
  } else {
    trackSection.classList.add("hidden");
  }

  // Show unload button only when a user upload is active
  if (unloadBtn) {
    unloadBtn.style.display = isUserUploadActive ? "inline-block" : "none";
  }
}

function toggleTrackList(): void {
  trackList.classList.toggle("hidden");

  if (!trackList.classList.contains("hidden")) {
    renderTrackOptions();
  }
}

/** When no tracks are detected, go straight to upload overlay instead of track list */
function handleChangeOrUpload(): void {
  if (detectedTracks.length === 0 && !currentTrack) {
    handleUploadClick();
  } else {
    toggleTrackList();
  }
}

function renderTrackOptions(): void {
  trackOptions.replaceChildren();

  for (const track of detectedTracks) {
    const item = document.createElement("div");
    item.className = "track-item";
    if (track.isSDH) {
      item.classList.add("sdh");
    }
    if (currentTrack?.id === track.id) {
      item.classList.add("selected");
    }

    const label = track.isSDH ? `${track.label} ★` : track.label;
    const source =
      track.source === "user"
        ? "(uploaded)"
        : track.source === "network"
          ? "(detected)"
          : "";

    item.textContent = `${label} ${source}`;
    item.addEventListener("click", () => handleSelectTrack(track));

    trackOptions.appendChild(item);
  }

  // Add upload option
  if (detectedTracks.length === 0) {
    const noTracks = document.createElement("div");
    noTracks.className = "track-item";
    noTracks.textContent = "No tracks detected on this page";
    noTracks.style.fontStyle = "italic";
    noTracks.style.color = "#888";
    trackOptions.appendChild(noTracks);
  }
}

async function handleSelectTrack(track: SubtitleTrack): Promise<void> {
  const tabId = await getVideoTabId();
  if (!tabId) return;

  try {
    await browser.tabs.sendMessage(tabId, {
      type: "selectTrack",
      trackId: track.id,
    });
    currentTrack = track;
    updateTrackSection();
    trackList.classList.add("hidden");
  } catch (err) {
    error("Failed to select track:", err);
  }
}

async function handleToggle(): Promise<void> {
  const tabId = await getVideoTabId();
  if (!tabId) return;

  const newEnabled = !isActive;
  const message = newEnabled
    ? { type: "enable", tabId }
    : { type: "disable", tabId };

  // Persist the enabled state so it survives navigation and re-injection
  try {
    const result = (await browser.storage.local.get("settings")) as {
      settings?: Partial<Settings>;
    };
    const existing = result.settings || {};
    await browser.storage.local.set({
      settings: { ...existing, enabled: newEnabled },
    });
  } catch {
    error("Failed to persist enabled state to storage");
  }

  // Route through background so it can relay to ALL frames and
  // release any active tab mute state. On Android the background may
  // fail to wake; fall back to direct all-frames delivery + mute release.
  let delivered = false;
  try {
    await browser.runtime.sendMessage(message);
    delivered = true;
  } catch {
    error("Background relay failed; falling back to direct delivery");
  }
  if (!delivered) {
    // Replicate background behavior: enable/disable every frame, and on
    // disable release any reference-counted mute state.
    try {
      const frames = await browser.webNavigation.getAllFrames({ tabId });
      for (const frame of frames ?? []) {
        browser.tabs
          .sendMessage(tabId, newEnabled ? { type: "enable" } : { type: "disable" }, {
            frameId: frame.frameId,
          })
          .catch(() => {});
      }
    } catch {
      // webNavigation unavailable — try top frame only
      browser.tabs
        .sendMessage(tabId, newEnabled ? { type: "enable" } : { type: "disable" })
        .catch(() => {});
    }
    if (!newEnabled) {
      browser.tabs.update(tabId, { muted: false }).catch(() => {});
    }
  }

  isActive = newEnabled;

  // Reload status
  await loadStatus();
}

async function handleUploadClick(): Promise<void> {
  // Send a message to the content script to show an upload overlay
  // directly on the video page. This avoids the Firefox bug where
  // popup panels close when the native file picker opens.
  const tabId = await getVideoTabId();
  if (!tabId) return;

  try {
    await browser.runtime.sendMessage({
      type: "showUploadOverlay",
      tabId,
    });
    // Close the popup since the overlay is now shown on the video page.
    // As a tab (Firefox Android) window.close() is a no-op for a
    // user-opened tab, so switch back to the video tab instead.
    if (await isRunningAsTab()) {
      await browser.tabs.update(tabId, { active: true });
    } else {
      window.close();
    }
  } catch (err) {
    error("Failed to show upload overlay:", err);
  }
}

/** Drift status shape reported by the content script */
interface DriftStatus {
  hasModel: boolean;
  rate: number;
  offsetMs: number;
  anchorCount: number;
  fitRmsMs: number;
  enabled: boolean;
  autoEnabled?: boolean;
  autoWatching?: boolean;
}

/**
 * Get the video tab id for the active window (null when none).
 */
async function getActiveTabId(): Promise<number | null> {
  return getVideoTabId();
}

/**
 * "Sync now": tell the video frame that the currently displayed subtitle
 * line is being spoken right now. The content script captures the anchor,
 * refits the model, applies it, and returns a result line we display.
 */
async function handleSyncNow(): Promise<void> {
  const tabId = await getActiveTabId();
  if (!tabId) return;
  try {
    const result = (await browser.tabs.sendMessage(tabId, {
      type: "captureDriftAnchor",
    })) as string | undefined;
    if (typeof result === "string" && result.length > 0) {
      showDriftResult(result);
    } else {
      showDriftResult("No active subtitle line to sync against");
    }
  } catch (err) {
    error("Failed to send captureDriftAnchor:", err);
    showDriftResult("No video page with subtitles in this tab");
  }
}

/**
 * Reset drift correction for the current movie.
 */
async function handleResetSync(): Promise<void> {
  const tabId = await getActiveTabId();
  if (!tabId) return;
  try {
    await browser.tabs.sendMessage(tabId, { type: "resetDrift" });
    setTimeout(refreshDriftStatus, 300);
  } catch (err) {
    error("Failed to send resetDrift:", err);
  }
}

/**
 * Query the content script for current drift status and render it.
 */
async function refreshDriftStatus(): Promise<void> {
  const tabId = await getActiveTabId();
  if (!tabId) return;
  try {
    const response = (await browser.tabs.sendMessage(tabId, {
      type: "getDriftStatus",
    })) as DriftStatus | undefined;
    if (response) {
      renderDriftStatus(response);
    }
  } catch {
    // Content script not in this tab — leave the default text
  }
}

/**
 * Render the drift status line in the popup.
 */
function renderDriftStatus(status: DriftStatus): void {
  const statusEl = document.getElementById("driftStatus");
  if (!statusEl) return;

  if (!status.enabled) {
    statusEl.textContent = status.hasModel ? "Correction paused" : "No correction";
    return;
  }

  if (!status.hasModel) {
    statusEl.textContent = status.autoEnabled
      ? status.autoWatching
        ? "Auto-sync watching"
        : "Auto-sync armed"
      : "Manual mode — offset slider only";
    return;
  }

  const offsetSec = status.offsetMs / 1000;
  const offsetStr = `${offsetSec >= 0 ? "+" : ""}${offsetSec.toFixed(1)}s`;
  const rateStr = status.rate !== 1 ? ` ×${status.rate.toFixed(4)}` : "";
  const anchors = status.anchorCount > 1 ? ` (${status.anchorCount} anchors)` : "";
  const autoStr = status.autoEnabled ? " auto" : "";
  statusEl.textContent = `Applied: ${offsetStr}${rateStr}${anchors}${autoStr}`;
}

/**
 * Show a transient result message under the sync buttons.
 */
function showDriftResult(message: string): void {
  const el = document.getElementById("driftResult");
  if (!el) return;
  el.textContent = message;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 4000);
}

async function handleUnload(): Promise<void> {
  const tabId = await getVideoTabId();
  if (!tabId) return;

  try {
    await browser.runtime.sendMessage({
      type: "unloadCues",
      tabId,
    });
    isUserUploadActive = false;
    currentTrack = null;
    await loadStatus();
  } catch (err) {
    error("Failed to unload cues:", err);
  }
}

// Initialize on DOM ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}