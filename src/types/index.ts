/**
 * Core types for the Profanity Filter extension
 */

// Cue structure representing a single subtitle entry
export interface Cue {
  id: number;
  startMs: number;
  endMs: number;
  text: string;
  censoredText: string;
  hasProfanity: boolean;
  profanityScore: number;
  profanityMatches: ProfanityMatch[];
}

// Profanity match in text
export interface ProfanityMatch {
  word: string;
  startIndex: number;
  endIndex: number;
  type: 'exact' | 'regex' | 'fuzzy';
  confidence: number;
}

// Subtitle track detected from streaming site or video element
export interface SubtitleTrack {
  id: string;
  label: string;           // Display name: "English SDH", "Spanish", etc.
  language: string;        // ISO code: "en", "es", "en-US", etc.
  isSDH: boolean;           // Is this a closed-caption/SDH track?
  isDefault: boolean;       // Is this the default track?
  url?: string;             // External URL if available
  embedded?: boolean;       // Is it embedded in video element?
  source: 'video' | 'network' | 'user';  // Where was this track detected?
  recommendScore: number;  // Selection priority score (calculated)
}

// Track selection result
export interface TrackSelection {
  track: SubtitleTrack | null;
  alternatives: SubtitleTrack[];
  autoSelected: boolean;
}

// Detected subtitle file from network
export interface NetworkSubtitle {
  url: string;
  format: 'srt' | 'vtt' | 'ass' | 'unknown';
  language?: string;
  label?: string;
  timestamp: number;
}

// Settings stored in browser storage
export interface Settings {
  offsetMs: number;
  sensitivity: 'low' | 'medium' | 'high';
  fuzzyThreshold: number;
  wordlist: string[];
  enabledSites: string[];
  optInTFJS: boolean;
  optInAutoFetch: boolean;
  preferredLanguage: string;  // User's preferred subtitle language
  preferSDH: boolean;          // Prefer SDH/CC tracks
  autoSelectTrack: boolean;    // Auto-select best detected track
}

// Storage schema version
export interface StorageSchema {
  version: number;
  cues: Cue[];
  settings: Settings;
  presets: Record<string, Partial<Settings>>;
  detectedTracks?: SubtitleTrack[];
  currentTrack?: SubtitleTrack | null;
}

// Message types for communication between content script and background
export type MessageType =
  | 'requestCues'
  | 'cues'
  | 'muteNow'
  | 'unmuteNow'
  | 'muted'
  | 'updateOffset'
  | 'status'
  | 'error';

export interface Message {
  type: MessageType;
  tabId?: number;
  data?: unknown;
}

export interface MuteNowMessage {
  type: 'muteNow';
  reasonId: string;
  expectedUnmuteAt: number;
}

export interface UnmuteNowMessage {
  type: 'unmuteNow';
  reasonId: string;
}

export interface CuesMessage {
  type: 'cues';
  cues: Cue[];
  settings: Settings;
}

export interface StatusMessage {
  type: 'status';
  enabled: boolean;
  currentCue: Cue | null;
  nextCues: Cue[];
}

// Profanity detection result
export interface DetectionResult {
  hasProfanity: boolean;
  score: number;
  matches: ProfanityMatch[];
  censoredText: string;
}

// Video player state
export interface PlayerState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  videoElement: HTMLVideoElement | null;
}