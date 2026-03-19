/**
 * Options Page
 * WebExtension options page for subtitle upload, settings, and wordlist management
 */

import '../styles/options.css';
import { storage } from '../lib/storage';
import type { Settings } from '../types';

// DOM Elements - will be initialized in init()
let offsetSlider: HTMLInputElement;
let offsetValue: HTMLSpanElement;
let sensitivitySelect: HTMLSelectElement;
let fileInput: HTMLInputElement;
let wordlistTextarea: HTMLTextAreaElement;
let saveWordlistBtn: HTMLButtonElement;
let fileInfo: HTMLDivElement;
let statusEl: HTMLDivElement;

// Current cues
let cueCount = 0;

async function init(): Promise<void> {
  // Get DOM elements
  offsetSlider = document.getElementById('offsetSlider') as HTMLInputElement;
  offsetValue = document.getElementById('offsetValue') as HTMLSpanElement;
  sensitivitySelect = document.getElementById('sensitivity') as HTMLSelectElement;
  fileInput = document.getElementById('fileInput') as HTMLInputElement;
  wordlistTextarea = document.getElementById('wordlist') as HTMLTextAreaElement;
  saveWordlistBtn = document.getElementById('saveWordlist') as HTMLButtonElement;
  fileInfo = document.getElementById('fileInfo') as HTMLDivElement;
  statusEl = document.getElementById('status') as HTMLDivElement;
  
  // Load current settings
  await loadSettings();
  
  // Setup event handlers
  offsetSlider.addEventListener('input', handleOffsetChange);
  fileInput.addEventListener('change', handleFileUpload);
  saveWordlistBtn.addEventListener('click', handleSaveWordlist);
  document.getElementById('save')?.addEventListener('click', saveAllSettings);
  document.getElementById('reset')?.addEventListener('click', resetSettings);
}

async function loadSettings(): Promise<void> {
  const settings = await storage.getSettings();
  
  // Set offset slider
  offsetSlider.value = String(settings.offsetMs);
  offsetValue.textContent = `${settings.offsetMs}ms`;
  
  // Set sensitivity
  sensitivitySelect.value = settings.sensitivity;
  
  // Set wordlist
  wordlistTextarea.value = settings.wordlist.join('\n');
  
  // Get cue count
  const cues = await storage.getCues();
  cueCount = cues.length;
  
  // Update file info
  updateFileInfo();
}

function handleOffsetChange(): void {
  const offset = parseInt(offsetSlider.value, 10);
  offsetValue.textContent = `${offset}ms`;
}

async function handleFileUpload(): Promise<void> {
  const file = fileInput.files?.[0];
  if (!file) return;
  
  showStatus('Processing subtitle file...', 'info');
  
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const content = e.target?.result as string;
      
      // Send to content script
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab.id) {
        await browser.tabs.sendMessage(tab.id, {
          type: 'uploadCues',
          content,
        });
        
        showStatus(`File "${file.name}" processed successfully!`, 'success');
        const cues = await storage.getCues();
        cueCount = cues.length;
        updateFileInfo();
      }
    } catch (error) {
      showStatus(`Error processing file: ${error}`, 'error');
    }
  };
  
  reader.readAsText(file);
}

function updateFileInfo(): void {
  if (cueCount > 0) {
    fileInfo.textContent = `${cueCount} cues loaded`;
    fileInfo.style.color = '#4a3';
  } else {
    fileInfo.textContent = 'No cues loaded';
    fileInfo.style.color = '#888';
  }
}

async function handleSaveWordlist(): Promise<void> {
  const wordlist = wordlistTextarea.value
    .split('\n')
    .map(w => w.trim())
    .filter(w => w.length > 0);
  
  await storage.setSetting('wordlist', wordlist);
  showStatus(`Wordlist saved: ${wordlist.length} words`, 'success');
}

async function saveAllSettings(): Promise<void> {
  const settings: Partial<Settings> = {
    offsetMs: parseInt(offsetSlider.value, 10),
    sensitivity: settings.sensitivity as Settings['sensitivity'],
  };
  
  await storage.setSettings(settings);
  
  // Broadcast settings update
  const tabs = await browser.tabs.query({});
  for (const tab of tabs) {
    if (tab.id) {
      browser.tabs.sendMessage(tab.id, {
        type: 'updateSettings',
        settings,
      }).catch(() => {}); // Ignore errors for inactive tabs
    }
  }
  
  showStatus('Settings saved!', 'success');
}

async function resetSettings(): Promise<void> {
  await storage.clearAll();
  await loadSettings();
  showStatus('Settings reset to defaults', 'info');
}

function showStatus(message: string, type: 'success' | 'error' | 'info'): void {
  statusEl.textContent = message;
  statusEl.className = `status status-${type}`;
  
  setTimeout(() => {
    statusEl.className = 'status';
  }, 3000);
}

// Export configuration data
async function exportData(): Promise<void> {
  const data = await storage.exportData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ffprofanity-backup.json';
  a.click();
  
  URL.revokeObjectURL(url);
}

// Import configuration data
async function importData(file: File): Promise<void> {
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const data = JSON.parse(e.target?.result as string);
      await storage.importData(data);
      await loadSettings();
      showStatus('Configuration imported successfully!', 'success');
    } catch (error) {
      showStatus('Failed to import configuration', 'error');
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