/**
 * Popup UI
 * Quick controls for enable/disable and current status
 */

import '../styles/popup.css';
import type { Settings } from '../types';

// State
let isActive = false;
let currentCue: { text: string; censoredText: string; hasProfanity: boolean } | null = null;
let nextCues: { text: string; hasProfanity: boolean }[] = [];

// DOM Elements - initialized in init()
let statusEl: HTMLElement;
let cueEl: HTMLElement;
let nextEl: HTMLElement;

async function init(): Promise<void> {
  statusEl = document.getElementById('status') as HTMLElement;
  cueEl = document.getElementById('currentCue') as HTMLElement;
  nextEl = document.getElementById('nextCues') as HTMLElement;
  
  const toggleBtn = document.getElementById('toggle') as HTMLElement;
  const optionsBtn = document.getElementById('options') as HTMLElement;
  
  // Load current status
  await loadStatus();
  
  // Setup event handlers
  toggleBtn.addEventListener('click', handleToggle);
  optionsBtn.addEventListener('click', handleOptions);
}

async function loadStatus(): Promise<void> {
  try {
    // Get current tab
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab.id) return;
    
    // Try to get status from content script
    try {
      const response = await browser.tabs.sendMessage(tab.id, { type: 'getStatus' }) as {
        active: boolean;
        cueCount: number;
        hasVideo: boolean;
      };
      
      isActive = response.active;
      updateStatus(response);
    } catch {
      // Content script not loaded or doesn't support this
      updateStatus({ active: false, cueCount: 0, hasVideo: false });
    }
  } catch (error) {
    console.error('Failed to load status:', error);
  }
}

function updateStatus(status: { active: boolean; cueCount: number; hasVideo: boolean }): void {
  const statusIndicator = document.getElementById('statusIndicator') as HTMLElement;
  const statusText = document.getElementById('statusText') as HTMLElement;
  const toggleBtn = document.getElementById('toggle') as HTMLButtonElement;
  
  if (!status.hasVideo) {
    statusIndicator.className = 'status-indicator status-warning';
    statusText.textContent = 'No video detected';
    toggleBtn.disabled = true;
  } else if (status.active) {
    statusIndicator.className = 'status-indicator status-active';
    statusText.textContent = status.cueCount > 0 
      ? `Active - ${status.cueCount} cues loaded` 
      : 'Active - No cues loaded';
    toggleBtn.textContent = 'Disable';
    toggleBtn.disabled = false;
  } else {
    statusIndicator.className = 'status-indicator status-inactive';
    statusText.textContent = 'Disabled';
    toggleBtn.textContent = 'Enable';
    toggleBtn.disabled = false;
  }
}

async function handleToggle(): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab.id) return;
  
  const message = isActive ? { type: 'disable' } : { type: 'enable' };
  
  await browser.tabs.sendMessage(tab.id, message);
  isActive = !isActive;
  
  // Reload status
  await loadStatus();
}

async function handleOptions(): Promise<void> {
  await browser.runtime.openOptionsPage();
  window.close();
}

// Initialize on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}