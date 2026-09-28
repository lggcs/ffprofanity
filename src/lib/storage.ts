/**
 * Storage Layer
 * Manages persistent storage for cues, settings, and presets
 */

import type { Cue, Settings, StorageSchema, SubtitleTrack } from '../types';
import type { DriftAnchor, DriftModel } from './drift';
import { warn } from './logger';

const CURRENT_SCHEMA_VERSION = 1;

/** Max drift-correction records kept in storage (LRU) */
const DRIFT_MAX_RECORDS = 50;

const DEFAULT_SETTINGS: Settings = {
  enabled: true,  // Extension starts enabled by default
  offsetMs: 0,
  sensitivity: 'medium',
  fuzzyThreshold: 0.25,
  wordlist: [],
  enabledSites: [],
  optInTFJS: false,
  optInAutoFetch: false,
  preferredLanguage: 'en',
  preferSDH: true,
  autoSelectTrack: true,
  autoDriftCorrection: true,
  // Substitution settings - default to funny monkey emojis
  useSubstitutions: true,
  substitutionCategory: 'monkeys',
  customSubstitutions: {},
  // Subtitle display settings
  showUpcomingCues: false,
  showProfanityOnly: false,
  upcomingCuesCount: 2,
  fontSize: 'medium',
  fontColor: '#ffffff',
  backgroundColor: '#000000',
  position: 'bottom',
  backgroundOpacity: 80,
};

type StorageKey = 'cues_v1' | 'settings' | 'presets' | 'detectedTracks' | 'currentTrack' | 'userUploadActive' | 'userUploadTrack';

export class StorageManager {
  /**
   * Get all cues from storage
   */
  async getCues(): Promise<Cue[]> {
    const result = await browser.storage.local.get('cues_v1');
    return result.cues_v1 || [];
  }

  /**
   * Save cues to storage
   */
  async setCues(cues: Cue[]): Promise<void> {
    await browser.storage.local.set({ cues_v1: cues });
  }

  /**
   * Clear all cues
   */
  async clearCues(): Promise<void> {
    await browser.storage.local.remove('cues_v1');
  }

  /**
   * Get detected tracks from storage
   */
  async getDetectedTracks(): Promise<SubtitleTrack[]> {
    const result = await browser.storage.local.get('detectedTracks');
    return result.detectedTracks || [];
  }

  /**
   * Save detected tracks to storage
   */
  async setDetectedTracks(tracks: SubtitleTrack[]): Promise<void> {
    await browser.storage.local.set({ detectedTracks: tracks });
  }

  /**
   * Get current track from storage
   */
  async getCurrentTrack(): Promise<SubtitleTrack | null> {
    const result = await browser.storage.local.get('currentTrack');
    return result.currentTrack || null;
  }

  /**
   * Save current track to storage
   */
  async setCurrentTrack(track: SubtitleTrack | null): Promise<void> {
    await browser.storage.local.set({ currentTrack: track });
  }

  /**
   * Get settings from storage
   */
  async getSettings(): Promise<Settings> {
    const result = await browser.storage.local.get('settings');
    return { ...DEFAULT_SETTINGS, ...(result.settings || {}) };
  }

  /**
   * Save settings to storage
   */
  async setSettings(settings: Partial<Settings>): Promise<void> {
    const current = await this.getSettings();
    await browser.storage.local.set({ settings: { ...current, ...settings } });
  }

  /**
   * Get setting with key
   */
  async getSetting<K extends keyof Settings>(key: K): Promise<Settings[K]> {
    const settings = await this.getSettings();
    return settings[key];
  }

  /**
   * Set single setting
   */
  async setSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
    const settings = await this.getSettings();
    settings[key] = value;
    await browser.storage.local.set({ settings });
  }

  /**
   * Get site-specific preset
   */
  async getPreset(site: string): Promise<Partial<Settings> | null> {
    const result = await browser.storage.local.get('presets');
    const presets = result.presets || {};
    return presets[site] || null;
  }

  /**
   * Save site-specific preset
   */
  async setPreset(site: string, preset: Partial<Settings>): Promise<void> {
    const result = await browser.storage.local.get('presets');
    const presets = result.presets || {};
    presets[site] = preset;
    await browser.storage.local.set({ presets });
  }

  // ==================== Drift correction storage ====================

  /**
   * Load the drift-correction record for a movie key, plus all records for GC.
   */
  async getDriftRecord(
    key: string,
  ): Promise<{ anchors?: DriftAnchor[]; model?: DriftModel | null; updatedAt?: number } | null> {
    try {
      const result = await browser.storage.local.get('driftCorrections');
      const store = (result.driftCorrections || {}) as Record<
        string,
        { anchors?: DriftAnchor[]; model?: DriftModel | null; updatedAt?: number }
      >;
      return store[key] ?? null;
    } catch (err) {
      warn('getDriftRecord failed:', err);
      return null;
    }
  }

  /**
   * Save the drift-correction record for a movie key and prune stale entries.
   */
  async setDriftRecord(
    key: string,
    record: { anchors: DriftAnchor[]; model: DriftModel | null },
  ): Promise<void> {
    try {
      const result = await browser.storage.local.get('driftCorrections');
      const raw = (result.driftCorrections || {}) as unknown;
      // Guard against corrupt/non-object storage shapes — start fresh
      type DriftStoreEntry = { anchors?: DriftAnchor[]; model?: DriftModel | null; updatedAt?: number };
      const store: Record<string, DriftStoreEntry> =
        raw && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as Record<string, DriftStoreEntry>)
          : {};
      store[key] = { ...record, updatedAt: Date.now() };

      // Prune: keep the 50 most recently updated records
      const entries = Object.entries(store)
        .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
        .slice(0, DRIFT_MAX_RECORDS);
      await browser.storage.local.set({
        driftCorrections: Object.fromEntries(entries),
      });
    } catch (err) {
      warn('setDriftRecord failed:', err);
    }
  }

  /**
   * Remove a single drift record.
   */
  async removeDriftRecord(key: string): Promise<void> {
    try {
      const result = await browser.storage.local.get('driftCorrections');
      const store = (result.driftCorrections || {}) as Record<string, unknown>;
      delete store[key];
      await browser.storage.local.set({ driftCorrections: store });
    } catch (err) {
      warn('removeDriftRecord failed:', err);
    }
  }

  /**
   * Remove all drift records.
   */
  async clearAllDriftRecords(): Promise<void> {
    await browser.storage.local.remove('driftCorrections').catch((err) =>
      warn('clearAllDriftRecords failed:', err),
    );
  }

  /**
   * Clear all storage data
   */
  async clearAll(): Promise<void> {
    await browser.storage.local.clear();
  }

  /**
   * Export all data for backup
   */
  async exportData(): Promise<StorageSchema> {
    const [cues, settings, presetsResult, detectedTracks, currentTrack] = await Promise.all([
      this.getCues(),
      this.getSettings(),
      browser.storage.local.get('presets'),
      this.getDetectedTracks(),
      this.getCurrentTrack(),
    ]);

    return {
      version: CURRENT_SCHEMA_VERSION,
      cues,
      settings,
      presets: presetsResult.presets || {},
      detectedTracks,
      currentTrack,
    };
  }

  /**
   * Import data from backup
   */
  async importData(data: StorageSchema): Promise<void> {
    if (data.version !== CURRENT_SCHEMA_VERSION) {
      warn('Storage schema version mismatch, data may need migration');
    }

    await Promise.all([
      this.setCues(data.cues || []),
      this.setSettings(data.settings || {}),
      browser.storage.local.set({ presets: data.presets || {} }),
      this.setDetectedTracks(data.detectedTracks || []),
      this.setCurrentTrack(data.currentTrack || null),
    ]);
  }

  /**
   * Check if a user-uploaded subtitle file is active in this tab
   * Used to restore state after content script reinjection
   */
  async getUserUploadActive(tabId?: number): Promise<boolean> {
    const key = tabId ? `userUploadActive_${tabId}` : 'userUploadActive';
    const result = await browser.storage.local.get(key);
    return result[key] || false;
  }

  /**
   * Set the user upload active flag
   */
  async setUserUploadActive(active: boolean, tabId?: number): Promise<void> {
    const key = tabId ? `userUploadActive_${tabId}` : 'userUploadActive';
    if (active) {
      await browser.storage.local.set({ [key]: true });
    } else {
      await browser.storage.local.remove(key);
    }
  }

  /**
   * Get the user upload track metadata (for restore after reinjection)
   */
  async getUserUploadTrack(tabId?: number): Promise<SubtitleTrack | null> {
    const key = tabId ? `userUploadTrack_${tabId}` : 'userUploadTrack';
    const result = await browser.storage.local.get(key);
    return result[key] || null;
  }

  /**
   * Save the user upload track metadata
   */
  async setUserUploadTrack(track: SubtitleTrack | null, tabId?: number): Promise<void> {
    const key = tabId ? `userUploadTrack_${tabId}` : 'userUploadTrack';
    if (track) {
      await browser.storage.local.set({ [key]: track });
    } else {
      await browser.storage.local.remove(key);
    }
  }

  /**
   * Clear all user upload state (on unload)
   */
  async clearUserUploadState(tabId?: number): Promise<void> {
    const keys = tabId
      ? [`userUploadActive_${tabId}`, `userUploadTrack_${tabId}`, 'cues_v1']
      : ['userUploadActive', 'userUploadTrack', 'cues_v1'];
    await browser.storage.local.remove(keys);
  }
}

// Singleton instance
export const storage = new StorageManager();