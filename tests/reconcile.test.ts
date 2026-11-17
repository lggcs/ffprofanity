import { describe, it, expect } from "vitest";
import { isNearIdentityFit, reconcileTracks } from "../src/lib/reconcile";
import type { CueLike } from "../src/lib/drift";

// Deterministic jitter so fixtures are stable across runs:
// (i * 37) % (m + 1) − floor((m + 1) / 2)
function jitter(i: number, m: number): number {
  return ((i * 37) % (m + 1)) - Math.floor((m + 1) / 2);
}

const WORDS = ["quiet", "harbor", "lantern", "meadow", "signal", "cobalt", "drift"];
const SPACING_MS = 15000;

function makeCue(i: number, startMs: number): CueLike {
  return {
    startMs,
    endMs: startMs + 2200,
    text: `Take line ${i}, the ${WORDS[i % WORDS.length]} and the ${WORDS[(i * 3) % WORDS.length]} appear tonight`,
  };
}

// Reference track: 40 evenly spaced cues — 39 × 15 s ≈ 9.75 min of span.
const REFERENCE: CueLike[] = Array.from({ length: 40 }, (_, i) =>
  makeCue(i, 5000 + i * SPACING_MS),
);

// The reported lookmovie2 shape: ~4.2 s lead-in plus a 0.1% rate mismatch
// (24.000-fps master against a 23.976 stream), a third of the displayed
// track's cues missing, small segmentation jitter.
const TRUE_RATE = 0.999;
const TRUE_OFFSET = 4230;

const MISTIMED: CueLike[] = REFERENCE.map((cue, i) => {
  // A resync moves the whole cue span, not just the start — leaving endMs on
  // the old timeline would make every cue read as an inverted (end < start)
  // span, which prepare() drops as malformed.
  const startMs = Math.round(TRUE_RATE * cue.startMs + TRUE_OFFSET) + jitter(i, 4) * 40;
  return { ...cue, startMs, endMs: startMs + 2200 };
}).filter((_, i) => i % 3 !== 2);

// Same transform without the missing cues (for the truncation-gate test)
const MISTIMED_FULL: CueLike[] = REFERENCE.map((cue) => {
  const startMs = Math.round(TRUE_RATE * cue.startMs + TRUE_OFFSET);
  return { ...cue, startMs, endMs: startMs + 2200 };
});

describe("reconcileTracks", () => {
  it("accepts a coherent linear disagreement and recovers the transform", () => {
    const result = reconcileTracks(MISTIMED, REFERENCE);
    expect(result.accepted).toBe(true);
    expect(result.model).not.toBeNull();
    expect(result.model!.offsetMs).toBeCloseTo(TRUE_OFFSET, -2);
    expect(Math.abs(1 - result.model!.rate)).toBeLessThan(0.002);
    expect(result.pairs.length).toBeGreaterThanOrEqual(8);
    expect(result.medianResidualMs).toBeLessThan(250);
    expect(result.gateFailures).toEqual([]);
  });

  it("recognizes an identity timebase as near-identity", () => {
    const sameTimebase = REFERENCE.map((cue, i) => ({
      ...cue,
      startMs: cue.startMs + jitter(i, 4) * 50,
    }));
    const result = reconcileTracks(sameTimebase, REFERENCE);
    expect(result.accepted).toBe(true);
    expect(isNearIdentityFit(result.model!)).toBe(true);
  });

  it("flags a pure rate mismatch beyond noise as not near-identity", () => {
    const rateOnly = REFERENCE.map((cue) => ({
      ...cue,
      startMs: Math.round(cue.startMs * 1.004),
    }));
    const result = reconcileTracks(rateOnly, REFERENCE);
    expect(result.accepted).toBe(true);
    expect(isNearIdentityFit(result.model!)).toBe(false);
  });

  it("rejects shuffled, non-linear timings", () => {
    const garbage = REFERENCE.map((cue, i) => ({
      ...cue,
      startMs: cue.startMs + jitter(i, 60) * 500,
    }));
    const result = reconcileTracks(garbage, REFERENCE);
    expect(result.accepted).toBe(false);
    expect(result.gateFailures.length).toBeGreaterThan(0);
  });

  it("rejects when too few lines match", () => {
    const result = reconcileTracks(MISTIMED.slice(0, 5), REFERENCE.slice(0, 5));
    expect(result.accepted).toBe(false);
    expect(result.gateFailures).toContain("too-few-pairs");
  });

  it("rejects a reference that only covers a sliver of the display span", () => {
    // 8 reference cues over the same spacing: 105 s of a 585 s display —
    // above the min spread but only 18% of the display span.
    const result = reconcileTracks(MISTIMED_FULL, REFERENCE.slice(0, 8));
    expect(result.accepted).toBe(false);
    expect(result.gateFailures).toContain("reference-truncated");
  });
});
