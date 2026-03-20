/**
 * Popup UI
 * Quick controls for enable/disable and current status
 */

import '../styles/popup.css';
import type { Settings, SubtitleTrack } from '../types';

// State
let isActive = false;
let currentTrack: SubtitleTrack | null = null;
let detectedTracks: SubtitleTrack[] = [];

// DOM Elements - initialized in init()
let statusEl: HTMLElement;
let trackSection: HTMLElement;
let currentTrackName: HTMLElement;
let trackList: HTMLElement;
let trackOptions: HTMLElement;

async function init(): Promise<void> {
  statusEl = document.getElementById('status') as HTMLElement;
  trackSection = document.getElementById('trackSection') as HTMLElement;
  currentTrackName = document.getElementById('currentTrackName') as HTMLElement;
  trackList = document.getElementById('trackList') as HTMLElement;
  trackOptions = document.getElementById('trackOptions') as HTMLElement;

  const toggleBtn = document.getElementById('toggle') as HTMLElement;
  const optionsBtn = document.getElementById('options') as HTMLElement;
  const changeTrackBtn = document.getElementById('changeTrackBtn') as HTMLElement;
  const subtitleFileInput = document.getElementById('subtitleFile') as HTMLInputElement;

  // Load current status
  await loadStatus();

  // Setup event handlers
  toggleBtn.addEventListener('click', handleToggle);
  optionsBtn.addEventListener('click', handleOptions);
  changeTrackBtn.addEventListener('click', toggleTrackList);
  subtitleFileInput.addEventListener('change', handleFileUpload);
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
        currentTrack: SubtitleTrack | null;
        detectedTracks: SubtitleTrack[];
      };

      isActive = response.active;
      currentTrack = response.currentTrack || null;
      detectedTracks = response.detectedTracks || [];
      
      updateStatus(response);
      updateTrackSection();
    } catch {
      // Content script not loaded or doesn't support this
      updateStatus({ active: false, cueCount: 0, hasVideo: false });
      trackSection.classList.add('hidden');
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

function updateTrackSection(): void {
  if (detectedTracks.length > 0 || currentTrack) {
    trackSection.classList.remove('hidden');
    
    if (currentTrack) {
      const label = currentTrack.isSDH ? `${currentTrack.label} ★` : currentTrack.label;
      currentTrackName.textContent = label;
    } else {
      currentTrackName.textContent = 'None selected';
    }
  } else {
    trackSection.classList.add('hidden');
  }
}

function toggleTrackList(): void {
  trackList.classList.toggle('hidden');
  
  if (!trackList.classList.contains('hidden')) {
    renderTrackOptions();
  }
}

function renderTrackOptions(): void {
  trackOptions.innerHTML = '';
  
  for (const track of detectedTracks) {
    const item = document.createElement('div');
    item.className = 'track-item';
    if (track.isSDH) {
      item.classList.add('sdh');
    }
    if (currentTrack?.id === track.id) {
      item.classList.add('selected');
    }
    
    const label = track.isSDH ? `${track.label} ★` : track.label;
    const source = track.source === 'user' ? '(uploaded)' : track.source === 'network' ? '(detected)' : '';
    
    item.textContent = `${label} ${source}`;
    item.addEventListener('click', () => handleSelectTrack(track));
    
    trackOptions.appendChild(item);
  }
  
  // Add upload option
  if (detectedTracks.length === 0) {
    const noTracks = document.createElement('div');
    noTracks.className = 'track-item';
    noTracks.textContent = 'No tracks detected on this page';
    noTracks.style.fontStyle = 'italic';
    noTracks.style.color = '#888';
    trackOptions.appendChild(noTracks);
  }
}

async function handleSelectTrack(track: SubtitleTrack): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab.id) return;

  try {
    await browser.tabs.sendMessage(tab.id, { type: 'selectTrack', trackId: track.id });
    currentTrack = track;
    updateTrackSection();
    trackList.classList.add('hidden');
  } catch (error) {
    console.error('Failed to select track:', error);
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

async function handleFileUpload(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const tabId = tab.id;
  if (!tabId) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    const content = e.target?.result as string;
    try {
      await browser.tabs.sendMessage(tabId, {
        type: 'uploadCues',
        content,
        filename: file.name
      });
      trackList.classList.add('hidden');
      await loadStatus();
    } catch (error) {
      console.error('Failed to upload cues:', error);
    }
  };
  reader.readAsText(file);
}

// Initialize on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}