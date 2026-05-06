/**
 * Profanity Detector
 *
 * Detects profanity in text using:
 * 1. Exact word matching against a wordlist
 * 2. Obfuscation pattern matching (regex)
 * 3. Optional fuzzy matching for misspellings
 * 4. Context-aware filtering to reduce false positives
 * 5. Fun substitutions instead of [CENSORED]
 */

import { DEFAULT_WORDLIST } from './wordlist';
import { isAllowedInContext, getProfanityConfidence } from './context-rules';
import { log, debug, warn, error } from './logger';
import {
  DEFAULT_SUBSTITUTIONS,
  buildSubstitutionMap,
  type SubstitutionCategory,
  type SubstitutionMapping,
} from './substitutions';
import type { ProfanityWindow } from '../types';

/**
 * Count syllables in an English word using heuristic rules
 */
export function countSyllables(word: string): number {
  if (!word || word.length === 0) return 0;
  
  word = word.toLowerCase().trim();
  
  // Special cases for common short words
  if (word.length <= 2) return 1;
  
  // Remove non-alpha characters
  const cleanWord = word.replace(/[^a-z]/g, '');
  if (cleanWord.length === 0) return 1;
  
  // Vowel groups heuristic
  const vowels = 'aeiouy';
  let count = 0;
  let prevWasVowel = false;
  
  for (const char of cleanWord) {
    const isVowel = vowels.includes(char);
    if (isVowel && !prevWasVowel) {
      count++;
    }
    prevWasVowel = isVowel;
  }
  
  // Adjust for silent 'e' at end
  if (cleanWord.endsWith('e') && count > 1) {
    count--;
  }
  
  // Adjust for 'le' at end (like "table")
  if (cleanWord.endsWith('le') && cleanWord.length > 2 && !vowels.includes(cleanWord[cleanWord.length - 3])) {
    count++;
  }
  
  // Adjust for 'ed' at end (often adds syllable only if preceded by t/d)
  // "started" = 3, "worked" = 1
  if (cleanWord.endsWith('ed') && !cleanWord.endsWith('ted') && !cleanWord.endsWith('ded')) {
    // Usually silent, potentially reduce count
    if (count > 1 && !cleanWord.endsWith('ied')) {
      // ed is often silent, but tricky to handle
    }
  }
  
  // Ensure at least 1 syllable
  return Math.max(1, count);
}

/**
 * Count total syllables in a text
 */
export function countTotalSyllables(text: string): number {
  const words = text.split(/\s+/).filter(w => w.length > 0);
  return words.reduce((sum, word) => sum + countSyllables(word), 0);
}

/**
 * Estimate word timing within a cue
 * Uses syllable-based distribution
 */
export function estimateWordTiming(
  cueStartMs: number,
  cueEndMs: number,
  cueText: string,
  word: string,
  wordStartIndex: number
): { wordStartMs: number; wordEndMs: number } {
  const words = cueText.split(/\s+/).filter(w => w.length > 0);
  const totalSyllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  
  if (totalSyllables === 0) {
    // Fallback to uniform distribution
    const cueDuration = cueEndMs - cueStartMs;
    const wordRatio = wordStartIndex / cueText.length;
    const wordLength = word.length;
    const duration = cueDuration;
    return {
      wordStartMs: cueStartMs + duration * wordRatio,
      wordEndMs: cueStartMs + duration * (wordStartIndex + wordLength) / cueText.length
    };
  }
  
  const cueDuration = cueEndMs - cueStartMs;
  const msPerSyllable = cueDuration / totalSyllables;
  
  // Calculate syllables before the target word
  let syllablesBefore = 0;
  let currentIndex = 0;
  let foundWord = false;
  
  for (const w of words) {
    // Find position of this word in the original text
    const wordPos = cueText.toLowerCase().indexOf(w.toLowerCase(), currentIndex);
    
    if (!foundWord && wordPos === wordStartIndex) {
      foundWord = true;
      break;
    }
    
    if (!foundWord) {
      syllablesBefore += countSyllables(w);
      currentIndex = wordPos + w.length;
    }
  }
  
  const targetSyllables = countSyllables(word);
  
  const wordStartMs = cueStartMs + (syllablesBefore * msPerSyllable);
  const wordEndMs = wordStartMs + (targetSyllables * msPerSyllable);
  
  return { wordStartMs, wordEndMs };
}

/**
 * Speaking rate calibration from a set of cues
 */
export interface SpeakingRateCalibration {
  wpm: number;
  msPerSyllable: number;
  avgSyllablesPerWord: number;
}

/**
 * Calibrate speaking rate from subtitle cues
 */
export function calibrateSpeakingRate(cues: Array<{ startMs: number; endMs: number; text: string }>): SpeakingRateCalibration {
  let totalWords = 0;
  let totalSyllables = 0;
  let totalDurationMs = 0;
  
  for (const cue of cues) {
    const words = cue.text.split(/\s+/).filter(w => w.length > 0);
    totalWords += words.length;
    totalSyllables += words.reduce((sum, w) => sum + countSyllables(w), 0);
    totalDurationMs += (cue.endMs - cue.startMs);
  }
  
  if (totalDurationMs === 0 || totalSyllables === 0) {
    // Fallback to average speaking rate
    return { wpm: 170, msPerSyllable: 175, avgSyllablesPerWord: 1.5 };
  }
  
  const wpm = (totalWords / totalDurationMs) * 60000;
  const msPerSyllable = totalDurationMs / totalSyllables;
  const avgSyllablesPerWord = totalSyllables / totalWords;
  
  return { wpm, msPerSyllable, avgSyllablesPerWord };
}

/**
 * Compute profanity muting windows for a cue
 */
export function computeProfanityWindows(
  cueId: number,
  cueStartMs: number,
  cueEndMs: number,
  cueText: string,
  matches: Array<{ word: string; startIndex: number; endIndex: number }>,
  sensitivity: 'low' | 'medium' | 'high'
): ProfanityWindow[] {
  if (matches.length === 0 || sensitivity === 'high') {
    return [];
  }

  // Buffer settings based on sensitivity
  // Buffers account for timing uncertainty in syllable-based word estimation
  // Pre-buffer is larger because missing the start of a word is worse (you hear the profanity)
  const bufferSettings = {
    low: { before: 200, after: 150 },     // Moderate buffer for low sensitivity
    medium: { before: 500, after: 300 },   // Balanced - catches word onset without over-muting
    high: { before: 200, after: 50 }       // Not used (high mutes entire cue)
  };

  const buffer = bufferSettings[sensitivity];
  const windows: ProfanityWindow[] = [];

  // Calculate total syllables once for position-relative timing
  const cueDuration = cueEndMs - cueStartMs;

  for (const match of matches) {
    const { wordStartMs, wordEndMs } = estimateWordTiming(
      cueStartMs, cueEndMs, cueText, match.word, match.startIndex
    );

    // Calculate word syllables for adaptive buffering
    const wordSyllables = countSyllables(match.word);

    // Short words (1-2 syllables) need buffer due to timing uncertainty
    // Long words (>3 syllables) need more buffer as they take longer to say
    const isShortWord = wordSyllables <= 2;
    const isLongWord = wordSyllables > 3;

    // IMPORTANT: Use CHARACTER position, not syllable-estimated time position
    // Syllable estimation pushes end-of-cue words WAY too late because it assumes
    // uniform speaking rate, but function words ("in the", "a") are spoken 2-3x faster
    // Example: "Bloody pain in the ass" - syllable method estimates "ass" at ~80% time
    //          but character position is 85%, and actual speech is even earlier
    const charPositionRatio = match.startIndex / cueText.length;

    // Calculate adaptive pre-buffer
    let adaptivePreBuffer = buffer.before;
    
    // Short words: ADD buffer (timing is harder to predict for short words)
    if (isShortWord) {
      adaptivePreBuffer += 100;
    }
    
    // Long words: slightly increase buffer (more syllables = more timing variance)
    if (isLongWord) {
      adaptivePreBuffer += 150;
    }

    // CRITICAL FIX: Words in last 50% of TEXT need aggressive pre-buffer
    // Function words before content words at the end are spoken very fast
    // Content word "ass" may start 500-1000ms EARLIER than syllable estimate
    if (charPositionRatio > 0.5) {
      // Exponential bonus - last word needs the most
      // At 50%: +200ms, at 70%: +500ms, at 85%: +950ms, at 95%: +1400ms
      const excessRatio = (charPositionRatio - 0.5) / 0.5; // 0 to 1
      const positionBonus = Math.round(200 + 1200 * excessRatio * excessRatio);
      adaptivePreBuffer += positionBonus;
    } else if (charPositionRatio > 0.3) {
      // Middle region: smaller progressive bonus
      const positionBonus = Math.round(150 * (charPositionRatio - 0.3) / 0.2);
      adaptivePreBuffer += positionBonus;
    }

    // CRITICAL FIX: Words at end of cue need extra post-buffer
    // Syllable estimates often push end-of-cue words to the cue end,
    // but actors often speak faster. Extend mute past the estimated word end.
    let adaptivePostBuffer = buffer.after;
    if (charPositionRatio > 0.7) {
      // Last 30% of text: extend post-buffer significantly
      // The closer to the end, the more uncertain the timing
      const postRatio = (charPositionRatio - 0.7) / 0.3; // 0 to 1
      const postBonus = Math.round(300 + 500 * postRatio * postRatio);
      adaptivePostBuffer += postBonus;
    } else if (charPositionRatio > 0.5) {
      // Last half: moderate post-buffer adjustment
      const postBonus = Math.round(200 * (charPositionRatio - 0.5) / 0.2);
      adaptivePostBuffer += postBonus;
    }

    // For end-of-cue words, don't clip to cueEndMs - allow extending beyond
    // This handles cases where syllable estimate is wrong about word ending time
    const allowExtendedEnd = charPositionRatio > 0.75;

    const window: ProfanityWindow = {
      cueId,
      word: match.word,
      startMs: Math.max(cueStartMs, wordStartMs - adaptivePreBuffer),
      endMs: allowExtendedEnd ? wordEndMs + adaptivePostBuffer : Math.min(cueEndMs, wordEndMs + adaptivePostBuffer),
      wordStartMs,
      wordEndMs,
      bufferBeforeMs: adaptivePreBuffer,
      bufferAfterMs: adaptivePostBuffer
    };

    windows.push(window);
  }

  return windows;
}

// Religious terms whitelist for low sensitivity mode
// These words are allowed through when sensitivity is 'low'
export const RELIGIOUS_WHITELIST = new Set([
  'god',
  'gods',
  'hell',
  'jesus',
  'christ',
  'christian',
  'christianity',
  'damn',
  'damned',
  'damnation',
  'lord',
  'bless',
  'blessed',
  'blessing',
  'bible',
  'prayer',
  'prayers',
  'pray',
  'praying',
  'heaven',
  'heavens',
  'holy',
  'saint',
  'saints',
  'angel',
  'angels',
  'devil',
  'satan',
]);

// Character substitutions used to bypass filters
const SUBSTITUTIONS: Record<string, string> = {
  '@': 'a',
  '4': 'a',
  '3': 'e',
  '1': 'i',
  '!': 'i',
  '0': 'o',
  '5': 's',
  '$': 's',
  '7': 't',
  '+': 't',
};

// Obfuscation pattern regexes - match letters with special chars between them
// Using word boundaries to avoid partial matches
// Obfuscation characters: underscore, punctuation, symbols - but NOT apostrophes or spaces
// This prevents false positives like "He'll" -> "hell" while catching "f_u_c_k"
const OBFUSCATION_CHARS = '[_\\-.*@#$&%!?]';

const OBFUSCATION_PATTERNS = [
  { pattern: new RegExp(`\\bf${OBFUSCATION_CHARS}*u${OBFUSCATION_CHARS}*c${OBFUSCATION_CHARS}*k${OBFUSCATION_CHARS}*s?\\b`, 'gi'), word: 'fuck' },
  { pattern: new RegExp(`\\bs${OBFUSCATION_CHARS}*h${OBFUSCATION_CHARS}*i${OBFUSCATION_CHARS}*t${OBFUSCATION_CHARS}*s?\\b`, 'gi'), word: 'shit' },
  { pattern: new RegExp(`\\bb${OBFUSCATION_CHARS}*i${OBFUSCATION_CHARS}*t${OBFUSCATION_CHARS}*c${OBFUSCATION_CHARS}*h(?:es)?\\b`, 'gi'), word: 'bitch' },
  { pattern: new RegExp(`\\bc${OBFUSCATION_CHARS}*u${OBFUSCATION_CHARS}*n${OBFUSCATION_CHARS}*t${OBFUSCATION_CHARS}*s?\\b`, 'gi'), word: 'cunt' },
  { pattern: new RegExp(`\\bd${OBFUSCATION_CHARS}*i${OBFUSCATION_CHARS}*c${OBFUSCATION_CHARS}*k${OBFUSCATION_CHARS}*s?\\b`, 'gi'), word: 'dick' },
  { pattern: new RegExp(`\\ba${OBFUSCATION_CHARS}*s${OBFUSCATION_CHARS}*s(?:holes?|wipes?|es)?\\b`, 'gi'), word: 'ass' },
  { pattern: new RegExp(`\\bp${OBFUSCATION_CHARS}*u${OBFUSCATION_CHARS}*s${OBFUSCATION_CHARS}*s${OBFUSCATION_CHARS}*y\\b`, 'gi'), word: 'pussy' },
  { pattern: new RegExp(`\\bb${OBFUSCATION_CHARS}*a${OBFUSCATION_CHARS}*s${OBFUSCATION_CHARS}*t${OBFUSCATION_CHARS}*a${OBFUSCATION_CHARS}*r${OBFUSCATION_CHARS}*d${OBFUSCATION_CHARS}*s?\\b`, 'gi'), word: 'bastard' },
  { pattern: new RegExp(`\\bd${OBFUSCATION_CHARS}*a${OBFUSCATION_CHARS}*m${OBFUSCATION_CHARS}*n\\b`, 'gi'), word: 'damn' },
  { pattern: new RegExp(`\\bh${OBFUSCATION_CHARS}*e${OBFUSCATION_CHARS}*l${OBFUSCATION_CHARS}*l\\b`, 'gi'), word: 'hell' },
];

export interface ProfanityMatch {
  word: string;
  startIndex: number;
  endIndex: number;
  type: 'exact' | 'regex' | 'fuzzy';
  confidence: number;
  contextAllowed?: boolean;
}

export interface DetectionResult {
  hasProfanity: boolean;
  score: number;
  matches: ProfanityMatch[];
  censoredText: string;
}

export interface ProfanityConfig {
  wordlist: string[];
  fuzzyThreshold: number;
  sensitivity: 'low' | 'medium' | 'high';
  useFuzzyMatching: boolean;
  useContextFiltering: boolean;
  // Substitution settings
  useSubstitutions: boolean;
  substitutionCategory: SubstitutionCategory;
  customSubstitutions: Map<string, string>;
}

const SENSITIVITY_THRESHOLDS = {
  low: 80,
  medium: 50,
  high: 20,
};

/**
 * Get a random element from an array
 */
function randomChoice<T>(arr: T[]): T | undefined {
  if (arr.length === 0) return undefined;
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Normalize text for profanity matching
 * Apply character substitutions
 */
export function normalizeText(text: string): string {
  let normalized = text.toLowerCase();
  for (const [sub, replacement] of Object.entries(SUBSTITUTIONS)) {
    normalized = normalized.replace(new RegExp(`[${sub}]`, 'g'), replacement);
  }
  return normalized;
}

/**
 * Tokenize text into words
 */
export function tokenize(text: string): string[] {
  return text.match(/\b[\w']+\b/g) || [];
}

/**
 * Compute Levenshtein distance between two strings
 */
export function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Check if two words are fuzzy-matched (within threshold)
 */
export function isFuzzyMatch(word: string, profanityWord: string, threshold: number): boolean {
  const distance = levenshteinDistance(word, profanityWord);
  const maxLength = Math.max(word.length, profanityWord.length);
  const ratio = distance / maxLength;
  return ratio <= threshold;
}

export class ProfanityDetector {
  private wordlist: Set<string>;
  private wordlistArray: string[];
  private phrases: string[];  // Multi-word phrases
  private fuzzyThreshold: number;
  private sensitivityThreshold: number;
  private sensitivity: 'low' | 'medium' | 'high';
  private customPatterns: { pattern: RegExp; word: string }[];
  private useFuzzyMatching: boolean;
  private useContextFiltering: boolean;
  // Substitution settings
  private useSubstitutions: boolean;
  private substitutionCategory: SubstitutionCategory;
  private customSubstitutions: Map<string, string>;
  private substitutionMap: Map<string, SubstitutionMapping>;

  constructor(config: Partial<ProfanityConfig> = {}) {
    const fullConfig: ProfanityConfig = {
      wordlist: DEFAULT_WORDLIST,
      fuzzyThreshold: 0.20,
      sensitivity: 'medium',
      useFuzzyMatching: false,
      useContextFiltering: true,
      useSubstitutions: false,
      substitutionCategory: 'silly',
      customSubstitutions: new Map(),
      ...config,
    };
    this.wordlist = new Set(fullConfig.wordlist.map(w => normalizeText(w)));
    this.wordlistArray = Array.from(this.wordlist);
    // Extract multi-word phrases (contain spaces)
    this.phrases = fullConfig.wordlist
      .filter(w => w.includes(' '))
      .map(w => normalizeText(w));
    this.fuzzyThreshold = fullConfig.fuzzyThreshold;
    this.sensitivityThreshold = SENSITIVITY_THRESHOLDS[fullConfig.sensitivity];
    this.sensitivity = fullConfig.sensitivity;
    this.customPatterns = [...OBFUSCATION_PATTERNS];
    this.useFuzzyMatching = fullConfig.useFuzzyMatching;
    this.useContextFiltering = fullConfig.useContextFiltering;
    this.useSubstitutions = fullConfig.useSubstitutions;
    this.substitutionCategory = fullConfig.substitutionCategory;
    this.customSubstitutions = fullConfig.customSubstitutions;
    this.substitutionMap = buildSubstitutionMap(DEFAULT_SUBSTITUTIONS);
  }

  /**
   * Add words to the wordlist
   */
  addWords(words: string[]): void {
    for (const word of words) {
      this.wordlist.add(normalizeText(word));
      // Also track phrases
      if (word.includes(' ')) {
        this.phrases.push(normalizeText(word));
      }
    }
    this.wordlistArray = Array.from(this.wordlist);
  }

  /**
   * Remove words from the wordlist
   */
  removeWords(words: string[]): void {
    for (const word of words) {
      this.wordlist.delete(normalizeText(word));
      // Also remove from phrases
      const normalized = normalizeText(word);
      this.phrases = this.phrases.filter(p => p !== normalized);
    }
    this.wordlistArray = Array.from(this.wordlist);
  }

  /**
   * Get the current wordlist
   */
  getWordlist(): string[] {
    return Array.from(this.wordlist);
  }

  /**
   * Update sensitivity setting
   */
  setSensitivity(sensitivity: 'low' | 'medium' | 'high'): void {
    this.sensitivityThreshold = SENSITIVITY_THRESHOLDS[sensitivity];
    this.sensitivity = sensitivity;
  }

  /**
   * Get current sensitivity setting
   */
  getSensitivity(): 'low' | 'medium' | 'high' {
    return this.sensitivity;
  }

  /**
   * Enable or disable fuzzy matching
   */
  setFuzzyMatching(enabled: boolean): void {
    this.useFuzzyMatching = enabled;
  }

  /**
   * Enable or disable context filtering
   */
  setContextFiltering(enabled: boolean): void {
    this.useContextFiltering = enabled;
  }

  /**
   * Enable or disable substitutions
   */
  setSubstitutions(enabled: boolean, category?: SubstitutionCategory): void {
    debug(`setSubstitutions(${enabled}, ${category})`);
    this.useSubstitutions = enabled;
    if (category) {
      this.substitutionCategory = category;
    }
    debug(`useSubstitutions now: ${this.useSubstitutions}, category: ${this.substitutionCategory}`);
  }

  /**
   * Set custom substitutions
   */
  setCustomSubstitutions(custom: Map<string, string>): void {
    this.customSubstitutions = custom;
  }

  /**
   * Get substitution for a profanity word
   */
  getSubstitution(word: string): string | null {
    const normalized = normalizeText(word);

    // Check custom substitutions first
    if (this.customSubstitutions.has(normalized)) {
      return this.customSubstitutions.get(normalized) || null;
    }

    // Monkey fast-path: every profane word maps to a random monkey emoji
    // No need to look up the substitution map since all entries are identical
    if (this.substitutionCategory === 'monkeys') {
      const MONKEY_EMOJIS = ['🙈', '🙉', '🙊'] as const;
      return MONKEY_EMOJIS[Math.floor(Math.random() * MONKEY_EMOJIS.length)];
    }

    // Check default substitution map
    const mapping = this.substitutionMap.get(normalized);
    if (!mapping) return null;

    // Get substitutions for the selected category (monkeys handled by fast-path above)
    const validCategories = ['silly', 'polite', 'random'] as const;
    const category = validCategories.includes(this.substitutionCategory as typeof validCategories[number])
      ? this.substitutionCategory as typeof validCategories[number]
      : 'silly';

    const categoryOptions = mapping.substitutions[category];
    if (!categoryOptions || categoryOptions.length === 0) {
      // Fall back to silly category if current category is empty
      const sillyOptions = mapping.substitutions['silly'];
      if (sillyOptions && sillyOptions.length > 0) {
        return randomChoice(sillyOptions) || null;
      }
      return null;
    }

    return randomChoice(categoryOptions) || null;
  }

  /**
   * Check if a single word matches the wordlist (exact or fuzzy)
   */
  checkWord(word: string): { match: boolean; type: 'exact' | 'fuzzy'; confidence: number } {
    const normalized = normalizeText(word);

    // Exact match - always check
    if (this.wordlist.has(normalized)) {
      return { match: true, type: 'exact', confidence: 100 };
    }

    // Fuzzy match - only if enabled
    if (this.useFuzzyMatching) {
      for (const profanityWord of this.wordlistArray) {
        if (isFuzzyMatch(normalized, profanityWord, this.fuzzyThreshold)) {
          const distance = levenshteinDistance(normalized, profanityWord);
          const confidence = 100 - (distance / Math.max(normalized.length, profanityWord.length)) * 100;
          return { match: true, type: 'fuzzy', confidence };
        }
      }
    }

    return { match: false, type: 'exact', confidence: 0 };
  }

  /**
   * Detect profanity in text and return matches
   */
  detect(text: string): DetectionResult {
    const matches: ProfanityMatch[] = [];
    const normalizedText = normalizeText(text);
    const matchedRanges: Array<{ start: number; end: number }> = [];

    // Check for multi-word phrases FIRST (before individual words)
    for (const phrase of this.phrases) {
      // Create regex that matches the phrase with flexible whitespace
      // Use word boundaries at start and end of the whole phrase
      const phrasePattern = phrase.replace(/\s+/g, '\\s+');
      const phraseRegex = new RegExp(`(^|[^a-z'])(${phrasePattern})(?![a-z'])`, 'gi');
      let match;
      while ((match = phraseRegex.exec(text)) !== null) {
        // The actual match starts after the prefix group
        const actualStart = match.index + match[1].length;
        const actualEnd = actualStart + match[2].length;

        // Skip religious whitelist phrases when sensitivity is 'low'
        if (this.sensitivity === 'low' && RELIGIOUS_WHITELIST.has(phrase)) {
          continue;
        }

        // Check context if enabled
        if (this.useContextFiltering && isAllowedInContext(phrase, text, actualStart, actualEnd)) {
          continue;
        }

        matches.push({
          word: match[2], // The actual matched phrase (group 2)
          startIndex: actualStart,
          endIndex: actualEnd,
          type: 'exact',
          confidence: 100,
        });
        matchedRanges.push({ start: actualStart, end: actualEnd });
      }
    }

    // Check obfuscation patterns
    for (const { pattern, word } of this.customPatterns) {
      let match;
      const regex = new RegExp(pattern.source, 'gi');
      while ((match = regex.exec(text)) !== null) {
        // Skip if this match overlaps with an already-matched phrase
        const overlapsWithPhrase = matchedRanges.some(
          range => (match.index >= range.start && match.index < range.end) ||
                   (match.index + match[0].length > range.start && match.index + match[0].length <= range.end) ||
                   (match.index <= range.start && match.index + match[0].length >= range.end)
        );
        if (overlapsWithPhrase) {
          continue;
        }

        // Skip religious whitelist words when sensitivity is 'low'
        if (this.sensitivity === 'low' && RELIGIOUS_WHITELIST.has(normalizeText(word))) {
          continue;
        }

        // Check context for regex matches too
        if (this.useContextFiltering && isAllowedInContext(word, text, match.index, match.index + match[0].length)) {
          continue; // Skip this match
        }

        matches.push({
          word: match[0],
          startIndex: match.index,
          endIndex: match.index + match[0].length,
          type: 'regex',
          confidence: 95,
        });
      }
    }

    // Tokenize and check each word
    const tokens = tokenize(text);
    let searchIndex = 0;

    for (const token of tokens) {
      // Find the actual position of this token in the original text
      const tokenIndex = text.toLowerCase().indexOf(token.toLowerCase(), searchIndex);
      if (tokenIndex === -1) continue;

      const { match, type, confidence } = this.checkWord(token);

      if (match) {
        // Skip religious whitelist words when sensitivity is 'low'
        if (this.sensitivity === 'low' && RELIGIOUS_WHITELIST.has(normalizeText(token))) {
          searchIndex = tokenIndex + token.length;
          continue;
        }

        // Avoid duplicate matches
        const alreadyMatched = matches.some(
          m => (tokenIndex >= m.startIndex && tokenIndex < m.endIndex) ||
               (m.startIndex >= tokenIndex && m.startIndex < tokenIndex + token.length)
        );

        if (!alreadyMatched) {
          // Check context if enabled
          let finalConfidence = confidence;
          let contextAllowed = false;

          if (this.useContextFiltering) {
            contextAllowed = isAllowedInContext(token, text, tokenIndex, tokenIndex + token.length);
            if (contextAllowed) {
              continue; // Skip this match
            }
            finalConfidence = getProfanityConfidence(token, text, tokenIndex, tokenIndex + token.length);
          }

          matches.push({
            word: token,
            startIndex: tokenIndex,
            endIndex: tokenIndex + token.length,
            type,
            confidence: finalConfidence,
            contextAllowed,
          });
        }
      }

      searchIndex = tokenIndex + token.length;
    }

    // Calculate final score
    let totalScore = matches.reduce((sum, m) => sum + m.confidence, 0);
    const score = matches.length > 0 ? Math.min(100, totalScore / matches.length) : 0;
    const hasProfanity = score >= this.sensitivityThreshold && matches.length > 0;

    // Generate censored text (with fun substitutions or [CENSORED])
    const censoredText = this.censorText(text, matches);

    return {
      hasProfanity,
      score,
      matches,
      censoredText,
    };
  }

  /**
   * Replace profanity matches with [CENSORED] or fun substitutions
   * Preserves original text positions
   */
  censorText(text: string, matches: ProfanityMatch[]): string {
    if (matches.length === 0) return text;

    // Sort matches by start index (descending) to replace from end to start
    const sortedMatches = [...matches].sort((a, b) => b.startIndex - a.startIndex);

    let result = text;
    for (const match of sortedMatches) {
      let replacement: string;

      if (this.useSubstitutions) {
        // Try to get a fun substitution
        const sub = this.getSubstitution(match.word);
        debug(`getSubstitution("${match.word}"):`, sub, `(useSubstitutions: ${this.useSubstitutions}, category: ${this.substitutionCategory})`);
        replacement = sub || '[CENSORED]';
      } else {
        replacement = '[CENSORED]';
      }

      result = result.slice(0, match.startIndex) + replacement + result.slice(match.endIndex);
    }

    return result;
  }
}

// Create default detector instance
export function createDetector(config?: Partial<ProfanityConfig>): ProfanityDetector {
  // Don't spread wordlist if it's empty or undefined (use defaults)
  const { wordlist: configWordlist, ...restConfig } = config || {} as Partial<ProfanityConfig>;

  return new ProfanityDetector({
    wordlist: DEFAULT_WORDLIST,
    fuzzyThreshold: 0.20,
    sensitivity: 'medium',
    useFuzzyMatching: false,
    useContextFiltering: true,
    useSubstitutions: true,
    substitutionCategory: 'monkeys',
    ...restConfig,
    ...(configWordlist && configWordlist.length > 0 ? { wordlist: configWordlist } : {}),
  });
}