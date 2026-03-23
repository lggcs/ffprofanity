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
    async setCues(cues) {
      await browser.storage.local.set({ cues_v1: cues });
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
    async setSettings(settings) {
      const current = await this.getSettings();
      await browser.storage.local.set({ settings: { ...current, ...settings } });
    }
    /**
     * Get setting with key
     */
    async getSetting(key) {
      const settings = await this.getSettings();
      return settings[key];
    }
    /**
     * Set single setting
     */
    async setSetting(key, value) {
      const settings = await this.getSettings();
      settings[key] = value;
      await browser.storage.local.set({ settings });
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
      const [cues, settings, presetsResult] = await Promise.all([
        this.getCues(),
        this.getSettings(),
        browser.storage.local.get("presets")
      ]);
      return {
        version: CURRENT_SCHEMA_VERSION,
        cues,
        settings,
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

  // src/options/index.ts
  var offsetSlider;
  var offsetValue;
  var sensitivitySelect;
  var fileInput;
  var wordlistTextarea;
  var saveWordlistBtn;
  var fileInfo;
  var statusEl;
  var cueCount = 0;
  async function init() {
    offsetSlider = document.getElementById("offsetSlider");
    offsetValue = document.getElementById("offsetValue");
    sensitivitySelect = document.getElementById("sensitivity");
    fileInput = document.getElementById("fileInput");
    wordlistTextarea = document.getElementById("wordlist");
    saveWordlistBtn = document.getElementById("saveWordlist");
    fileInfo = document.getElementById("fileInfo");
    statusEl = document.getElementById("status");
    await loadSettings();
    offsetSlider.addEventListener("input", handleOffsetChange);
    fileInput.addEventListener("change", handleFileUpload);
    saveWordlistBtn.addEventListener("click", handleSaveWordlist);
    document.getElementById("save")?.addEventListener("click", saveAllSettings);
    document.getElementById("reset")?.addEventListener("click", resetSettings);
  }
  async function loadSettings() {
    const settings = await storage.getSettings();
    offsetSlider.value = String(settings.offsetMs);
    offsetValue.textContent = `${settings.offsetMs}ms`;
    sensitivitySelect.value = settings.sensitivity;
    wordlistTextarea.value = settings.wordlist.join("\n");
    const cues = await storage.getCues();
    cueCount = cues.length;
    updateFileInfo();
  }
  function handleOffsetChange() {
    const offset = parseInt(offsetSlider.value, 10);
    offsetValue.textContent = `${offset}ms`;
  }
  async function handleFileUpload() {
    const file = fileInput.files?.[0];
    if (!file) return;
    showStatus("Processing subtitle file...", "info");
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const content = e.target?.result;
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (tab.id) {
          await browser.tabs.sendMessage(tab.id, {
            type: "uploadCues",
            content
          });
          showStatus(`File "${file.name}" processed successfully!`, "success");
          const cues = await storage.getCues();
          cueCount = cues.length;
          updateFileInfo();
        }
      } catch (error) {
        showStatus(`Error processing file: ${error}`, "error");
      }
    };
    reader.readAsText(file);
  }
  function updateFileInfo() {
    if (cueCount > 0) {
      fileInfo.textContent = `${cueCount} cues loaded`;
      fileInfo.style.color = "#4a3";
    } else {
      fileInfo.textContent = "No cues loaded";
      fileInfo.style.color = "#888";
    }
  }
  async function handleSaveWordlist() {
    const wordlist = wordlistTextarea.value.split("\n").map((w) => w.trim()).filter((w) => w.length > 0);
    await storage.setSetting("wordlist", wordlist);
    showStatus(`Wordlist saved: ${wordlist.length} words`, "success");
  }
  async function saveAllSettings() {
    const settings = {
      offsetMs: parseInt(offsetSlider.value, 10),
      sensitivity: settings.sensitivity
    };
    await storage.setSettings(settings);
    const tabs = await browser.tabs.query({});
    for (const tab of tabs) {
      if (tab.id) {
        browser.tabs.sendMessage(tab.id, {
          type: "updateSettings",
          settings
        }).catch(() => {
        });
      }
    }
    showStatus("Settings saved!", "success");
  }
  async function resetSettings() {
    await storage.clearAll();
    await loadSettings();
    showStatus("Settings reset to defaults", "info");
  }
  function showStatus(message, type) {
    statusEl.textContent = message;
    statusEl.className = `status status-${type}`;
    setTimeout(() => {
      statusEl.className = "status";
    }, 3e3);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
