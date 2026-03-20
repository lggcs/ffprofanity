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
// Substitution elements
let useSubstitutionsCheckbox: HTMLInputElement;
let categoryGroup: HTMLDivElement;
let categorySelect: HTMLSelectElement;
let customSubstitutionsGroup: HTMLDivElement;
let customSubstitutionsTextarea: HTMLTextAreaElement;
let previewEl: HTMLDivElement;
let previewTextEl: HTMLDivElement;
// Display settings elements
let showUpcomingCuesCheckbox: HTMLInputElement;
let upcomingCuesCountSelect: HTMLSelectElement;
let fontSizeSelect: HTMLSelectElement;
let fontColorInput: HTMLInputElement;
let fontColorTextInput: HTMLInputElement;
let backgroundColorInput: HTMLInputElement;
let backgroundColorTextInput: HTMLInputElement;
let backgroundOpacitySlider: HTMLInputElement;
let opacityValue: HTMLSpanElement;
let positionSelect: HTMLSelectElement;
let displayPreviewContainer: HTMLDivElement;
let previewSubtitle: HTMLDivElement;
let previewUpcoming: HTMLDivElement;

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
  // Substitution elements
  useSubstitutionsCheckbox = document.getElementById('useSubstitutions') as HTMLInputElement;
  categoryGroup = document.getElementById('categoryGroup') as HTMLDivElement;
  categorySelect = document.getElementById('substitutionCategory') as HTMLSelectElement;
  customSubstitutionsGroup = document.getElementById('customSubstitutionsGroup') as HTMLDivElement;
  customSubstitutionsTextarea = document.getElementById('customSubstitutions') as HTMLTextAreaElement;
  previewEl = document.getElementById('substitutionPreview') as HTMLDivElement;
  previewTextEl = document.getElementById('previewText') as HTMLDivElement;

  // Display settings elements
  showUpcomingCuesCheckbox = document.getElementById('showUpcomingCues') as HTMLInputElement;
  upcomingCuesCountSelect = document.getElementById('upcomingCuesCount') as HTMLSelectElement;
  fontSizeSelect = document.getElementById('fontSize') as HTMLSelectElement;
  fontColorInput = document.getElementById('fontColor') as HTMLInputElement;
  fontColorTextInput = document.getElementById('fontColorText') as HTMLInputElement;
  backgroundColorInput = document.getElementById('backgroundColor') as HTMLInputElement;
  backgroundColorTextInput = document.getElementById('backgroundColorText') as HTMLInputElement;
  backgroundOpacitySlider = document.getElementById('backgroundOpacity') as HTMLInputElement;
  opacityValue = document.getElementById('opacityValue') as HTMLSpanElement;
  positionSelect = document.getElementById('position') as HTMLSelectElement;
  displayPreviewContainer = document.getElementById('previewContainer') as HTMLDivElement;
  previewSubtitle = document.getElementById('previewSubtitle') as HTMLDivElement;
  previewUpcoming = document.getElementById('previewUpcoming') as HTMLDivElement;

  // Load current settings
  await loadSettings();

  // Setup event handlers
  offsetSlider.addEventListener('input', handleOffsetChange);
  fileInput.addEventListener('change', handleFileUpload);
  saveWordlistBtn.addEventListener('click', handleSaveWordlist);
  document.getElementById('save')?.addEventListener('click', saveAllSettings);
  document.getElementById('reset')?.addEventListener('click', resetSettings);

  // Substitution event handlers
  useSubstitutionsCheckbox.addEventListener('change', handleSubstitutionToggle);
  categorySelect.addEventListener('change', handleCategoryChange);
  customSubstitutionsTextarea.addEventListener('input', handleCustomSubstitutionsChange);

  // Display settings event handlers
  showUpcomingCuesCheckbox.addEventListener('change', handleDisplaySettingsChange);
  upcomingCuesCountSelect.addEventListener('change', handleDisplaySettingsChange);
  fontSizeSelect.addEventListener('change', handleDisplaySettingsChange);
  fontColorInput.addEventListener('input', handleColorChange);
  fontColorTextInput.addEventListener('input', handleColorTextChange);
  backgroundColorInput.addEventListener('input', handleColorChange);
  backgroundColorTextInput.addEventListener('input', handleBackgroundColorTextChange);
  backgroundOpacitySlider.addEventListener('input', handleOpacityChange);
  positionSelect.addEventListener('change', handleDisplaySettingsChange);

  // Export/Import buttons
  document.getElementById('exportData')?.addEventListener('click', exportData);
  const importInput = document.getElementById('importData') as HTMLInputElement;
  if (importInput) {
    importInput.addEventListener('change', handleImport);
  }
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

  // Set substitution settings
  useSubstitutionsCheckbox.checked = settings.useSubstitutions || false;
  categorySelect.value = settings.substitutionCategory || 'silly';

  // Set custom substitutions
  if (settings.customSubstitutions) {
    const customLines = Object.entries(settings.customSubstitutions)
      .map(([word, replacement]) => `${word}=${replacement}`);
    customSubstitutionsTextarea.value = customLines.join('\n');
  }

  // Set display settings
  showUpcomingCuesCheckbox.checked = settings.showUpcomingCues ?? true;
  upcomingCuesCountSelect.value = String(settings.upcomingCuesCount ?? 2);
  fontSizeSelect.value = settings.fontSize || 'medium';
  fontColorInput.value = settings.fontColor || '#ffffff';
  fontColorTextInput.value = settings.fontColor || '#ffffff';
  backgroundColorInput.value = settings.backgroundColor || '#000000';
  backgroundColorTextInput.value = settings.backgroundColor || '#000000';
  backgroundOpacitySlider.value = String(settings.backgroundOpacity ?? 80);
  opacityValue.textContent = `${settings.backgroundOpacity ?? 80}%`;
  positionSelect.value = settings.position || 'bottom';

  // Update UI visibility
  updateSubstitutionUI();
  updatePreview();
  updateDisplayPreview();

  // Update upcoming count visibility
  const upcomingCountGroup = document.getElementById('upcomingCountGroup');
  if (upcomingCountGroup) {
    upcomingCountGroup.style.display = settings.showUpcomingCues ? 'block' : 'none';
  }

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

function handleSubstitutionToggle(): void {
  updateSubstitutionUI();
  updatePreview();
}

function handleCategoryChange(): void {
  updateSubstitutionUI();
  updatePreview();
}

function handleCustomSubstitutionsChange(): void {
  updatePreview();
}

function updateSubstitutionUI(): void {
  const enabled = useSubstitutionsCheckbox.checked;
  const category = categorySelect.value;
  
  categoryGroup.style.display = enabled ? 'block' : 'none';
  previewEl.style.display = enabled ? 'block' : 'none';
  customSubstitutionsGroup.style.display = enabled && category === 'custom' ? 'block' : 'none';
}

// Display settings handlers
function handleDisplaySettingsChange(): void {
  // Toggle visibility of upcoming count based on checkbox
  const upcomingCountGroup = document.getElementById('upcomingCountGroup');
  if (upcomingCountGroup) {
    upcomingCountGroup.style.display = showUpcomingCuesCheckbox.checked ? 'block' : 'none';
  }
  updateDisplayPreview();
}

function handleColorChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  // Sync the text input with the color picker
  if (input.id === 'fontColor') {
    fontColorTextInput.value = input.value;
  } else if (input.id === 'backgroundColor') {
    backgroundColorTextInput.value = input.value;
  }
  updateDisplayPreview();
}

function handleColorTextChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  // Validate hex color and sync color picker
  const hexPattern = /^#[0-9A-Fa-f]{6}$/;
  if (hexPattern.test(input.value)) {
    fontColorInput.value = input.value;
    updateDisplayPreview();
  }
}

function handleBackgroundColorTextChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  // Validate hex color and sync color picker
  const hexPattern = /^#[0-9A-Fa-f]{6}$/;
  if (hexPattern.test(input.value)) {
    backgroundColorInput.value = input.value;
    updateDisplayPreview();
  }
}

function handleOpacityChange(): void {
  const opacity = backgroundOpacitySlider.value;
  opacityValue.textContent = `${opacity}%`;
  updateDisplayPreview();
}

function updateDisplayPreview(): void {
  const fontSize = fontSizeSelect.value;
  const fontColor = fontColorInput.value;
  const bgColor = backgroundColorInput.value;
  const opacity = parseInt(backgroundOpacitySlider.value, 10) / 100;
  const showUpcoming = showUpcomingCuesCheckbox.checked;
  const position = positionSelect.value;

  // Font size mapping
  const fontSizes: Record<string, string> = {
    small: '16px',
    medium: '20px',
    large: '26px',
    xlarge: '32px',
  };

  // Apply styles to preview
  previewSubtitle.style.fontSize = fontSizes[fontSize] || '20px';
  previewSubtitle.style.color = fontColor;

  // Parse background color
  const bgR = parseInt(bgColor.slice(1, 3), 16);
  const bgG = parseInt(bgColor.slice(3, 5), 16);
  const bgB = parseInt(bgColor.slice(5, 7), 16);
  previewSubtitle.style.background = `rgba(${bgR}, ${bgG}, ${bgB}, ${opacity})`;

  // Show/hide upcoming cues
  previewUpcoming.style.display = showUpcoming ? 'block' : 'none';

  // Apply position (update container alignment)
  if (position === 'top') {
    displayPreviewContainer.style.justifyContent = 'flex-start';
    displayPreviewContainer.style.paddingTop = '10px';
    displayPreviewContainer.style.paddingBottom = '0';
  } else if (position === 'middle') {
    displayPreviewContainer.style.justifyContent = 'center';
    displayPreviewContainer.style.paddingTop = '0';
    displayPreviewContainer.style.paddingBottom = '0';
  } else {
    displayPreviewContainer.style.justifyContent = 'flex-end';
    displayPreviewContainer.style.paddingTop = '0';
    displayPreviewContainer.style.paddingBottom = '20px';
  }
}

function updatePreview(): void {
  if (!useSubstitutionsCheckbox.checked) {
    return;
  }

  const category = categorySelect.value;
  const customText = customSubstitutionsTextarea.value;

  // Preview examples based on category
  const examples: Record<string, Array<{original: string; censored: string}>> = {
    silly: [
      { original: 'fuck', censored: 'fudge' },
      { original: 'shit', censored: 'shenanigans' },
      { original: 'bitch', censored: 'biscuit' },
    ],
    polite: [
      { original: 'fuck', censored: 'darn' },
      { original: 'shit', censored: 'nonsense' },
      { original: 'bitch', censored: 'meanie' },
    ],
    random: [
      { original: 'fuck', censored: 'bananas' },
      { original: 'shit', censored: 'noodles' },
      { original: 'bitch', censored: 'potato' },
    ],
    custom: [],
  };

  // Parse custom substitutions for preview
  if (category === 'custom' && customText.trim()) {
    const lines = customText.split('\n').filter(l => l.includes('='));
    for (const line of lines) {
      const [word, replacement] = line.split('=').map(s => s.trim());
      if (word && replacement) {
        examples.custom.push({ original: word, censored: replacement });
      }
    }
  }

  const categoryExamples = examples[category] || examples.silly;
  if (categoryExamples.length === 0) {
    previewTextEl.innerHTML = `<em>No custom substitutions defined. Add some above!</em>`;
    return;
  }

  // Build preview HTML
  const previewWords = categoryExamples.slice(0, 3);
  const previewHtml = previewWords
    .map(e => `<b>${e.original}</b> → <b>${e.censored}</b>`)
    .join('<br>');
  
  previewTextEl.innerHTML = `
    <strong>Category: ${category.charAt(0).toUpperCase() + category.slice(1)}</strong><br>
    ${previewHtml}
  `;
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
  // Parse custom substitutions
  const customSubstitutions: Record<string, string> = {};
  if (useSubstitutionsCheckbox.checked && categorySelect.value === 'custom') {
    const lines = customSubstitutionsTextarea.value.split('\n').filter(l => l.includes('='));
    for (const line of lines) {
      const [word, replacement] = line.split('=').map(s => s.trim());
      if (word && replacement) {
        customSubstitutions[word.toLowerCase()] = replacement;
      }
    }
  }

  const settings: Partial<Settings> = {
    offsetMs: parseInt(offsetSlider.value, 10),
    sensitivity: sensitivitySelect.value as Settings['sensitivity'],
    useSubstitutions: useSubstitutionsCheckbox.checked,
    substitutionCategory: categorySelect.value as Settings['substitutionCategory'],
    customSubstitutions,
    // Display settings
    showUpcomingCues: showUpcomingCuesCheckbox.checked,
    upcomingCuesCount: parseInt(upcomingCuesCountSelect.value, 10),
    fontSize: fontSizeSelect.value as Settings['fontSize'],
    fontColor: fontColorInput.value,
    backgroundColor: backgroundColorInput.value,
    backgroundOpacity: parseInt(backgroundOpacitySlider.value, 10),
    position: positionSelect.value as Settings['position'],
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

// Handle import file selection
async function handleImport(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

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