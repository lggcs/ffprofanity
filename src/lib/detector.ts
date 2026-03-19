/**
 * Profanity Detection Engine
 * Implements layered detection: wordlist + regex + fuzzy matching
 */

import type { ProfanityMatch, DetectionResult } from '../types';

// Common character substitution mappings
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

// Default profanity wordlist (common explicit terms)
const DEFAULT_WORDLIST = [
  'fuck', 'shit', 'ass', 'bitch', 'dick', 'cock', 'pussy', 'cunt',
  'bastard', 'whore', 'nigger', 'nigga', 'faggot', 'slut', 'hoe',
  'dildo', 'vibrator', 'orgasm', 'penis', 'vagina', 'nipple',
  'motherfucker', 'bullshit', 'horseshit',
];

// Obfuscation pattern regexes
const OBFUSCATION_PATTERNS = [
  // f*ck, f**k style
  { pattern: /f[\W_]*u[\W_]*c[\W_]*k/gi, word: 'fuck' },
  // s*it, s**t  
  { pattern: /s[\W_]*h[\W_]*i[\W_]*t/gi, word: 'shit' },
  // b*tch
  { pattern: /b[\W_]*i[\W_]*t[\W_]*c[\W_]*h/gi, word: 'bitch' },
  // c*nt
  { pattern: /c[\W_]*u[\W_]*n[\W_]*t/gi, word: 'cunt' },
  // d*ck
  { pattern: /d[\W_]*i[\W_]*c[\W_]*k/gi, word: 'dick' },
  // *ss
  { pattern: /a[\W_]*s[\W_]*s/gi, word: 'ass' },
  // p*ssy
  { pattern: /p[\W_]*u[\W_]*s[\W_]*s[\W_]*y/gi, word: 'pussy' },
  // b*tard
  { pattern: /b[\W_]*a[\W_]*s[\W_]*t[\W_]*a[\W_]*r[\W_]*d/gi, word: 'bastard' },
];

export interface ProfanityConfig {
  wordlist: string[];
  fuzzyThreshold: number;
  sensitivity: 'low' | 'medium' | 'high';
}

const SENSITIVITY_THRESHOLDS = {
  low: 80,
  medium: 50,
  high: 20,
};

/**
 * Normalize text for profanity matching
 * Apply character substitutions and remove punctuation except obfuscation chars
 */
export function normalizeText(text: string): string {
  let normalized = text.toLowerCase();
  
  // Apply character substitutions
  for (const [sub, replacement] of Object.entries(SUBSTITUTIONS)) {
    normalized = normalized.replace(new RegExp(`[${sub}]`, 'g'), replacement);
  }
  
  return normalized;
}

/**
 * Tokenize text into words
 */
export function tokenize(text: string): string[] {
  // Split by whitespace and punctuation, but keep the word boundaries
  return text.toLowerCase().split(/[\s\p{P}]+/gu).filter(w => w.length > 0);
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
  private fuzzyThreshold: number;
  private sensitivityThreshold: number;
  private customPatterns: { pattern: RegExp; word: string }[];
  
  constructor(config: ProfanityConfig = {
    wordlist: DEFAULT_WORDLIST,
    fuzzyThreshold: 0.25,
    sensitivity: 'medium',
  }) {
    this.wordlist = new Set(config.wordlist.map(w => normalizeText(w)));
    this.fuzzyThreshold = config.fuzzyThreshold;
    this.sensitivityThreshold = SENSITIVITY_THRESHOLDS[config.sensitivity];
    this.customPatterns = [...OBFUSCATION_PATTERNS];
  }
  
  /**
   * Add words to the wordlist
   */
  addWords(words: string[]): void {
    for (const word of words) {
      this.wordlist.add(normalizeText(word));
    }
  }
  
  /**
   * Remove words from the wordlist
   */
  removeWords(words: string[]): void {
    for (const word of words) {
      this.wordlist.delete(normalizeText(word));
    }
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
   * Check if a single word matches the wordlist (exact or fuzzy)
   */
  checkWord(word: string): { match: boolean; type: 'exact' | 'fuzzy'; confidence: number } {
    const normalized = normalizeText(word);
    
    // Exact match
    if (this.wordlist.has(normalized)) {
      return { match: true, type: 'exact', confidence: 100 };
    }
    
    // Fuzzy match
    for (const profanityWord of this.wordlist) {
      if (isFuzzyMatch(normalized, profanityWord, this.fuzzyThreshold)) {
        const distance = levenshteinDistance(normalized, profanityWord);
        const confidence = 100 - (distance / Math.max(normalized.length, profanityWord.length)) * 100;
        return { match: true, type: 'fuzzy', confidence };
      }
    }
    
    return { match: false, type: 'exact', confidence: 0 };
  }
  
  /**
   * Detect profanity in text and return matches
   */
  detect(text: string): DetectionResult {
    const matches: ProfanityMatch[] = [];
    let totalScore = 0;
    
    // Check obfuscation patterns first
    for (const { pattern, word } of this.customPatterns) {
      let match;
      const regex = new RegExp(pattern.source, 'gi');
      while ((match = regex.exec(text)) !== null) {
        matches.push({
          word: match[0],
          startIndex: match.index,
          endIndex: match.index + match[0].length,
          type: 'regex',
          confidence: 95,
        });
        totalScore += 95;
      }
    }
    
    // Tokenize and check each word
    const tokens = tokenize(text);
    let searchIndex = 0;
    
    for (const token of tokens) {
      // Find the actual position of this token in the original text
      const tokenIndex = text.toLowerCase().indexOf(token, searchIndex);
      if (tokenIndex === -1) continue;
      
      const { match, type, confidence } = this.checkWord(token);
      
      if (match) {
        // Avoid duplicate matches
        const alreadyMatched = matches.some(
          m => (tokenIndex >= m.startIndex && tokenIndex < m.endIndex) ||
               (m.startIndex >= tokenIndex && m.startIndex < tokenIndex + token.length)
        );
        
        if (!alreadyMatched) {
          matches.push({
            word: token,
            startIndex: tokenIndex,
            endIndex: tokenIndex + token.length,
            type,
            confidence,
          });
          totalScore += confidence;
        }
      }
      
      searchIndex = tokenIndex + token.length;
    }
    
    // Calculate final score
    const score = matches.length > 0 ? Math.min(100, totalScore / matches.length) : 0;
    const hasProfanity = score >= this.sensitivityThreshold && matches.length > 0;
    
    // Generate censored text
    const censoredText = this.censorText(text, matches);
    
    return {
      hasProfanity,
      score,
      matches,
      censoredText,
    };
  }
  
  /**
   * Replace profanity matches with [CENSORED]
   * Preserves original text positions
   */
  censorText(text: string, matches: ProfanityMatch[]): string {
    if (matches.length === 0) return text;
    
    // Sort matches by start index (descending) to replace from end to start
    const sortedMatches = [...matches].sort((a, b) => b.startIndex - a.startIndex);
    
    let result = text;
    for (const match of sortedMatches) {
      result = result.slice(0, match.startIndex) + '[CENSORED]' + result.slice(match.endIndex);
    }
    
    return result;
  }
}

// Create default detector instance
export function createDetector(config?: Partial<ProfanityConfig>): ProfanityDetector {
  return new ProfanityDetector({
    wordlist: DEFAULT_WORDLIST,
    fuzzyThreshold: 0.25,
    sensitivity: 'medium',
    ...config,
  });
}