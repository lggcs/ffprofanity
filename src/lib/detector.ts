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
import {
  DEFAULT_SUBSTITUTIONS,
  buildSubstitutionMap,
  type SubstitutionCategory,
  type SubstitutionMapping,
} from './substitutions';

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
const OBFUSCATION_PATTERNS = [
  { pattern: /\bf[\W_]*u[\W_]*c[\W_]*k\b/gi, word: 'fuck' },
  { pattern: /\bs[\W_]*h[\W_]*i[\W_]*t\b/gi, word: 'shit' },
  { pattern: /\bb[\W_]*i[\W_]*t[\W_]*c[\W_]*h\b/gi, word: 'bitch' },
  { pattern: /\bc[\W_]*u[\W_]*n[\W_]*t\b/gi, word: 'cunt' },
  { pattern: /\bd[\W_]*i[\W_]*c[\W_]*k\b/gi, word: 'dick' },
  { pattern: /\ba[\W_]*s[\W_]*s\b/gi, word: 'ass' },
  { pattern: /\bp[\W_]*u[\W_]*s[\W_]*s[\W_]*y\b/gi, word: 'pussy' },
  { pattern: /\bb[\W_]*a[\W_]*s[\W_]*t[\W_]*a[\W_]*r[\W_]*d\b/gi, word: 'bastard' },
  { pattern: /\bd[\W_]*a[\W_]*m[\W_]*n\b/gi, word: 'damn' },
  { pattern: /\bh[\W_]*e[\W_]*l[\W_]*l\b/gi, word: 'hell' },
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
  private fuzzyThreshold: number;
  private sensitivityThreshold: number;
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
    this.fuzzyThreshold = fullConfig.fuzzyThreshold;
    this.sensitivityThreshold = SENSITIVITY_THRESHOLDS[fullConfig.sensitivity];
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
    }
    this.wordlistArray = Array.from(this.wordlist);
  }

  /**
   * Remove words from the wordlist
   */
  removeWords(words: string[]): void {
    for (const word of words) {
      this.wordlist.delete(normalizeText(word));
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
    this.useSubstitutions = enabled;
    if (category) {
      this.substitutionCategory = category;
    }
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

    // Check default substitution map
    const mapping = this.substitutionMap.get(normalized);
    if (!mapping) return null;

    const categoryOptions = mapping.substitutions[this.substitutionCategory];
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
    
    // Check obfuscation patterns first
    for (const { pattern, word } of this.customPatterns) {
      let match;
      const regex = new RegExp(pattern.source, 'gi');
      while ((match = regex.exec(text)) !== null) {
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
    useSubstitutions: false,
    substitutionCategory: 'silly',
    ...restConfig,
    ...(configWordlist && configWordlist.length > 0 ? { wordlist: configWordlist } : {}),
  });
}