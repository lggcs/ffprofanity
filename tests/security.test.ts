/**
 * Security Tests
 * Tests for XSS prevention, SSRF protection, input validation,
 * parser robustness, and sanitization.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeText, parseSubtitle, detectFormat } from '../src/lib/parser';
import { ProfanityDetector, createDetector, normalizeText } from '../src/lib/detector';

// ─── sanitizeText ───────────────────────────────────────────────────────────

describe('sanitizeText', () => {
  it('should strip script tags', () => {
    // Tags are stripped but text content between tags is preserved
    // (it's harmless plain text outside of an HTML context)
    expect(sanitizeText('<script>alert("xss")</script>')).toBe('alert("xss")');
  });

  it('should strip img tags with onerror', () => {
    expect(sanitizeText('<img src=x onerror=alert(1)>')).toBe('');
  });

  it('should strip svg onload', () => {
    expect(sanitizeText('<svg onload=alert(1)>test</svg>')).toBe('test');
  });

  it('should strip VTT formatting tags', () => {
    expect(sanitizeText('<i>italic</i>')).toBe('italic');
    expect(sanitizeText('<b>bold</b>')).toBe('bold');
    expect(sanitizeText('<u>underline</u>')).toBe('underline');
  });

  it('should strip VTT class tags', () => {
    expect(sanitizeText('<c.red>colored</c>')).toBe('colored');
  });

  it('should strip VTT voice tags', () => {
    expect(sanitizeText('<v Speaker>Name</v>')).toBe('Name');
  });

  it('should strip VTT lang tags', () => {
    expect(sanitizeText('<lang en>text</lang>')).toBe('text');
  });

  it('should strip font tags with attributes', () => {
    expect(sanitizeText('<font color="white">text</font>')).toBe('text');
  });

  it('should strip ASS/SSA override tags', () => {
    expect(sanitizeText('{\\b1}bold{\\b0}')).toBe('bold');
    expect(sanitizeText('{\\i1}italic{\\i0}')).toBe('italic');
    expect(sanitizeText('{\\pos(100,200)}positioned')).toBe('positioned');
  });

  it('should strip NULL bytes and control characters', () => {
    expect(sanitizeText('hello\x00world')).toBe('helloworld');
    expect(sanitizeText('test\x01control\x02chars')).toBe('testcontrolchars');
  });

  it('should preserve newlines and tabs', () => {
    expect(sanitizeText('line1\nline2')).toBe('line1\nline2');
    expect(sanitizeText('col1\tcol2')).toBe('col1\tcol2');
  });

  it('should preserve plain text without tags', () => {
    expect(sanitizeText('Hello, world!')).toBe('Hello, world!');
  });

  it('should handle empty string', () => {
    expect(sanitizeText('')).toBe('');
  });

  it('should handle deeply nested tags', () => {
    expect(sanitizeText('<b><i><u>nested</u></i></b>')).toBe('nested');
  });

  it('should strip Unicode replacement character', () => {
    expect(sanitizeText('hello\uFFFDworld')).toBe('helloworld');
  });

  it('should strip event handler attributes', () => {
    expect(sanitizeText('<div onmouseover=alert(1)>text</div>')).toBe('text');
  });

  it('should handle malformed/incomplete tags', () => {
    // Unclosed tag — the regex strips <...> including incomplete tags
    expect(sanitizeText('<img src=x')).toBe('');
  });
});

// ─── Parser robustness ───────────────────────────────────────────────────────

describe('Parser security robustness', () => {
  it('should handle SRT with embedded script tags', () => {
    const srtContent = `1
00:00:01,000 --> 00:00:04,000
<script>alert('xss')</script>

2
00:00:05,000 --> 00:00:08,000
Normal subtitle text`;
    const result = parseSubtitle(srtContent);
    expect(result.cues.length).toBeGreaterThan(0);
    // Parser or sanitizeText should strip the tags;
    // the content between tags may remain as harmless text
    const firstCue = result.cues[0];
    expect(firstCue).toBeDefined();
    // The cue text should NOT contain the script tags
    expect(firstCue!.text).not.toContain('<script>');
    expect(firstCue!.text).not.toContain('</script>');
  });

  it('should handle extremely large timestamp values without crashing', () => {
    const srtContent = `1
99:99:99,999 --> 99:99:99,999
Overflow timestamps`;
    // Should not throw
    const result = parseSubtitle(srtContent);
    expect(result).toBeDefined();
  });

  it('should handle negative timestamp gracefully', () => {
    const srtContent = `1
-01:00:01,000 --> 00:00:04,000
Negative start`;
    const result = parseSubtitle(srtContent);
    expect(result).toBeDefined();
  });

  it('should handle empty file', () => {
    const result = parseSubtitle('');
    expect(result.cues).toHaveLength(0);
  });

  it('should handle binary/null content', () => {
    const binaryContent = '\x00\x01\x02\x03\x04\x05';
    const result = parseSubtitle(binaryContent);
    expect(result).toBeDefined();
  });

  it('should handle very long single cue text', () => {
    const longText = 'A'.repeat(100000);
    const srtContent = `1
00:00:01,000 --> 00:00:04,000
${longText}`;
    const result = parseSubtitle(srtContent);
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0]?.text?.length).toBeGreaterThan(0);
  });

  it('should handle SRT with BOM', () => {
    const bomSrt = '\uFEFF1\n00:00:01,000 --> 00:00:04,000\nBOM test';
    const result = parseSubtitle(bomSrt);
    expect(result).toBeDefined();
  });

  it('should handle mixed line endings (CRLF/LF)', () => {
    const srtContent = '1\r\n00:00:01,000 --> 00:00:04,000\r\nCRLF test\r\n\r\n2\n00:00:05,000 --> 00:00:08,000\nLF test';
    const result = parseSubtitle(srtContent);
    expect(result.cues.length).toBeGreaterThan(0);
  });
});

// ─── Profanity detection edge cases ──────────────────────────────────────────

describe('Profanity detector security', () => {
  let detector: ProfanityDetector;

  beforeEach(() => {
    detector = createDetector();
  });

  it('should handle empty strings', () => {
    const result = detector.detect('');
    expect(result.matches).toHaveLength(0);
  });

  it('should handle very long strings without ReDoS', () => {
    // Build a string that could trigger catastrophic backtracking
    // on poorly written regexes: many characters that look like
    // they could start a profanity word but don't complete it
    const longString = 'f'.repeat(10000) + ' not a match';
    const start = performance.now();
    const result = detector.detect(longString);
    const elapsed = performance.now() - start;
    // Should complete in under 1 second (generous for ReDoS)
    expect(elapsed).toBeLessThan(1000);
    expect(result).toBeDefined();
  });

  it('should handle Unicode strings', () => {
    const result = detector.detect('你好世界 hello');
    expect(result).toBeDefined();
  });

  it('should handle strings with only punctuation', () => {
    const result = detector.detect('!@#$%^&*()_+{}[]|\\:";\'<>?,./');
    expect(result).toBeDefined();
    expect(result.matches).toHaveLength(0);
  });

  it('should handle null bytes in input', () => {
    const result = detector.detect('hell\x00o world');
    expect(result).toBeDefined();
  });
});

// ─── normalizeText ───────────────────────────────────────────────────────────

describe('normalizeText', () => {
  it('should handle leet-speak substitutions', () => {
    expect(normalizeText('4ss')).toBe('ass');
    expect(normalizeText('5h1t')).toBe('shit');
    expect(normalizeText('@$$')).toBe('ass');
  });

  it('should not modify strings that are already normalized', () => {
    expect(normalizeText('hello')).toBe('hello');
  });

  it('should handle empty strings', () => {
    expect(normalizeText('')).toBe('');
  });
});

// ─── SSRF URL validation ─────────────────────────────────────────────────────
// (These test the logic pattern; actual background tests need browser APIs)

describe('SSRF URL validation logic', () => {
  const ALLOWED_PROTOCOLS = ['http:', 'https:'];

  function isValidFetchUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return ALLOWED_PROTOCOLS.includes(parsed.protocol);
    } catch {
      return false;
    }
  }

  it('should allow HTTPS URLs', () => {
    expect(isValidFetchUrl('https://example.com/subs.vtt')).toBe(true);
  });

  it('should allow HTTP URLs', () => {
    expect(isValidFetchUrl('http://example.com/subs.vtt')).toBe(true);
  });

  it('should reject file:// URLs', () => {
    expect(isValidFetchUrl('file:///etc/passwd')).toBe(false);
  });

  it('should reject javascript: URLs', () => {
    expect(isValidFetchUrl('javascript:alert(1)')).toBe(false);
  });

  it('should reject data: URLs', () => {
    expect(isValidFetchUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('should reject ftp:// URLs', () => {
    expect(isValidFetchUrl('ftp://evil.com/payload')).toBe(false);
  });

  it('should reject malformed URLs', () => {
    expect(isValidFetchUrl('not-a-url')).toBe(false);
  });

  it('should reject empty URLs', () => {
    expect(isValidFetchUrl('')).toBe(false);
  });
});