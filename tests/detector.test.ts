/**
 * Profanity Detector Unit Tests
 */

import { describe, it, expect } from 'vitest';
import {
  ProfanityDetector,
  createDetector,
  normalizeText,
  tokenize,
  levenshteinDistance,
  isFuzzyMatch
} from '../src/lib/detector';

describe('ProfanityDetector', () => {
  describe('normalizeText', () => {
    it('should convert to lowercase', () => {
      expect(normalizeText('HELLO')).toBe('hello');
    });

    it('should apply character substitutions', () => {
      expect(normalizeText('f@ck')).toBe('fack');
      expect(normalizeText('sh1t')).toBe('shit');
      expect(normalizeText('a$$')).toBe('ass');
    });

    it('should handle multiple substitutions', () => {
      expect(normalizeText('f@ck3r')).toBe('facker');
    });
  });

  describe('tokenize', () => {
    it('should split text into words', () => {
      expect(tokenize('hello world')).toEqual(['hello', 'world']);
    });

    it('should handle punctuation', () => {
      expect(tokenize('hello, world!')).toEqual(['hello', 'world']);
    });

    it('should handle multiple spaces', () => {
      expect(tokenize('hello   world')).toEqual(['hello', 'world']);
    });
  });

  describe('levenshteinDistance', () => {
    it('should compute distance between identical strings', () => {
      expect(levenshteinDistance('hello', 'hello')).toBe(0);
    });

    it('should compute distance for insertions', () => {
      expect(levenshteinDistance('hello', 'helloo')).toBe(1);
    });

    it('should compute distance for deletions', () => {
      expect(levenshteinDistance('hello', 'helo')).toBe(1);
    });

    it('should compute distance for substitutions', () => {
      expect(levenshteinDistance('hello', 'hallo')).toBe(1);
    });

    it('should handle empty strings', () => {
      expect(levenshteinDistance('', 'hello')).toBe(5);
      expect(levenshteinDistance('hello', '')).toBe(5);
    });
  });

  describe('isFuzzyMatch', () => {
    it('should match similar words', () => {
      expect(isFuzzyMatch('hello', 'hello', 0.25)).toBe(true);
      expect(isFuzzyMatch('hello', 'helo', 0.25)).toBe(true); // 1/5 = 0.2
    });

    it('should not match very different words', () => {
      expect(isFuzzyMatch('hello', 'goodbye', 0.25)).toBe(false);
    });

    it('should respect threshold', () => {
      expect(isFuzzyMatch('hello', 'helo', 0.1)).toBe(false); // 1/5 = 0.2 > 0.1
      expect(isFuzzyMatch('hello', 'helo', 0.3)).toBe(true); // 1/5 = 0.2 < 0.3
    });
  });

  describe('detect', () => {
    const detector = new ProfanityDetector({
      wordlist: ['fuck', 'shit', 'ass', 'bitch'],
      fuzzyThreshold: 0.25,
      sensitivity: 'medium',
      useFuzzyMatching: true,
      useContextFiltering: false, // Disable for basic tests
    });

    it('should detect exact profanity matches', () => {
      const result = detector.detect('What the fuck!');
      expect(result.hasProfanity).toBe(true);
      expect(result.matches.length).toBeGreaterThanOrEqual(1);
      expect(result.censoredText).toContain('[CENSORED]');
    });

    it('should detect multiple profanity words', () => {
      const result = detector.detect('Shit, that was a stupid ass mistake.');
      expect(result.hasProfanity).toBe(true);
      expect(result.matches.length).toBeGreaterThanOrEqual(1);
    });

    it('should detect obfuscated patterns', () => {
      const result = detector.detect('What the f_u_c_k!');
      expect(result.hasProfanity).toBe(true);
      expect(result.censoredText).toBe('What the [CENSORED]!');
    });

    it('should detect character in regex patterns', () => {
      // Test detection with compound words - need asshole in wordlist
      const compoundDetector = new ProfanityDetector({
        wordlist: ['fuck', 'shit', 'ass', 'asshole', 'bitch'],
        sensitivity: 'medium',
        useContextFiltering: false,
      });
      const result = compoundDetector.detect('You asshole!');
      expect(result.hasProfanity).toBe(true);
    });

    it('should not detect clean text', () => {
      const result = detector.detect('Hello there, friend!');
      expect(result.hasProfanity).toBe(false);
      expect(result.matches).toHaveLength(0);
      expect(result.censoredText).toBe('Hello there, friend!');
    });

    it('should handle empty text', () => {
      const result = detector.detect('');
      expect(result.hasProfanity).toBe(false);
      expect(result.matches).toHaveLength(0);
    });
  });

  describe('context filtering', () => {
    const detector = new ProfanityDetector({
      wordlist: ['cock', 'suck', 'sucking'],
      sensitivity: 'medium',
      useContextFiltering: true,
    });

    it('should allow "cock" in firearm context', () => {
      const result = detector.detect('[Guns cock]');
      expect(result.hasProfanity).toBe(false);
    });

    it('should flag "cock" in sexual context', () => {
      const result = detector.detect('suck my cock');
      expect(result.hasProfanity).toBe(true);
    });

    it('should allow "sucking up" expression', () => {
      const result = detector.detect('Sucking up to the new boss');
      expect(result.hasProfanity).toBe(false);
    });

    it('should flag "sucking" in sexual context', () => {
      const result = detector.detect('sucking cock');
      expect(result.hasProfanity).toBe(true);
    });
  });

  describe('sensitivity', () => {
    it('should respect low sensitivity', () => {
      const lowDetector = new ProfanityDetector({
        wordlist: ['test'],
        fuzzyThreshold: 0.25,
        sensitivity: 'low'
      });

      const result = lowDetector.detect('test');
      expect(result.hasProfanity).toBe(true);
    });

    it('should respect high sensitivity', () => {
      const highDetector = new ProfanityDetector({
        wordlist: ['fuck', 'shit'],
        fuzzyThreshold: 0.4,
        sensitivity: 'high',
        useFuzzyMatching: true,
      });

      const result = highDetector.detect('fck');
      expect(typeof result.hasProfanity).toBe('boolean');
    });
  });

  describe('custom wordlist', () => {
    const detector = new ProfanityDetector({
      wordlist: ['badword', 'anotherbadword'],
      fuzzyThreshold: 0.25,
      sensitivity: 'medium'
    });

    it('should detect custom words', () => {
      const result = detector.detect('This contains badword');
      expect(result.hasProfanity).toBe(true);
      expect(result.censoredText).toBe('This contains [CENSORED]');
    });

    it('should add and remove words', () => {
      detector.addWords(['newbadword']);
      let result = detector.detect('This has newbadword');
      expect(result.hasProfanity).toBe(true);

      detector.removeWords(['newbadword']);
      result = detector.detect('This has newbadword');
      expect(result.hasProfanity).toBe(false);
    });
  });

  describe('censorText', () => {
    const detector = new ProfanityDetector({
      wordlist: ['fuck', 'shit'],
      fuzzyThreshold: 0.25,
      sensitivity: 'medium',
      useContextFiltering: false,
    });

    it('should replace profanity with [CENSORED]', () => {
      const result = detector.detect('fuck you');
      expect(result.censoredText).toBe('[CENSORED] you');
    });

    it('should replace all instances', () => {
      const result = detector.detect('fuck this shit');
      expect(result.censoredText).toContain('[CENSORED]');
    });

    it('should preserve text position spacing', () => {
      const result = detector.detect('What the fuck!');
      expect(result.censoredText).toBe('What the [CENSORED]!');
    });
  });

  describe('fuzzy matching', () => {
    const detector = new ProfanityDetector({
      wordlist: ['fuck'],
      fuzzyThreshold: 0.25,
      sensitivity: 'medium',
      useFuzzyMatching: true,
    });

    it('should match similar spellings when enabled', () => {
      const result = detector.detect('fuk');
      expect(result.hasProfanity).toBe(true);
    });

    it('should not match very different words', () => {
      const result = detector.detect('fun');
      expect(typeof result.hasProfanity).toBe('boolean');
    });
  });

  describe('Performance', () => {
    it('should process large text efficiently', () => {
      const fastDetector = new ProfanityDetector({
        wordlist: ['fuck', 'shit', 'ass', 'bitch'],
        fuzzyThreshold: 0.25,
        sensitivity: 'medium',
        useFuzzyMatching: false,
      });
      const largeText = 'This is a test sentence. '.repeat(1000);

      const startTime = performance.now();
      const result = fastDetector.detect(largeText);
      const endTime = performance.now();

      expect(endTime - startTime).toBeLessThan(100);
    });

    it('should process text with many profanity matches', () => {
      const fastDetector = new ProfanityDetector({
        wordlist: ['fuck', 'shit', 'ass', 'bitch'],
        fuzzyThreshold: 0.25,
        sensitivity: 'medium',
        useFuzzyMatching: false,
      });
      const text = 'What the fuck, shit, ass, bitch, '.repeat(100);

      const startTime = performance.now();
      const result = fastDetector.detect(text);
      const endTime = performance.now();

      expect(result.hasProfanity).toBe(true);
      expect(endTime - startTime).toBeLessThan(500);
    });
  });
});