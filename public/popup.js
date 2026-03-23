"use strict";
(() => {
  // src/popup/index.ts
  var isActive = false;
  var statusEl;
  var cueEl;
  var nextEl;
  async function init() {
    statusEl = document.getElementById("status");
    cueEl = document.getElementById("currentCue");
    nextEl = document.getElementById("nextCues");
    const toggleBtn = document.getElementById("toggle");
    const optionsBtn = document.getElementById("options");
    await loadStatus();
    toggleBtn.addEventListener("click", handleToggle);
    optionsBtn.addEventListener("click", handleOptions);
  }
  async function loadStatus() {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab.id) return;
      try {
        const response = await browser.tabs.sendMessage(tab.id, { type: "getStatus" });
        isActive = response.active;
        updateStatus(response);
      } catch {
        updateStatus({ active: false, cueCount: 0, hasVideo: false });
      }
    } catch (error) {
      console.error("Failed to load status:", error);
    }
  }
  function updateStatus(status) {
    const statusIndicator = document.getElementById("statusIndicator");
    const statusText = document.getElementById("statusText");
    const toggleBtn = document.getElementById("toggle");
    if (!status.hasVideo) {
      statusIndicator.className = "status-indicator status-warning";
      statusText.textContent = "No video detected";
      toggleBtn.disabled = true;
    } else if (status.active) {
      statusIndicator.className = "status-indicator status-active";
      statusText.textContent = status.cueCount > 0 ? `Active - ${status.cueCount} cues loaded` : "Active - No cues loaded";
      toggleBtn.textContent = "Disable";
      toggleBtn.disabled = false;
    } else {
      statusIndicator.className = "status-indicator status-inactive";
      statusText.textContent = "Disabled";
      toggleBtn.textContent = "Enable";
      toggleBtn.disabled = false;
    }
  }
  async function handleToggle() {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab.id) return;
    const message = isActive ? { type: "disable" } : { type: "enable" };
    await browser.tabs.sendMessage(tab.id, message);
    isActive = !isActive;
    await loadStatus();
  }
  async function handleOptions() {
    await browser.runtime.openOptionsPage();
    window.close();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
