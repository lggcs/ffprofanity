/**
 * Popup UI
 * Quick controls for enable/disable and current status
 */

import "../styles/popup.css";
import type { Settings, SubtitleTrack } from "../types";
import { error } from '../lib/logger';

// State
let isActive = false;
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
  changeTrackBtn.addEventListener("click", toggleTrackList);
  unloadBtn.addEventListener("click", handleUnload);
  uploadBtn.addEventListener("click", handleUploadClick);
  
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
  const showUpcomingCheckbox = document.getElementById("showUpcomingCues") as HTMLInputElement;
  const showProfanityOnlyCheckbox = document.getElementById("showProfanityOnly") as HTMLInputElement;
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
}

function updatePopupUpcomingCuesState(): void {
  const isProfanityOnly = showProfanityOnlyCheckbox.checked;
  showUpcomingCheckbox.disabled = isProfanityOnly;
  if (isProfanityOnly) {
    showUpcomingCheckbox.checked = false;
  }
}

async function loadSettings(): Promise<void> {
  try {
    settings = await browser.storage.local.get("settings") as { settings?: Partial<Settings> };
    settings = settings.settings || {};

    // Update settings view with loaded values
    const offsetSlider = document.getElementById("offsetSlider") as HTMLInputElement;
    const offsetValue = document.getElementById("offsetValue") as HTMLElement;
    const sensitivitySelect = document.getElementById("sensitivity") as HTMLSelectElement;
    const showUpcomingCheckbox = document.getElementById("showUpcomingCues") as HTMLInputElement;
    const showProfanityOnlyCheckbox = document.getElementById("showProfanityOnly") as HTMLInputElement;
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
    };

    // Save to storage
    const existingSettings = (await browser.storage.local.get("settings")) as { settings?: Settings };
    await browser.storage.local.set({
      settings: {
        ...existingSettings.settings,
        ...newSettings,
      },
    });

    // Notify content script of settings change
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab.id) {
      await browser.tabs.sendMessage(tab.id, {
        type: "updateSettings",
        settings: newSettings,
      });
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

    // Switch back to main view after a short delay
    setTimeout(showMainView, 800);
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
    // Get current tab
    const [tab] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab.id) return;

    // Try to get status from background (aggregates from all frames)
    try {
      const response = (await browser.runtime.sendMessage({
        type: "getAggregatedStatus",
        tabId: tab.id,
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
      isUserUploadActive = response.userUploadActive || (currentTrack?.source === 'user') || false;

      updateStatus(response);
      updateTrackSection();
    } catch {
      // Background script not available, try direct content script query
      try {
        const response = (await browser.tabs.sendMessage(tab.id, {
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
        isUserUploadActive = response.userUploadActive || (currentTrack?.source === 'user') || false;

        updateStatus(response);
        updateTrackSection();
      } catch {
        // Content script not loaded or doesn't support this
        updateStatus({ active: false, cueCount: 0, hasVideo: false });
        trackSection.classList.add("hidden");
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
    statusIndicator.className = "status-indicator status-warning";
    statusText.textContent = "No video detected";
    toggleBtn.disabled = true;
    statsSection.classList.add("hidden");
  } else if (status.active) {
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

function updateTrackSection(): void {
  const unloadBtn = document.getElementById("unloadBtn") as HTMLButtonElement;

  if (detectedTracks.length > 0 || currentTrack) {
    trackSection.classList.remove("hidden");

    if (currentTrack) {
      const label = currentTrack.isSDH
        ? `${currentTrack.label} ★`
        : currentTrack.label;
      currentTrackName.textContent = label;
    } else {
      currentTrackName.textContent = "None selected";
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
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab.id) return;

  try {
    await browser.tabs.sendMessage(tab.id, {
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
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab.id) return;

  const message = isActive ? { type: "disable" } : { type: "enable" };

  await browser.tabs.sendMessage(tab.id, message);
  isActive = !isActive;

  // Reload status
  await loadStatus();
}

async function handleUploadClick(): Promise<void> {
  // Send a message to the content script to show an upload overlay
  // directly on the video page. This avoids the Firefox bug where
  // popup panels close when the native file picker opens.
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab.id) return;

  try {
    await browser.runtime.sendMessage({
      type: "showUploadOverlay",
      tabId: tab.id,
    });
    // Close the popup since the overlay is now shown on the video page
    window.close();
  } catch (err) {
    error("Failed to show upload overlay:", err);
  }
}

async function handleUnload(): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const tabId = tab.id;
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