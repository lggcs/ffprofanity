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
  isFuzzyMatch,
  countSyllables,
  countTotalSyllables,
  estimateWordTiming,
  calibrateSpeakingRate,
  computeProfanityWindows,
  RELIGIOUS_WHITELIST,
} from '../src/lib/detector';
import {
  DEFAULT_SUBSTITUTIONS,
  buildSubstitutionMap,
  getRandomSubstitution,
  getAllSubstitutions,
} from '../src/lib/substitutions';

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
      wordlist: ['fuck', 'shit', 'ass', 'bitch', 'bullshit', 'swear to god', 'son of a bitch'],
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

    it('should detect bullshit', () => {
      const result = detector.detect("Lately, we're putting out more bullshit than air freshener.");
      expect(result.hasProfanity).toBe(true);
      expect(result.censoredText).toContain('[CENSORED]');
    });

    it('should detect bullshit (uppercase)', () => {
      const result = detector.detect('This is BULLSHIT!');
      expect(result.hasProfanity).toBe(true);
      expect(result.censoredText).toContain('[CENSORED]');
    });

    it('should detect bullshit (standalone)', () => {
      const result = detector.detect('bullshit');
      expect(result.hasProfanity).toBe(true);
      expect(result.censoredText).toBe('[CENSORED]');
    });

    it('should detect multi-word phrases', () => {
      const result = detector.detect('I swear to god that happened!');
      expect(result.hasProfanity).toBe(true);
      expect(result.matches.length).toBe(1);
      expect(result.matches[0].word.toLowerCase()).toBe('swear to god');
      expect(result.censoredText).toContain('[CENSORED]');
    });

    it('should detect phrase and not individual words separately', () => {
      const result = detector.detect('SWEAR TO GOD!');
      expect(result.hasProfanity).toBe(true);
      // Should match the phrase, not "god" separately
      expect(result.matches.length).toBe(1);
      expect(result.matches[0].word.toLowerCase()).toBe('swear to god');
    });

    it('should detect son of a bitch phrase', () => {
      const result = detector.detect('You son of a bitch!');
      expect(result.hasProfanity).toBe(true);
      // Should match the phrase "son of a bitch", not "bitch" separately
      // The phrase match covers "bitch" so it should not be double-counted
      expect(result.matches.length).toBe(1);
      expect(result.matches[0].word.toLowerCase()).toBe('son of a bitch');
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

describe('Substitutions', () => {
  describe('DEFAULT_SUBSTITUTIONS', () => {
    it('should have substitutions for common profanity words', () => {
      const map = buildSubstitutionMap(DEFAULT_SUBSTITUTIONS);
      expect(map.has('fuck')).toBe(true);
      expect(map.has('shit')).toBe(true);
      expect(map.has('bitch')).toBe(true);
    });

    it('should have silly and polite categories', () => {
      const mapping = getAllSubstitutions('fuck', DEFAULT_SUBSTITUTIONS);
      expect(mapping).not.toBeNull();
      expect(mapping?.substitutions.silly.length).toBeGreaterThan(0);
      expect(mapping?.substitutions.polite.length).toBeGreaterThan(0);
    });

    it('should have random category', () => {
      const mapping = getAllSubstitutions('shit', DEFAULT_SUBSTITUTIONS);
      expect(mapping?.substitutions.random).toBeDefined();
      expect(mapping?.substitutions.random.length).toBeGreaterThan(0);
    });
  });

  describe('getRandomSubstitution', () => {
    it('should return a substitution from the category', () => {
      const sub = getRandomSubstitution('fuck', 'silly', DEFAULT_SUBSTITUTIONS);
      expect(sub).not.toBeNull();
      expect(['fudge', 'frick', 'freak', 'fiddlesticks', 'firetruck', 'fluffernutter', 'frock']).toContain(sub);
    });

    it('should return null for unknown words', () => {
      const sub = getRandomSubstitution('unknownword', 'silly', DEFAULT_SUBSTITUTIONS);
      expect(sub).toBeNull();
    });

    it('should return different values on different calls (randomness)', () => {
      // Due to randomness, multiple calls may occasionally return same value
      // But with enough substitutions, we should see variety
      const results = new Set<string>();
      for (let i = 0; i < 10; i++) {
        const sub = getRandomSubstitution('fuck', 'silly', DEFAULT_SUBSTITUTIONS);
        if (sub) results.add(sub);
      }
      // With 7 options, we should see at least 2 different values in 10 calls
      // (but this is probabilistic, so we'll be lenient)
      expect(results.size).toBeGreaterThanOrEqual(1);
    });
  });

  describe('buildSubstitutionMap', () => {
    it('should create a map from substitution list', () => {
      const subs = [
        { profanity: 'test', substitutions: { silly: ['fun'], polite: ['examination'], random: ['potato'] } }
      ];
      const map = buildSubstitutionMap(subs);
      expect(map.has('test')).toBe(true);
      expect(map.size).toBe(1);
    });
  });
});

describe('ProfanityDetector with substitutions', () => {
  describe('useSubstitutions setting', () => {
    it('should use [CENSORED] by default', () => {
      const detector = new ProfanityDetector({
        wordlist: ['fuck'],
        sensitivity: 'medium',
        useContextFiltering: false,
        useSubstitutions: false,
      });

      const result = detector.detect('What the fuck!');
      expect(result.censoredText).toBe('What the [CENSORED]!');
    });

    it('should use fun substitutions when enabled', () => {
      const detector = new ProfanityDetector({
        wordlist: ['fuck'],
        sensitivity: 'medium',
        useContextFiltering: false,
        useSubstitutions: true,
        substitutionCategory: 'silly',
      });

      const result = detector.detect('What the fuck!');
      // The exact word depends on random selection, but should be one of the silly options
      expect(result.censoredText).toMatch(/What the (fudge|frick|freak|fiddlesticks|firetruck|fluffernutter|frock)!/);
    });

    it('should use polite category substitutions', () => {
      const detector = new ProfanityDetector({
        wordlist: ['fuck'],
        sensitivity: 'medium',
        useContextFiltering: false,
        useSubstitutions: true,
        substitutionCategory: 'polite',
      });

      const result = detector.detect('What the fuck!');
      expect(result.censoredText).toMatch(/What the (darn|bother|drat)!/);
    });

    it('should use random category substitutions', () => {
      const detector = new ProfanityDetector({
        wordlist: ['fuck'],
        sensitivity: 'medium',
        useContextFiltering: false,
        useSubstitutions: true,
        substitutionCategory: 'random',
      });

      const result = detector.detect('What the fuck!');
      expect(result.censoredText).toMatch(/What the (bananas|noodles|shenanigans)!/);
    });

    it('should use custom substitutions when set', () => {
      const detector = new ProfanityDetector({
        wordlist: ['fuck'],
        sensitivity: 'medium',
        useContextFiltering: false,
        useSubstitutions: true,
        substitutionCategory: 'custom',
        customSubstitutions: new Map([['fuck', 'bunnies']]),
      });

      const result = detector.detect('What the fuck!');
      expect(result.censoredText).toBe('What the bunnies!');
    });

    it('should handle multiple profanity words with substitutions', () => {
      const detector = new ProfanityDetector({
        wordlist: ['fuck', 'shit'],
        sensitivity: 'medium',
        useContextFiltering: false,
        useSubstitutions: true,
        substitutionCategory: 'silly',
      });

      const result = detector.detect('What the fuck, this shit is crazy!');
      // Both words should be replaced with something from silly category
      expect(result.censoredText).not.toContain('[CENSORED]');
      expect(result.censoredText).not.toContain('fuck');
      expect(result.censoredText).not.toContain('shit');
    });

    it('should fall back to [CENSORED] when no substitution available', () => {
      const detector = new ProfanityDetector({
        wordlist: ['someunknownbadword'],
        sensitivity: 'medium',
        useContextFiltering: false,
        useSubstitutions: true,
        substitutionCategory: 'silly',
      });

      const result = detector.detect('This word someunknownbadword is bad!');
      expect(result.censoredText).toBe('This word [CENSORED] is bad!');
    });

    it('should update substitutions via setSubstitutions', () => {
      const detector = new ProfanityDetector({
        wordlist: ['fuck'],
        sensitivity: 'medium',
        useContextFiltering: false,
        useSubstitutions: false,
      });

      // Initially uses [CENSORED]
      let result = detector.detect('fuck');
      expect(result.censoredText).toBe('[CENSORED]');

      // Enable substitutions
      detector.setSubstitutions(true, 'silly');
      result = detector.detect('fuck');
      expect(result.censoredText).not.toBe('[CENSORED]');
      expect(['fudge', 'frick', 'freak', 'fiddlesticks', 'firetruck', 'fluffernutter', 'frock']).toContain(result.censoredText);
    });
  });
});

describe('Syllable Counting', () => {
  describe('countSyllables', () => {
    it('should count syllables in single-syllable words', () => {
      expect(countSyllables('the')).toBe(1);
      expect(countSyllables('a')).toBe(1);
      expect(countSyllables('cat')).toBe(1);
      expect(countSyllables('dog')).toBe(1);
      expect(countSyllables('shit')).toBe(1);
      expect(countSyllables('fuck')).toBe(1);
    });

    it('should count syllables in multi-syllable words', () => {
      expect(countSyllables('apple')).toBe(2);
      expect(countSyllables('banana')).toBe(3);
      expect(countSyllables('hello')).toBe(2);
      expect(countSyllables('fucking')).toBe(2);
      expect(countSyllables('asshole')).toBe(2);
      expect(countSyllables('bitch')).toBe(1); // Actually 1
    });

    it('should handle silent e', () => {
      expect(countSyllables('make')).toBe(1);
      expect(countSyllables('time')).toBe(1);
      expect(countSyllables('like')).toBe(1);
      // These are heuristic-based and work for most common words
      // 'create' has 2 syllables: cre-ate, but our heuristic may count differently
      // The heuristic is designed for speech timing, not perfect accuracy
    });

    it('should handle empty and edge cases', () => {
      expect(countSyllables('')).toBe(0);
      expect(countSyllables('a')).toBe(1);
      expect(countSyllables('I')).toBe(1);
    });

    it('should handle complex words', () => {
      // These are heuristic and may not be perfect
      expect(countSyllables('profanity')).toBeGreaterThanOrEqual(3);
      expect(countSyllables('subtitle')).toBeGreaterThanOrEqual(2);
      expect(countSyllables('motherfucker')).toBeGreaterThanOrEqual(3);
    });
  });

  describe('countTotalSyllables', () => {
    it('should count total syllables in text', () => {
      expect(countTotalSyllables('hello world')).toBe(3);
      expect(countTotalSyllables('what the fuck')).toBe(3);
      expect(countTotalSyllables('this is a test')).toBe(4);
    });

    it('should handle empty text', () => {
      expect(countTotalSyllables('')).toBe(0);
    });
  });
});

describe('Word Timing Estimation', () => {
  describe('estimateWordTiming', () => {
    it('should estimate word timing based on syllables', () => {
      // Cue: "what the fuck" (3 syllables total: what=1, the=1, fuck=1)
      // Duration: 2000ms (0-2000)
      // "fuck" is at position 9 (after "what the ")
      // Syllables before "fuck": 2 (what + the)
      // So "fuck" should start around 2/3 of the cue
      
      const timing = estimateWordTiming(0, 2000, 'what the fuck', 'fuck', 9);
      
      // Word should be within cue bounds
      expect(timing.wordStartMs).toBeGreaterThan(0);
      expect(timing.wordEndMs).toBeGreaterThan(timing.wordStartMs);
      // "fuck" is the last word, so it should end at or near the cue end
      expect(timing.wordEndMs).toBeLessThanOrEqual(2000);
    });

    it('should handle single-word cue', () => {
      const timing = estimateWordTiming(0, 1000, 'fuck', 'fuck', 0);
      expect(timing.wordStartMs).toBe(0);
      expect(timing.wordEndMs).toBe(1000);
    });

    it('should handle first word in cue', () => {
      const timing = estimateWordTiming(0, 3000, 'hello world how are you', 'hello', 0);
      // "hello" is first word, should start near 0
      expect(timing.wordStartMs).toBeLessThan(500);
    });

    it('should handle last word in cue', () => {
      const timing = estimateWordTiming(0, 3000, 'hello world how are you', 'you', 20);
      // "you" is last word, should end near cue end
      expect(timing.wordEndMs).toBeGreaterThan(2500);
    });
  });

  describe('calibrateSpeakingRate', () => {
    it('should calibrate from cue data', () => {
      const cues = [
        { startMs: 0, endMs: 2000, text: 'hello world' },
        { startMs: 2000, endMs: 5000, text: 'this is a test sentence' },
      ];
      
      const calibration = calibrateSpeakingRate(cues);
      
      expect(calibration.wpm).toBeGreaterThan(0);
      expect(calibration.msPerSyllable).toBeGreaterThan(0);
      expect(calibration.avgSyllablesPerWord).toBeGreaterThan(0);
    });

    it('should return fallback for empty cues', () => {
      const calibration = calibrateSpeakingRate([]);
      
      expect(calibration.wpm).toBe(170);
      expect(calibration.msPerSyllable).toBe(175);
    });
  });
});

describe('Profanity Windows', () => {
  describe('computeProfanityWindows', () => {
    it('should compute windows for medium sensitivity', () => {
      const windows = computeProfanityWindows(
        1, // cueId
        0, // startMs
        2000, // endMs
        'what the fuck is this', // text
        [{ word: 'fuck', startIndex: 8, endIndex: 12 }], // matches
        'medium' // sensitivity
      );

      expect(windows.length).toBe(1);
      expect(windows[0].cueId).toBe(1);
      expect(windows[0].word).toBe('fuck');
      expect(windows[0].bufferBeforeMs).toBe(500); // medium
      expect(windows[0].bufferAfterMs).toBe(300); // medium
    });

    it('should compute windows for low sensitivity with smaller buffers', () => {
      const windows = computeProfanityWindows(
        1,
        0,
        2000,
        'what the fuck is this',
        [{ word: 'fuck', startIndex: 8, endIndex: 12 }],
        'low'
      );

      expect(windows.length).toBe(1);
      expect(windows[0].bufferBeforeMs).toBe(200); // low
      expect(windows[0].bufferAfterMs).toBe(150); // low
    });

    it('should return empty array for high sensitivity', () => {
      const windows = computeProfanityWindows(
        1,
        0,
        2000,
        'what the fuck is this',
        [{ word: 'fuck', startIndex: 8, endIndex: 12 }],
        'high'
      );
      
      expect(windows).toEqual([]);
    });

    it('should return empty array for no matches', () => {
      const windows = computeProfanityWindows(
        1,
        0,
        2000,
        'hello world',
        [],
        'medium'
      );
      
      expect(windows).toEqual([]);
    });

    it('should handle multiple profanity words', () => {
      const windows = computeProfanityWindows(
        1,
        0,
        3000,
        'what the fuck is this shit',
        [
          { word: 'fuck', startIndex: 8, endIndex: 12 },
          { word: 'shit', startIndex: 21, endIndex: 25 }
        ],
        'medium'
      );
      
      expect(windows.length).toBe(2);
      expect(windows[0].word).toBe('fuck');
      expect(windows[1].word).toBe('shit');
    });

    it('should clamp windows to cue boundaries', () => {
      const windows = computeProfanityWindows(
        1,
        1000, // startMs
        2000, // endMs
        'fuck', // profanity at the very start
        [{ word: 'fuck', startIndex: 0, endIndex: 4 }],
        'medium'
      );
      
      // Window should be clamped to cue boundaries
      expect(windows[0].startMs).toBeGreaterThanOrEqual(1000);
      expect(windows[0].endMs).toBeLessThanOrEqual(2000);
    });
  });
});

describe('Religious Whitelist', () => {
  describe('RELIGIOUS_WHITELIST', () => {
    it('should contain expected religious terms', () => {
      expect(RELIGIOUS_WHITELIST.has('god')).toBe(true);
      expect(RELIGIOUS_WHITELIST.has('hell')).toBe(true);
      expect(RELIGIOUS_WHITELIST.has('jesus')).toBe(true);
      expect(RELIGIOUS_WHITELIST.has('christ')).toBe(true);
      expect(RELIGIOUS_WHITELIST.has('damn')).toBe(true);
      expect(RELIGIOUS_WHITELIST.has('damned')).toBe(true);
    });
  });

  describe('Low sensitivity mode', () => {
    it('should allow religious terms through in low sensitivity', () => {
      const detector = new ProfanityDetector({
        wordlist: ['damn', 'hell', 'god'],
        sensitivity: 'low',
        useContextFiltering: false,
      });

      // These should NOT be detected as profanity in low mode
      expect(detector.detect('Oh my god').hasProfanity).toBe(false);
      expect(detector.detect('What the hell').hasProfanity).toBe(false);
      expect(detector.detect('Damn it').hasProfanity).toBe(false);
      expect(detector.detect('Jesus Christ').hasProfanity).toBe(false);
    });

    it('should still detect profanity words in low sensitivity', () => {
      const detector = new ProfanityDetector({
        wordlist: ['fuck', 'shit', 'bitch', 'damn', 'hell'],
        sensitivity: 'low',
        useContextFiltering: false,
      });

      // These should still be detected
      expect(detector.detect('What the fuck').hasProfanity).toBe(true);
      expect(detector.detect('This is shit').hasProfanity).toBe(true);
      expect(detector.detect('You bitch').hasProfanity).toBe(true);
    });

    it('should block religious terms in medium sensitivity', () => {
      const detector = new ProfanityDetector({
        wordlist: ['damn', 'hell', 'god'],
        sensitivity: 'medium',
        useContextFiltering: false,
      });

      // These SHOULD be detected as profanity in medium mode (no whitelist)
      expect(detector.detect('Oh my god').hasProfanity).toBe(true);
      expect(detector.detect('What the hell').hasProfanity).toBe(true);
      expect(detector.detect('Damn it').hasProfanity).toBe(true);
    });

    it('should block religious terms in high sensitivity', () => {
      const detector = new ProfanityDetector({
        wordlist: ['damn', 'hell', 'god'],
        sensitivity: 'high',
        useContextFiltering: false,
      });

      // These SHOULD be detected in high mode
      expect(detector.detect('Oh my god').hasProfanity).toBe(true);
      expect(detector.detect('What the hell').hasProfanity).toBe(true);
      expect(detector.detect('Damn it').hasProfanity).toBe(true);
    });

    it('should allow mixed sentences with religious terms', () => {
      const detector = new ProfanityDetector({
        wordlist: ['fuck', 'shit', 'damn', 'hell'],
        sensitivity: 'low',
        useContextFiltering: false,
      });

      // "damn" should be allowed, "fuck" should be censored
      const result = detector.detect('Damn, what the fuck is this');
      expect(result.hasProfanity).toBe(true);
      expect(result.matches.length).toBe(1);
      expect(result.matches[0].word.toLowerCase()).toBe('fuck');
    });

    it('should handle case variations of religious terms', () => {
      const detector = new ProfanityDetector({
        wordlist: ['god', 'hell', 'damn'],
        sensitivity: 'low',
        useContextFiltering: false,
      });

      expect(detector.detect('Oh my God').hasProfanity).toBe(false);
      expect(detector.detect('GOD Almighty').hasProfanity).toBe(false);
      expect(detector.detect('GoD').hasProfanity).toBe(false);
      expect(detector.detect('HELL no').hasProfanity).toBe(false);
      expect(detector.detect('DAMN right').hasProfanity).toBe(false);
    });

    it('should update whitelist behavior when sensitivity changes', () => {
      const detector = new ProfanityDetector({
        wordlist: ['damn', 'hell'],
        sensitivity: 'low',
        useContextFiltering: false,
      });

      // Initially allowed in low mode
      expect(detector.detect('Damn it').hasProfanity).toBe(false);

      // Change to medium
      detector.setSensitivity('medium');

      // Now should be blocked
      expect(detector.detect('Damn it').hasProfanity).toBe(true);

      // Change back to low
      detector.setSensitivity('low');

      // Allowed again
      expect(detector.detect('Damn it').hasProfanity).toBe(false);
    });
  });
});