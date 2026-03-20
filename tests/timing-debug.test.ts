import { describe, it, expect } from 'vitest';
import { estimateWordTiming, countSyllables, countTotalSyllables, computeProfanityWindows } from '../src/lib/detector';

describe('Word timing estimation for bullshit', () => {
  it('should correctly estimate timing for "bullshit" in the cue', () => {
    // Cue 231 from the SRT file
    // 231
    // 00:14:22,360 --> 00:14:25,796
    // Lately, we're putting out more bullshit
    // than air freshener.

    const cueText = "Lately, we're putting out more bullshit\nthan air freshener.";

    // Parse timestamps correctly
    // 00:14:22,360 = 14*60*1000 + 22*1000 + 360 = 840000 + 22000 + 360 = 862360 ms
    // 00:14:25,796 = 14*60*1000 + 25*1000 + 796 = 840000 + 25000 + 796 = 865796 ms
    const cueStartMs = 14 * 60 * 1000 + 22 * 1000 + 360; // 862360 ms
    const cueEndMs = 14 * 60 * 1000 + 25 * 1000 + 796;   // 865796 ms

    console.log('Cue text:', cueText);
    console.log('Cue start:', cueStartMs, 'ms (00:14:22,360)');
    console.log('Cue end:', cueEndMs, 'ms (00:14:25,796)');
    console.log('Duration:', (cueEndMs - cueStartMs), 'ms');

    // Count syllables
    const totalSyllables = countTotalSyllables(cueText);
    console.log('Total syllables:', totalSyllables);

    // Find 'bullshit' position
    const wordStartIndex = cueText.toLowerCase().indexOf('bullshit');
    console.log('"bullshit" character position:', wordStartIndex);

    // List all words
    const words = cueText.split(/\s+/).filter(w => w.length > 0);
    console.log('\nWord breakdown:');
    let cumSyllables = 0;
    for (const w of words) {
      const syl = countSyllables(w);
      console.log(`  ${w}: ${syl} syllables (cumulative before: ${cumSyllables})`);
      cumSyllables += syl;
    }

    // Compute timing
    const timing = estimateWordTiming(cueStartMs, cueEndMs, cueText, 'bullshit', wordStartIndex);
    console.log('\nEstimated word timing:');
    console.log('  Word starts at:', timing.wordStartMs, 'ms');
    console.log('  Word ends at:', timing.wordEndMs, 'ms');
    console.log('  Word duration:', timing.wordEndMs - timing.wordStartMs, 'ms');

    // Create a fake match object
    const matches = [{ word: 'bullshit', startIndex: wordStartIndex, endIndex: wordStartIndex + 'bullshit'.length }];

    const windows = computeProfanityWindows(231, cueStartMs, cueEndMs, cueText, matches as any, 'medium');
    console.log('\nProfanity windows:', windows);

    // Buffer values for medium mode
    const bufferBefore = 400;
    const bufferAfter = 300;

    console.log('\nWith MEDIUM mode buffers:');
    console.log('  Buffer before:', bufferBefore, 'ms');
    console.log('  Buffer after:', bufferAfter, 'ms');
    console.log('  Window start:', windows[0].startMs, 'ms');
    console.log('  Window end:', windows[0].endMs, 'ms');
    console.log('  Window duration:', windows[0].endMs - windows[0].startMs, 'ms');

    // Verify window
    expect(wordStartIndex).toBeGreaterThan(0); // Position should be positive
    expect(timing.wordStartMs).toBeGreaterThan(cueStartMs); // Word starts after cue start
    expect(timing.wordEndMs).toBeLessThan(cueEndMs); // Word ends before cue end

    // Window should extend before word start and after word end with buffers
    expect(windows[0].startMs).toBeLessThan(windows[0].wordStartMs);
    expect(windows[0].endMs).toBeGreaterThan(windows[0].wordEndMs);

    expect(windows.length).toBe(1);
    expect(windows[0].word).toBe('bullshit');
    // Window should be within cue bounds
    expect(windows[0].startMs).toBeGreaterThanOrEqual(cueStartMs);
    expect(windows[0].endMs).toBeLessThanOrEqual(cueEndMs);
  });

  it('should detect profanity window correctly for bullshit at various playback times', () => {
    const cueText = "Lately, we're putting out more bullshit\nthan air freshener.";
    const cueStartMs = 862360; // 00:14:22,360
    const cueEndMs = 865796;   // 00:14:25,796

    const wordStartIndex = cueText.toLowerCase().indexOf('bullshit');
    const matches = [{ word: 'bullshit', startIndex: wordStartIndex, endIndex: wordStartIndex + 'bullshit'.length }];
    const windows = computeProfanityWindows(231, cueStartMs, cueEndMs, cueText, matches as any, 'medium');

    console.log('\nPlayback timing test:');
    console.log('Window:', windows[0]);

    // Test various playback times
    const testTimes = [
      { time: 862000, label: 'Before cue starts' },
      { time: 862360, label: 'Cue starts' },
      { time: 863500, label: 'Before bullshit' },
      { time: 864000, label: 'Near start of bullshit word' },
      { time: 864200, label: 'During bullshit word' },
      { time: 864500, label: 'After bullshit word' },
      { time: 865000, label: 'Near end of cue' },
      { time: 865796, label: 'Cue ends' },
    ];

    for (const test of testTimes) {
      const inWindow = test.time >= windows[0].startMs && test.time <= windows[0].endMs;
      console.log(`  ${test.time}ms (${test.label}): ${inWindow ? 'IN WINDOW (should mute)' : 'OUTSIDE window'}`);
    }

    // Key assertion: The window should cover when "bullshit" is being spoken
    // Verify the window is computed correctly
    expect(windows[0].startMs).toBeLessThan(windows[0].wordStartMs);
    expect(windows[0].endMs).toBeGreaterThan(windows[0].wordEndMs);
  });
});