/**
 * Base Site Extractor Interface
 * All site-specific subtitle extractors implement this interface
 */

import type { SubtitleTrack } from '../types';

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
   * Extract language code from various formats
   */
  protected extractLanguage(url: string, data?: Record<string, unknown>): string {
    // Check URL patterns
    const urlPatterns = [
      /[?&]lang=([a-z]{2,3})/i,
      /\/([a-z]{2,3})\/[^/]+\.vtt$/i,
      /\/([a-z]{2,3})_[a-f0-9]+\.vtt$/i,
      /[_\-\.]([a-z]{2,3})\.vtt$/i,
      /[_\-\.]([a-z]{2,3})\.srt$/i,
    ];

    for (const pattern of urlPatterns) {
      const match = url.match(pattern);
      if (match) return match[1].toLowerCase();
    }

    // Check data object
    if (data) {
      const langKeys = ['language', 'lang', 'code', 'lc'];
      for (const key of langKeys) {
        if (typeof data[key] === 'string') {
          return (data[key] as string).toLowerCase().slice(0, 3);
        }
      }
    }

    return 'unknown';
  }

  /**
   * Convert language code to display name
   */
  protected getLanguageName(code: string): string {
    const names: Record<string, string> = {
      en: 'English',
      es: 'Spanish',
      fr: 'French',
      de: 'German',
      it: 'Italian',
      pt: 'Portuguese',
      ru: 'Russian',
      ja: 'Japanese',
      ko: 'Korean',
      zh: 'Chinese',
      ar: 'Arabic',
      hi: 'Hindi',
      nl: 'Dutch',
      pl: 'Polish',
      sv: 'Swedish',
      da: 'Danish',
      fi: 'Finnish',
      no: 'Norwegian',
      tr: 'Turkish',
    };
    return names[code.toLowerCase()] || code.toUpperCase();
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