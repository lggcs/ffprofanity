/**
 * Base Site Extractor Interface
 * All site-specific subtitle extractors implement this interface
 */

import type { SubtitleTrack } from '../types';
import { extractLanguageFromUrl, getLanguageName } from '../lib/language';

export interface DetectedSubtitle {
  url: string;
  language?: string;
  label?: string;
  source: string;
}

export interface SiteExtractor {
  /**
   * Unique name for this extractor
   */
  name: string;

  /**
   * URLs this extractor matches
   */
  patterns: RegExp[];

  /**
   * Check if this extractor should run on the current page
   */
  matches(url: string): boolean;

  /**
   * Called when the page loads to set up any watchers
   */
  setup?(): void;

  /**
   * Extract subtitles from network response
   */
  extractFromResponse?(url: string, responseText: string): DetectedSubtitle[];

  /**
   * Extract subtitles from page state (e.g., window objects)
   */
  extractFromPageState?(): DetectedSubtitle[];

  /**
   * Watch for dynamic subtitle loading (returns cleanup function)
   */
  watchForChanges?(callback: (subs: DetectedSubtitle[]) => void): () => void;

  /**
   * Get injected script to run in page context
   */
  getInjectedScript?(): string;
}

/**
 * Base extractor with common utilities
 */
export abstract class BaseExtractor implements SiteExtractor {
  abstract name: string;
  abstract patterns: RegExp[];

  matches(url: string): boolean {
    try {
      const hostname = new URL(url).hostname;
      return this.patterns.some(p => p.test(hostname) || p.test(url));
    } catch {
      return false;
    }
  }

  /**
   * Extract language code from URL or data object
   * Delegates to shared language utilities
   */
  protected extractLanguage(url: string, data?: Record<string, unknown>): string {
    return extractLanguageFromUrl(url, data);
  }

  /**
   * Convert language code to display name
   * Delegates to shared language utilities
   */
  protected getLanguageName(code: string): string {
    return getLanguageName(code);
  }

  /**
   * Recursively find subtitle URLs in any object
   */
  protected findSubtitlesRecursive(obj: unknown, source: string): DetectedSubtitle[] {
    const subs: DetectedSubtitle[] = [];
    if (!obj || typeof obj !== 'object') return subs;

    const objRecord = obj as Record<string, unknown>;

    // Check if this object looks like a subtitle entry
    const url = objRecord.file || objRecord.url || objRecord.src || objRecord.downloadLink;
    if (typeof url === 'string' && /\.(vtt|srt|ass|ssa)/i.test(url)) {
      subs.push({
        url: url,
        language: this.extractLanguage(url, objRecord as Record<string, unknown>),
        label: (objRecord.label || objRecord.name || this.getLanguageName(this.extractLanguage(url))) as string,
        source,
      });
    }

    // Recursively search arrays
    if (Array.isArray(obj)) {
      for (const item of obj) {
        subs.push(...this.findSubtitlesRecursive(item, source));
      }
    } else {
      // Search object properties
      const priorityKeys = ['subtitles', 'subs', 'captions', 'cc', 'text_tracks', 'tracks'];
      for (const key of priorityKeys) {
        if (objRecord[key]) {
          subs.push(...this.findSubtitlesRecursive(objRecord[key], source));
        }
      }
    }

    return subs;
  }
}

/**
 * Convert DetectedSubtitle to SubtitleTrack
 */
export function detectedToTrack(sub: DetectedSubtitle): SubtitleTrack {
  return {
    id: `detected-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    url: sub.url,
    label: sub.label || sub.language || 'Detected',
    language: sub.language || '',
    isSDH: false,
    isDefault: false,
    embedded: false,
    source: sub.source as 'video' | 'network' | 'user',
    recommendScore: 5,
  };
}