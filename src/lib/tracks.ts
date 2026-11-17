/**
 * Subtitle Track Manager
 * Handles track detection, scoring, and intelligent selection
 */

import type { SubtitleTrack, TrackSelection, Settings } from '../types';
import { languageDisplayName } from './language';

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
 * "(a)"/"B"-suffixed alternate releases of the same captions (lookmovie2:
 * "English 1 A", "English (a)"). Sites mark auto-generated or re-authored
 * copies this way, and those releases are the ones most often out of sync
 * with the actual transfer (OCR text, wrong fps master). Selection prior only.
 */
export function isVariantTrackLabel(label: string): boolean {
  const trimmed = label.trim();
  return (
    /(^|\s)\((a|b|c)\)$/i.test(trimmed) ||
    /\d\s+\([a-c]\)$/i.test(trimmed) ||
    /\d\s+[a-c]$/i.test(trimmed)
  );
}

/**
 * Fraction of the runtime a track's cues reach. Sites routinely serve several
 * files for the same language where only one spans the whole video, so this is
 * the signal that separates a complete track from a truncated one.
 * Returns null when the track's span or the runtime is unknown.
 */
export function trackCoverageRatio(
  track: SubtitleTrack,
  videoDurationMs: number
): number | null {
  if (!videoDurationMs || !Number.isFinite(videoDurationMs) || videoDurationMs <= 0) {
    return null;
  }
  const lastCueMs = track.lastCueMs;
  if (typeof lastCueMs !== 'number' || !Number.isFinite(lastCueMs) || lastCueMs <= 0) {
    return null;
  }
  return Math.min(1, lastCueMs / videoDurationMs);
}

// A track reaching this fraction of the runtime is treated as complete; below
// COVERAGE_PARTIAL_RATIO its cues run out long before the ending.
export const COVERAGE_ACCEPTABLE_RATIO = 0.85;
const COVERAGE_PARTIAL_RATIO = 0.5;
const COVERAGE_FULL_BONUS = 14;
const COVERAGE_PARTIAL_BONUS = 2;
const COVERAGE_TRUNCATED_PENALTY = 14;

/**
 * Coverage term of the recommendation score. It outweighs the language match
 * bonus on purpose: a full-length track the site filed under an unparseable
 * language is a better choice than a truncated track in the right language.
 */
function coverageScore(
  track: SubtitleTrack,
  videoDurationMs: number | undefined
): number {
  if (!videoDurationMs) return 0;
  const ratio = trackCoverageRatio(track, videoDurationMs);
  if (ratio === null) return 0;
  if (ratio >= COVERAGE_ACCEPTABLE_RATIO) return COVERAGE_FULL_BONUS;
  if (ratio >= COVERAGE_PARTIAL_RATIO) return COVERAGE_PARTIAL_BONUS;
  return -COVERAGE_TRUNCATED_PENALTY;
}

/**
 * Stable identity for a track across detections (URL when present).
 */
export function trackKey(track: SubtitleTrack): string {
  return track.url || track.id;
}

// Label placeholders players produce for unlabeled text tracks
const PLACEHOLDER_LABEL = /^(unknown|und|undefined|none|no label|)$/i;
// Labels that carry no usable name: current placeholders plus prior "Unknown
// N" relabels, so a group member that later resolves lets the rest renumber.
const UNKNOWN_GROUP_LABEL =
  /^(unknown( \d+)?|und|undefined|none|no label|)$/i;

/**
 * The display name a track's language resolves to, if any — the language
 * field first, then the bare code token in its label ("ENG", "HRV"), then
 * the label text itself when it IS a language name ("Croatian"). null means
 * unresolvable: a real-named label stays untouched; a placeholder label
 * joins the numbered Unknown group.
 */
export function resolvedLanguageName(track: SubtitleTrack): string | null {
  return (
    languageDisplayName((track.language || '').trim()) ||
    languageDisplayName(bareLanguageCodeToken(track.label || '')) ||
    languageDisplayName((track.label || '').trim())
  );
}

/** The source paths whose labels belong to the viewer, not to a site relay. */
function isViewerOwnedTrack(track: SubtitleTrack): boolean {
  const source = track.source || '';
  return source === 'user' || source.includes('user-subtitle');
}

/** Label that is nothing but a language code token ("ENG", "sr-Latn", "ro"). */
function bareLanguageCodeToken(label: string): string {
  const trimmed = label.trim();
  return /^[a-z]{2,3}$/i.test(trimmed) || /^[a-z]{2,3}[-_][A-Za-z0-9]{2,8}$/i.test(trimmed)
    ? trimmed
    : '';
}

/**
 * Canonical, relay-independent labels, applied once at the single content
 * ingestion point so every detection path labels alike. Relays disagree:
 * native relays pass raw codes ("ENG", "HRV"), movie-access relays pass
 * bare names, and page scripts number their own list per relay — the same
 * file can appear as "ENG", "English" and "English 1" in one popup.
 *  - placeholder labels and bare codes become the language display name
 *    (resolved from the track's language field, its label's code token, or
 *    the label being a language name itself);
 *  - tracks sharing a resolved language name are numbered by list order
 *    ("English 1", "English 2", ...) exactly as one relayed site list is;
 *  - "(a)"-style variant suffixes survive renumbering unchanged
 *    (isVariantTrackLabel demotion depends on them);
 *  - labels that carry a real name or marker ("English SDH") are left alone;
 *  - user uploads and site-menu picks keep the label the viewer chose;
 *  - placeholder-labeled tracks whose language does not resolve become one
 *    numbered "Unknown" group ("Unknown 1..N") in list order.
 * Mutates the tracks in place; safe to run repeatedly (idempotent).
 */
export function canonicalizeTrackLabels(tracks: SubtitleTrack[]): void {
  const counts = new Map<string, number>();
  for (const t of tracks) {
    const name = resolvedLanguageName(t);
    if (name) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  const seq = new Map<string, number>();
  for (const t of tracks) {
    if (isViewerOwnedTrack(t)) continue;
    const name = resolvedLanguageName(t);
    if (!name) continue;
    const { base, variant } = splitVariantSuffix(t.label || '');
    const unNumbered = base.replace(/\s+\d+$/, '').trim() || base;
    const isPlaceholder =
      PLACEHOLDER_LABEL.test(unNumbered) || !!bareLanguageCodeToken(unNumbered);
    if (!isPlaceholder && unNumbered.toLowerCase() !== name.toLowerCase()) continue;
    const n = (seq.get(name) ?? 0) + 1;
    seq.set(name, n);
    const suffix = (counts.get(name) ?? 0) > 1 ? ` ${n}` : '';
    t.label = `${name}${suffix}${variant ? ` ${variant}` : ''}`;
  }
  const unknowns = tracks.filter(
    (t) =>
      !isViewerOwnedTrack(t) &&
      !resolvedLanguageName(t) &&
      UNKNOWN_GROUP_LABEL.test((t.label || '').trim()),
  );
  unknowns.forEach((t, i) => {
    t.label = unknowns.length > 1 ? `Unknown ${i + 1}` : 'Unknown';
  });
}

/**
 * Sort-group name for the popup track list: the resolved language display
 * name when one exists, the viewer-owned label itself when the track is an
 * upload or site-menu pick, the relay label when it carried a real name we
 * could not map, and "Unknown" for the numbered placeholder group.
 */
export function trackLanguageGroup(track: SubtitleTrack): string {
  const name = resolvedLanguageName(track);
  if (name) return name;
  if (isViewerOwnedTrack(track)) {
    return (track.label || '').trim() || 'Unknown';
  }
  const label = (track.label || '').trim();
  if (!label || UNKNOWN_GROUP_LABEL.test(label)) return 'Unknown';
  return label;
}

/**
 * Popup display order: viewer-owned picks and uploads first (the viewer's
 * own controls), then the preferred language, then every other language
 * alphabetically, and the "Unknown" group last. Within a group the incoming
 * array order is preserved, so per-language numbering stays ascending.
 */
export function sortTracksForDisplay(
  tracks: SubtitleTrack[],
  preferredLanguage: string | undefined,
): SubtitleTrack[] {
  const preferredName = languageDisplayName(preferredLanguage || '');
  const rank = (track: SubtitleTrack, group: string): number => {
    if (isViewerOwnedTrack(track)) return 0;
    if (group === 'Unknown') return 3;
    if (preferredName && group === preferredName) return 1;
    return 2;
  };
  return tracks
    .map((track, index) => ({ track, index, group: trackLanguageGroup(track) }))
    .sort((a, b) => {
      const byRank = rank(a.track, a.group) - rank(b.track, b.group);
      if (byRank !== 0) return byRank;
      if (a.group !== b.group) return a.group.localeCompare(b.group);
      return a.index - b.index;
    })
    .map((entry) => entry.track);
}

/**
 * Duplicate-URL ingestion rule: relays race, and a file whose URL carries
 * no language (hashed caption hosts) can be stored as an unknown-language
 * placeholder while its named twin loses the same-URL dedupe. When the
 * arriving twin resolves a language the stored copy cannot, adopt the
 * twin's language metadata in place. Returns true when the stored entry
 * changed; the arriving copy is always treated as a duplicate and never
 * added twice. Viewer-owned entries are never rewritten.
 */
export function upgradeDuplicateTrack(
  existing: SubtitleTrack,
  incoming: SubtitleTrack,
): boolean {
  if (
    isViewerOwnedTrack(existing) ||
    resolvedLanguageName(existing) ||
    !resolvedLanguageName(incoming)
  ) {
    return false;
  }
  existing.language = incoming.language;
  existing.label = incoming.label;
  existing.isSDH = incoming.isSDH;
  return true;
}

/**
 * Peel a leading variant tag ("(a)" or a bare trailing a/b/c after
 * whitespace) off a label so it can sit past the canonical number.
 */
function splitVariantSuffix(label: string): { base: string; variant: string } {
  const paren = label.match(/^(.+?)\s*\(([a-c])\)$/i);
  if (paren?.[1] && paren[2]) {
    return { base: paren[1].trim(), variant: `(${paren[2]})` };
  }
  const bare = label.match(/^(.*\S)\s+([a-c])$/i);
  if (bare?.[1] && bare[2]) {
    return { base: bare[1].trim(), variant: bare[2].toUpperCase() };
  }
  return { base: label.trim(), variant: '' };
}

/**
 * Calculate recommendation score for a track
 * Higher score = better choice
 */
export function calculateRecommendScore(
  track: SubtitleTrack,
  settings: Pick<Settings, 'preferredLanguage' | 'preferSDH'>,
  context?: { videoDurationMs?: number }
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

  // "(a)"-style variant releases are frequently ASR/OCR re-encodes authored
  // against a different transfer — the ones most often out of sync. Demote
  // when a normal release competes; the penalty must not sink a lone
  // candidate below zero (10 + 2 − 4 stays selectable).
  if (isVariantTrackLabel(track.label)) {
    score -= 4;
  }

  // User-uploaded tracks get priority (+15)
  if (track.source === 'user') {
    score += 15;
  }

  // Coverage only ever breaks ties between candidates: it must not push a
  // track that would otherwise be selectable below zero, or a site serving a
  // single short-but-usable file would stop auto-selecting altogether.
  const coverage = coverageScore(track, context?.videoDurationMs);
  return coverage < 0 ? Math.max(0, score + coverage) : score + coverage;
}

/**
 * Select the best track from available options
 */
export function selectBestTrack(
  tracks: SubtitleTrack[],
  settings: Pick<Settings, 'preferredLanguage' | 'preferSDH'>,
  context?: { videoDurationMs?: number }
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
    recommendScore: calculateRecommendScore(track, settings, context),
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
  const language = langMatch?.[1]?.toLowerCase() ?? '';
  
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