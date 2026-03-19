/**
 * Subtitle Extractor
 * Detects and extracts subtitle tracks from video elements and network requests
 */

import type { SubtitleTrack, NetworkSubtitle } from '../types';
import { createTrackFromElement, createTrackFromNetwork } from './tracks';

// File extensions that indicate subtitle files
const SUBTITLE_EXTENSIONS = ['.vtt', '.srt', '.ass', '.ssa', '.sub'];
const SUBTITLE_MIME_TYPES = ['text/vtt', 'text/srt', 'application/x-subrip', 'text/x-ssa', 'text/x-ass'];

// URL patterns for known streaming sites
const STREAMING_PATTERNS = [
  // Generic patterns
  /\/subtitles?\//i,
  /\/subs?\//i,
  /\/caption/i,
  /\/cc\//i,
  /\.vtt$/i,
  /\.srt$/i,
  /\.ass$/i,
  /\.ssa$/i,
  
  // Streaming site specific
  /manifest=.*\.vtt/i,
  /subtitle.*\.m3u8/i,
];

/**
 * Check if a URL looks like a subtitle file
 */
export function isSubtitleUrl(url: string): boolean {
  try {
    const urlObj = new URL(url);
    const path = urlObj.pathname.toLowerCase();
    
    // Check extension
    if (SUBTITLE_EXTENSIONS.some(ext => path.endsWith(ext))) {
      return true;
    }
    
    // Check for subtitle query parameters
    const query = urlObj.searchParams;
    if (query.has('subtitle') || query.has('subs') || query.has('captions')) {
      return true;
    }
    
    // Check against known patterns
    if (STREAMING_PATTERNS.some(pattern => pattern.test(url))) {
      return true;
    }
    
    return false;
  } catch {
    return false;
  }
}

/**
 * Determine subtitle format from URL or content type
 */
export function detectSubtitleFormat(
  url: string,
  contentType?: string
): 'srt' | 'vtt' | 'ass' | 'unknown' {
  // Check content type first
  if (contentType) {
    if (contentType.includes('vtt') || contentType.includes('webvtt')) return 'vtt';
    if (contentType.includes('subrip') || contentType.includes('srt')) return 'srt';
    if (contentType.includes('ssa') || contentType.includes('ass')) return 'ass';
  }
  
  // Check URL extension
  const path = url.toLowerCase();
  if (path.includes('.vtt')) return 'vtt';
  if (path.includes('.ass') || path.includes('.ssa')) return 'ass';
  if (path.includes('.srt')) return 'srt';
  
  return 'unknown';
}

/**
 * Extract subtitle tracks from a video element
 */
export function extractTracksFromVideo(video: HTMLVideoElement): SubtitleTrack[] {
  const tracks: SubtitleTrack[] = [];
  
  // Get all <track> children
  const trackElements = video.querySelectorAll('track[kind="subtitles"], track[kind="captions"]');
  
  for (const element of trackElements) {
    const track = createTrackFromElement(element);
    tracks.push(track);
  }
  
  return tracks;
}

/**
 * Scan page for all video elements and extract their tracks
 */
export function scanPageForTracks(): SubtitleTrack[] {
  const allTracks: SubtitleTrack[] = [];
  const videos = document.querySelectorAll('video');

  for (const video of videos) {
    const tracks = extractTracksFromVideo(video);
    allTracks.push(...tracks);
  }

  return allTracks;
}

/**
 * Track URL detector for network interception
 * Stores detected subtitle URLs from network traffic
 */
class SubtitleUrlDetector {
  private detectedUrls: Map<string, NetworkSubtitle> = new Map();
  private maxAge = 5 * 60 * 1000; // 5 minutes
  
  /**
   * Add a detected subtitle URL
   */
  addUrl(url: string, contentType?: string): void {
    if (!isSubtitleUrl(url)) return;
    
    const format = detectSubtitleFormat(url, contentType);
    
    // Extract language from URL if possible
    const langMatch = url.match(/[_\-\/]([a-z]{2,3})(?:[_\-\.]|$)/i);
    const language = langMatch ? langMatch[1].toLowerCase() : undefined;
    
    // Extract label from URL
    const labelMatch = url.match(/\/([^\/]+)\.(?:vtt|srt|ass|ssa)$/i);
    const label = labelMatch ? labelMatch[1].replace(/[_\-\+]/g, ' ') : undefined;
    
    this.detectedUrls.set(url, {
      url,
      format,
      language,
      label,
      timestamp: Date.now(),
    });
    
    // Clean up old entries
    this.cleanup();
  }
  
  /**
   * Get all detected URLs
   */
  getUrls(): NetworkSubtitle[] {
    this.cleanup();
    return Array.from(this.detectedUrls.values());
  }
  
  /**
   * Remove entries older than maxAge
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [url, data] of this.detectedUrls) {
      if (now - data.timestamp > this.maxAge) {
        this.detectedUrls.delete(url);
      }
    }
  }
  
  /**
   * Clear all detected URLs
   */
  clear(): void {
    this.detectedUrls.clear();
  }
}

// Global instance for content script
export const subtitleDetector = new SubtitleUrlDetector();

/**
 * Parse M3U8 playlist for embedded subtitle tracks
 */
export function parseM3U8Subtitles(content: string, baseUrl: string): SubtitleTrack[] {
  const tracks: SubtitleTrack[] = [];
  const lines = content.split('\n');
  
  let currentInfo: { type?: string; language?: string; label?: string; url?: string } = {};
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Parse EXT-X-MEDIA tag for subtitles
    if (line.startsWith('#EXT-X-MEDIA:TYPE=SUBTITLES')) {
      currentInfo = { type: 'subtitles' };
      
      // Parse attributes
      const attrs = line.slice('#EXT-X-MEDIA:'.length);
      const langMatch = attrs.match(/LANGUAGE="([^"]+)"/i);
      const nameMatch = attrs.match(/NAME="([^"]+)"/i);
      
      if (langMatch) currentInfo.language = langMatch[1];
      if (nameMatch) currentInfo.label = nameMatch[1];
    }
    
    // If we're in subtitle mode, next non-comment line is the URL
    if (currentInfo.type === 'subtitles' && !line.startsWith('#') && line.length > 0) {
      currentInfo.url = new URL(line, baseUrl).href;
      
      if (currentInfo.url && currentInfo.language) {
        const track = createTrackFromNetwork(
          currentInfo.url,
          'vtt',
          currentInfo.language,
          currentInfo.label || currentInfo.language
        );
        tracks.push(track);
      }
      
      currentInfo = {};
    }
  }
  
  return tracks;
}

/**
 * Look for subtitle data embedded in page JavaScript
 * Some sites embed subtitle URLs in JSON data
 */
export function extractFromPageScripts(): SubtitleTrack[] {
  const tracks: SubtitleTrack[] = [];
  const scripts = document.querySelectorAll('script');

  // Patterns to search for
  const jsonPatterns = [
    /"subtitles?"\s*:\s*\[([^\]]+)\]/gi,
    /"captions?"\s*:\s*\[([^\]]+)\]/gi,
    /subUrls?\s*[:=]\s*\[([^\]]+)\]/gi,
  ];

  const urlPattern = /"url"\s*:\s*"([^"]+\.vtt|[^"]+\.srt|[^"]+\.ass)"/gi;
  const srcPattern = /"src"\s*:\s*"([^"]+\.vtt|[^"]+\.srt|[^"]+\.ass)"/gi;
  const filePattern = /"file"\s*:\s*"([^"]+\.vtt|[^"]+\.srt|[^"]+\.ass)"/gi;

  for (const script of scripts) {
    const content = script.textContent || '';
    
    // Skip empty scripts
    if (content.length < 10) continue;

    // Find all subtitle URLs
    const allPatterns = [urlPattern, srcPattern, filePattern];

    for (const pattern of allPatterns) {
      let match;
      // Reset pattern lastIndex
      pattern.lastIndex = 0;

      while ((match = pattern.exec(content)) !== null) {
        const url = match[1];

        // Ensure URL is absolute
        try {
          const absoluteUrl = new URL(url, window.location.href).href;

          // Extract language from context
          const langMatch = content.slice(Math.max(0, match.index - 100), match.index)
            .match(/"language?"\s*:\s*"([^"]+)"/i);
          const lang = langMatch ? langMatch[1] : undefined;

          const track = createTrackFromNetwork(absoluteUrl, detectSubtitleFormat(absoluteUrl), lang);

          // Avoid duplicates
          if (!tracks.some(t => t.url === track.url)) {
            tracks.push(track);
          }
        } catch {
          // Invalid URL, skip
        }
      }
    }
  }

  return tracks;
}

/**
 * Watch video element for new <track> elements
 */
export function watchForVideoTracks(
  callback: (tracks: SubtitleTrack[]) => void
): () => void {
  const observer = new MutationObserver(() => {
    const tracks = scanPageForTracks();
    if (tracks.length > 0) {
      callback(tracks);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  // Return cleanup function
  return () => observer.disconnect();
}

/**
 * Full scan for all available subtitle tracks
 */
export function getAllAvailableTracks(): SubtitleTrack[] {
  const tracks: SubtitleTrack[] = [];

  // 1. Scan video elements
  tracks.push(...scanPageForTracks());

  // 2. Extract from page scripts
  tracks.push(...extractFromPageScripts());

  // 3. Add detected network URLs
  // (These will be added by the background script via webRequest)

  return tracks;
}

/**
 * Site-specific configuration for known streaming platforms
 */
const SITE_CONFIGS = [
  {
    name: 'lookmovie',
    patterns: [/lookmovie\d*\.to/i, /lookmovie\.[a-z]+/i],
    apiEndpoints: ['/api/v1/security/movie-access', '/api/v2/download/'],
  },
  {
    name: 'youtube',
    patterns: [/youtube\.com/i, /youtu\.be/i],
    apiEndpoints: ['/api/timedtext', '/caption/'],
  },
];

/**
 * Check if current page matches a known site
 */
export function isKnownSite(url: string): string | null {
  try {
    const hostname = new URL(url).hostname;
    for (const config of SITE_CONFIGS) {
      if (config.patterns.some(p => p.test(hostname))) {
        return config.name;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get API endpoint patterns for a known site
 */
export function getApiEndpoints(siteName: string): string[] {
  const config = SITE_CONFIGS.find(c => c.name === siteName);
  return config?.apiEndpoints || [];
}