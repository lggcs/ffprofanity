/**
 * Storage Layer
 * Manages persistent storage for cues, settings, and presets
 */

import type { Cue, Settings, StorageSchema, SubtitleTrack } from '../types';

const CURRENT_SCHEMA_VERSION = 1;

const DEFAULT_SETTINGS: Settings = {
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
};

type StorageKey = 'cues_v1' | 'settings' | 'presets' | 'detectedTracks' | 'currentTrack';

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
      console.warn('Storage schema version mismatch, data may need migration');
    }

    await Promise.all([
      this.setCues(data.cues || []),
      this.setSettings(data.settings || {}),
      browser.storage.local.set({ presets: data.presets || {} }),
      this.setDetectedTracks(data.detectedTracks || []),
      this.setCurrentTrack(data.currentTrack || null),
    ]);
  }
}

// Singleton instance
export const storage = new StorageManager();