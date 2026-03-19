/**
 * Subtitle Track Manager
 * Handles track detection, scoring, and intelligent selection
 */

import type { SubtitleTrack, TrackSelection, Settings } from '../types';

// SDH/CC indicator patterns in track labels
const SDH_PATTERNS = [
  /\bsdh\b/i,
  /\bcc\b/i,
  /\bclosed.?captions?\b/i,
  /\bhearing.?impaired\b/i,
  /\bdeaf\b/i,
  /\bhi\b/i,
];

// Forced narrative patterns (only foreign dialogue)
const FORCED_PATTERNS = [
  /\bforced\b/i,
  /\bforeign.?only\b/i,
  /\bnarrative\b/i,
];

// Common language codes and their variations
const LANGUAGE_ALIASES: Record<string, string[]> = {
  'en': ['en', 'eng', 'english', 'en-us', 'en-gb', 'en-au'],
  'es': ['es', 'spa', 'spanish', 'es-es', 'es-mx', 'es-la'],
  'fr': ['fr', 'fre', 'fra', 'french', 'fr-fr', 'fr-ca'],
  'de': ['de', 'ger', 'deu', 'german', 'de-de'],
  'pt': ['pt', 'por', 'portuguese', 'pt-br', 'pt-pt'],
  'it': ['it', 'ita', 'italian'],
  'ja': ['ja', 'jpn', 'japanese'],
  'ko': ['ko', 'kor', 'korean'],
  'zh': ['zh', 'chi', 'zho', 'chinese', 'zh-cn', 'zh-tw'],
  'ar': ['ar', 'ara', 'arabic'],
  'ru': ['ru', 'rus', 'russian'],
};

/**
 * Normalize language code to ISO 639-1
 */
export function normalizeLanguageCode(lang: string | undefined): string {
  if (!lang) return '';
  const lowerLang = lang.toLowerCase().trim();
  
  // Check direct matches first
  const twoCharCode = lowerLang.substring(0, 2);
  if (LANGUAGE_ALIASES[twoCharCode]) {
    return twoCharCode;
  }
  
  // Check against all aliases
  for (const [code, aliases] of Object.entries(LANGUAGE_ALIASES)) {
    if (aliases.includes(lowerLang)) {
      return code;
    }
  }
  
  // Return first 2 chars if not found
  return lowerLang.substring(0, 2);
}

/**
 * Check if track label indicates SDH/CC
 */
export function isSDHTrack(track: SubtitleTrack): boolean {
  const label = track.label.toLowerCase();
  return SDH_PATTERNS.some(pattern => pattern.test(label));
}

/**
 * Check if track is forced narrative (only foreign dialogue)
 */
export function isForcedTrack(track: SubtitleTrack): boolean {
  const label = track.label.toLowerCase();
  return FORCED_PATTERNS.some(pattern => pattern.test(label));
}

/**
 * Calculate recommendation score for a track
 * Higher score = better choice
 */
export function calculateRecommendScore(
  track: SubtitleTrack,
  settings: Pick<Settings, 'preferredLanguage' | 'preferSDH'>
): number {
  let score = 0;
  
  const normalizedTrackLang = normalizeLanguageCode(track.language);
  const normalizedPreferredLang = normalizeLanguageCode(settings.preferredLanguage);
  
  // Language match (+10 for preferred, +5 for English fallback)
  if (normalizedTrackLang === normalizedPreferredLang) {
    score += 10;
  } else if (normalizedTrackLang === 'en') {
    score += 5;
  }
  
  // SDH/CC preference (+3 for SDH if user prefers, -2 for forced)
  if (settings.preferSDH && isSDHTrack(track)) {
    score += 3;
  }
  
  // Penalize forced narrative tracks (-5)
  if (isForcedTrack(track)) {
    score -= 5;
  }
  
  // Default track gets a small bonus (+2)
  if (track.isDefault) {
    score += 2;
  }
  
  // User-uploaded tracks get priority (+15)
  if (track.source === 'user') {
    score += 15;
  }
  
  return score;
}

/**
 * Select the best track from available options
 */
export function selectBestTrack(
  tracks: SubtitleTrack[],
  settings: Pick<Settings, 'preferredLanguage' | 'preferSDH'>
): TrackSelection {
  if (tracks.length === 0) {
    return {
      track: null,
      alternatives: [],
      autoSelected: false,
    };
  }
  
  // Calculate scores for all tracks
  const scoredTracks = tracks.map(track => ({
    ...track,
    recommendScore: calculateRecommendScore(track, settings),
  }));
  
  // Sort by score descending
  scoredTracks.sort((a, b) => b.recommendScore - a.recommendScore);
  
  // User-uploaded tracks are always selected without auto-selection
  const hasUserTrack = scoredTracks[0]?.source === 'user';
  
  // If highest score is negative (forced tracks only with no language match),
  // still return the best option but mark as not auto-selected
  const bestTrack = scoredTracks[0];
  const shouldAutoSelect = bestTrack && bestTrack.recommendScore >= 0 && !hasUserTrack;
  
  return {
    track: bestTrack || null,
    alternatives: scoredTracks.slice(1),
    autoSelected: shouldAutoSelect ?? false,
  };
}

/**
 * Create a track from a video <track> element
 */
export function createTrackFromElement(element: HTMLTrackElement): SubtitleTrack {
  const track: SubtitleTrack = {
    id: element.id || `track-${element.label || 'unknown'}-${element.srclang || 'und'}`,
    label: element.label || element.srclang || 'Unknown',
    language: element.srclang || '',
    isSDH: false,
    isDefault: element.default || false,
    embedded: true,
    source: 'video',
    recommendScore: 0,
  };
  
  // Check for SDH indicators
  track.isSDH = isSDHTrack(track);
  
  return track;
}

/**
 * Create a track from a detected network subtitle
 */
export function createTrackFromNetwork(
  url: string,
  format: 'srt' | 'vtt' | 'ass' | 'unknown',
  language?: string,
  label?: string
): SubtitleTrack {
  const track: SubtitleTrack = {
    id: `network-${url}`,
    label: label || language || `Subtitle (${format.toUpperCase()})`,
    language: language || '',
    isSDH: false,
    isDefault: false,
    url,
    embedded: false,
    source: 'network',
    recommendScore: 0,
  };
  
  // Check for SDH indicators in label
  track.isSDH = isSDHTrack(track);
  
  return track;
}

/**
 * Create a track from a user-uploaded file
 */
export function createTrackFromUser(
  filename: string,
  content: string
): SubtitleTrack {
  // Try to extract language from filename
  const langMatch = filename.match(/[\.\-_](en|es|fr|de|pt|it|ja|ko|zh|ar|ru)[\.\-_]/i);
  const language = langMatch ? langMatch[1].toLowerCase() : '';
  
  // Determine format from filename
  const ext = filename.split('.').pop()?.toLowerCase();
  const format = ext === 'srt' || ext === 'vtt' || ext === 'ass' ? ext : 'unknown';
  
  const label = language
    ? `${language.toUpperCase()} - ${filename}`
    : filename;
  
  const track: SubtitleTrack = {
    id: `user-${Date.now()}`,
    label,
    language,
    isSDH: /sdh|cc|hearing/i.test(filename),
    isDefault: true,
    embedded: false,
    source: 'user',
    recommendScore: 15, // User uploads always have priority
  };
  
  return track;
}

/**
 * Format track for display in UI
 */
export function formatTrackLabel(track: SubtitleTrack): string {
  const parts: string[] = [];
  
  parts.push(track.label);
  
  if (track.isSDH) {
    parts.push('★');
  }
  
  if (track.source === 'network') {
    parts.push('(detected)');
  } else if (track.source === 'user') {
    parts.push('(uploaded)');
  }
  
  return parts.join(' ');
}

/**
 * Deduplicate tracks by language + SDH status
 */
export function deduplicateTracks(tracks: SubtitleTrack[]): SubtitleTrack[] {
  const seen = new Map<string, SubtitleTrack>();
  
  for (const track of tracks) {
    const key = `${normalizeLanguageCode(track.language)}-${track.isSDH}`;
    const existing = seen.get(key);
    
    // Keep track with higher score, prefer embedded tracks on tie
    if (!existing || 
        track.recommendScore > existing.recommendScore ||
        (track.recommendScore === existing.recommendScore && track.embedded)) {
      seen.set(key, track);
    }
  }
  
  return Array.from(seen.values());
}