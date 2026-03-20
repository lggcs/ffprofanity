import { describe, it, expect } from 'vitest';
import { CueIndex } from '../src/lib/cueIndex';
import type { Cue, ProfanityWindow } from '../src/types';
import { computeProfanityWindows } from '../src/lib/detector';

describe('CueIndex profanity window search', () => {
  it('should find profanity window at correct playback time', () => {
    // Create a test cue with the "bullshit" line
    const cue: Cue = {
      id: 231,
      startMs: 862360, // 00:14:22,360
      endMs: 865796,   // 00:14:25,796
      text: "Lately, we're putting out more bullshit\nthan air freshener.",
      censoredText: "Lately, we're putting out more [CENSORED]\nthan air freshener.",
      hasProfanity: true,
      profanityScore: 100,
      profanityMatches: [{ word: 'bullshit', startIndex: 31, endIndex: 39 }],
    };
    
    // Compute profanity windows (medium sensitivity)
    const windows = computeProfanityWindows(
      cue.id,
      cue.startMs,
      cue.endMs,
      cue.text,
      cue.profanityMatches || [],
      'medium'
    );
    
    cue.profanityWindows = windows;
    console.log('Computed windows:', windows);
    
    // Create index
    const index = new CueIndex();
    index.build([cue]);
    
    // Test times around the window
    const window = windows[0];
    
    // Before window - should NOT mute
    const beforeWindow = index.findProfanityWindow(window.startMs - 100, 0);
    expect(beforeWindow).toBeNull();
    console.log(`At ${window.startMs - 100}ms (before window):`, beforeWindow);
    
    // At window start - should mute
    const atStart = index.findProfanityWindow(window.startMs, 0);
    expect(atStart).not.toBeNull();
    expect(atStart?.word).toBe('bullshit');
    console.log(`At ${window.startMs}ms (window start):`, atStart);
    
    // Middle of window - should mute
    const middleMs = Math.floor((window.startMs + window.endMs) / 2);
    const middle = index.findProfanityWindow(middleMs, 0);
    expect(middle).not.toBeNull();
    expect(middle?.word).toBe('bullshit');
    console.log(`At ${middleMs}ms (middle):`, middle);
    
    // At window end - should mute
    const atEnd = index.findProfanityWindow(window.endMs, 0);
    expect(atEnd).not.toBeNull();
    console.log(`At ${window.endMs}ms (window end):`, atEnd);
    
    // After window - should NOT mute
    const afterWindow = index.findProfanityWindow(window.endMs + 1, 0);
    expect(afterWindow).toBeNull();
    console.log(`At ${window.endMs + 1}ms (after window):`, afterWindow);
  });
  
  it('should correctly get mute state for medium sensitivity', () => {
    const cue: Cue = {
      id: 231,
      startMs: 862360,
      endMs: 865796,
      text: "Lately, we're putting out more bullshit\nthan air freshener.",
      censoredText: "Lately, we're putting out more [CENSORED]\nthan air freshener.",
      hasProfanity: true,
      profanityScore: 100,
      profanityMatches: [{ word: 'bullshit', startIndex: 31, endIndex: 39 }],
    };
    
    const windows = computeProfanityWindows(
      cue.id,
      cue.startMs,
      cue.endMs,
      cue.text,
      cue.profanityMatches || [],
      'medium'
    );
    cue.profanityWindows = windows;
    
    const index = new CueIndex();
    index.build([cue]);
    
    // Test getMuteState
    const window = windows[0];
    
    // Before the mute window
    const before = index.getMuteState(window.startMs - 100, 0, 'medium');
    expect(before.shouldMute).toBe(false);
    
    // During the mute window
    const during = index.getMuteState(window.startMs + 100, 0, 'medium');
    expect(during.shouldMute).toBe(true);
    expect(during.window?.word).toBe('bullshit');
    
    // After the mute window
    const after = index.getMuteState(window.endMs + 100, 0, 'medium');
    expect(after.shouldMute).toBe(false);
  });
  
  it('should handle multiple profanity windows correctly', () => {
    // Cue with multiple profanity words
    const cue: Cue = {
      id: 1,
      startMs: 1000,
      endMs: 5000,
      text: "This is bullshit and damn this shit is bad",
      censoredText: "This is [CENSORED] and [CENSORED] this [CENSORED] is bad",
      hasProfanity: true,
      profanityScore: 100,
      profanityMatches: [
        { word: 'bullshit', startIndex: 8, endIndex: 16 },
        { word: 'damn', startIndex: 21, endIndex: 25 },
        { word: 'shit', startIndex: 31, endIndex: 35 },
      ],
    };
    
    const windows = computeProfanityWindows(
      cue.id,
      cue.startMs,
      cue.endMs,
      cue.text,
      cue.profanityMatches || [],
      'medium'
    );
    cue.profanityWindows = windows;
    
    console.log('Multiple windows:', windows);
    
    const index = new CueIndex();
    index.build([cue]);
    
    // Should correctly find each window
    expect(windows.length).toBe(3);
    
    // Test that we find windows at various times
    // Note: With larger buffers, windows may overlap
    for (const w of windows) {
      // At middle of word should definitely be in window
      const middleTime = Math.floor((w.wordStartMs + w.wordEndMs) / 2);
      const atMiddle = index.getMuteState(middleTime, 0, 'medium');
      expect(atMiddle.shouldMute).toBe(true);
      console.log(`At middle of '${w.word}' (${middleTime}ms): muted=${atMiddle.shouldMute}`);
    }
    
    // Before all windows should not be muted
    const beforeAll = index.getMuteState(500, 0, 'medium');
    expect(beforeAll.shouldMute).toBe(false);
    
    // After all windows should not be muted
    const afterAll = index.getMuteState(4800, 0, 'medium');
    expect(afterAll.shouldMute).toBe(false);
  });
});