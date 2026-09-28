import { describe, it, expect } from "vitest";
import { CueIndex } from "../src/lib/cueIndex";
import type { Cue } from "../src/types";

function cue(id: number, startMs: number, endMs: number, text = `cue-${id}`): Cue {
  return {
    id,
    startMs,
    endMs,
    text,
    censoredText: text,
    hasProfanity: false,
    profanityScore: 0,
    profanityMatches: [],
  };
}

describe("CueIndex.findCueForAnchor", () => {
  it("returns the cue containing the time", () => {
    const idx = new CueIndex();
    idx.build([cue(1, 0, 5000), cue(2, 6000, 10000), cue(3, 12000, 15000)]);
    expect(idx.findCueForAnchor(7000)?.id).toBe(2);
  });

  it("returns the next cue when between cues", () => {
    const idx = new CueIndex();
    idx.build([cue(1, 0, 5000), cue(2, 6000, 10000)]);
    // 5.5s is in the gap: next cue to appear is cue 2
    expect(idx.findCueForAnchor(5500)?.id).toBe(2);
  });

  it("returns the first cue before the start", () => {
    const idx = new CueIndex();
    idx.build([cue(1, 10000, 15000), cue(2, 20000, 25000)]);
    expect(idx.findCueForAnchor(5000)?.id).toBe(1);
  });

  it("returns null for empty index", () => {
    const idx = new CueIndex();
    expect(idx.findCueForAnchor(5000)).toBeNull();
  });

  it("returns the last cue when past the end", () => {
    const idx = new CueIndex();
    idx.build([cue(1, 0, 5000), cue(2, 6000, 10000)]);
    expect(idx.findCueForAnchor(15000)?.id).toBe(2);
  });
});