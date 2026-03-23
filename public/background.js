// src/background/index.ts
var muteStates = /* @__PURE__ */ new Map();
var cuesCache = /* @__PURE__ */ new Map();
async function muteTab(tabId, reasonId, expectedUnmuteAt) {
  const state = muteStates.get(tabId);
  if (state?.safetyTimer) {
    clearTimeout(state.safetyTimer);
  }
  muteStates.set(tabId, {
    muted: true,
    reasonId,
    expectedUnmuteAt,
    safetyTimer: null
  });
  try {
    await browser.tabs.update(tabId, { muted: true });
    console.log(`Tab ${tabId} muted for reason ${reasonId}`);
  } catch (error) {
    console.error(`Failed to mute tab ${tabId}:`, error);
  }
  const safetyDelay = expectedUnmuteAt - Date.now() + 1e3;
  if (safetyDelay > 0 && safetyDelay < 6e4) {
    const timer = setTimeout(async () => {
      const currentState2 = muteStates.get(tabId);
      if (currentState2?.muted && currentState2.reasonId === reasonId) {
        console.log(`Safety timer triggered, unmuting tab ${tabId}`);
        await unmuteTab(tabId, "safety-timer");
      }
    }, safetyDelay);
    const currentState = muteStates.get(tabId);
    if (currentState) {
      currentState.safetyTimer = timer;
    }
  }
}
async function unmuteTab(tabId, reasonId) {
  const state = muteStates.get(tabId);
  if (state?.safetyTimer) {
    clearTimeout(state.safetyTimer);
  }
  if (state?.muted) {
    try {
      await browser.tabs.update(tabId, { muted: false });
      console.log(`Tab ${tabId} unmuted`);
    } catch (error) {
      console.error(`Failed to unmute tab ${tabId}:`, error);
    }
  }
  muteStates.set(tabId, {
    muted: false,
    reasonId: null,
    expectedUnmuteAt: null,
    safetyTimer: null
  });
}
browser.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message !== "object") return;
  const msg = message;
  const tabId = sender.tab?.id;
  if (!tabId) return;
  console.log(`Received message from tab ${tabId}:`, msg.type);
  switch (msg.type) {
    case "muteNow": {
      const muteMsg = message;
      muteTab(tabId, muteMsg.reasonId, muteMsg.expectedUnmuteAt);
      break;
    }
    case "unmuteNow": {
      unmuteTab(tabId, "unmute-request");
      break;
    }
    case "getStatus": {
      const state = muteStates.get(tabId);
      return Promise.resolve({
        type: "status",
        muted: state?.muted ?? false,
        tabId
      });
    }
  }
});
browser.tabs.onRemoved.addListener((tabId) => {
  muteStates.delete(tabId);
  cuesCache.delete(tabId);
});
browser.runtime.onInstalled.addListener((details) => {
  console.log("Profanity Filter installed:", details.reason);
});
