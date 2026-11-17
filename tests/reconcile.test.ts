import { describe, it, expect } from "vitest";
import {
  isConsistentCrossTransfer,
  isNearDuplicateTrack,
  isNearIdentityFit,
  RATE_OUT_OF_RANGE,
  reconcileTracks,
} from "../src/lib/reconcile";
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

describe("isConsistentCrossTransfer", () => {
  it("accepts two fits at the same foreign rate and lead-in", () => {
    // The real lookmovie2 PAL pair: several references all measured ~0.959
    // (25-fps transfer against a 23.976-fps film master), offsets within 0.5 s.
    expect(
      isConsistentCrossTransfer([
        { rate: 0.959009, offsetMs: -2399 },
        { rate: 0.958996, offsetMs: -2316 },
      ]),
    ).toBe(true);
  });

  it("requires at least two fits", () => {
    expect(isConsistentCrossTransfer([{ rate: 0.959, offsetMs: -2399 }])).toBe(false);
    expect(isConsistentCrossTransfer([])).toBe(false);
  });

  it("rejects fits that disagree on rate or lead-in", () => {
    expect(
      isConsistentCrossTransfer([
        { rate: 0.959, offsetMs: -2399 },
        { rate: 0.97, offsetMs: -2399 },
      ]),
    ).toBe(false);
    expect(
      isConsistentCrossTransfer([
        { rate: 0.959, offsetMs: -2399 },
        { rate: 0.959, offsetMs: -4400 },
      ]),
    ).toBe(false);
  });

  it("stays consistent inside the tolerances and inconsistent past them", () => {
    // Rates 0.0005 apart — clearly inside the 0.001 rate tolerance.
    expect(
      isConsistentCrossTransfer([
        { rate: 0.959, offsetMs: -2000 },
        { rate: 0.9595, offsetMs: -2000 },
      ]),
    ).toBe(true);
    // Lead-in exactly 2000 ms apart — on the bound, still consistent.
    expect(
      isConsistentCrossTransfer([
        { rate: 0.959, offsetMs: -2000 },
        { rate: 0.959, offsetMs: 0 },
      ]),
    ).toBe(true);
    // One millisecond past the lead-in bound breaks consistency.
    expect(
      isConsistentCrossTransfer([
        { rate: 0.959, offsetMs: -2000 },
        { rate: 0.959, offsetMs: 1 },
      ]),
    ).toBe(false);
    // 0.002 apart is a fifth past the rate tolerance — no longer the same
    // foreign master.
    expect(
      isConsistentCrossTransfer([
        { rate: 0.959, offsetMs: -2000 },
        { rate: 0.961, offsetMs: -2000 },
      ]),
    ).toBe(false);
  });
});

describe("PAL cross-transfer, end to end", () => {
  // A 25-fps PAL transfer against a 23.976-fps film master: the display runs
  // ~4.3% fast — far outside the ±2% correction envelope, yet every cue
  // pairs cleanly and the residuals stay tiny.
  const RATE = 0.959;
  const OFFSET_MS = -2399;
  const PAL_TIMED = REFERENCE.map((cue) => {
    const startMs = Math.round(cue.startMs * RATE) + OFFSET_MS;
    return { ...cue, startMs, endMs: startMs + 2200 };
  });

  it("pairs cleanly but is rejected solely on rate, keeping a usable model", () => {
    const result = reconcileTracks(PAL_TIMED, REFERENCE);
    expect(result.accepted).toBe(false);
    expect(result.gateFailures).toEqual([RATE_OUT_OF_RANGE]);
    expect(result.model!.rate).toBeCloseTo(RATE, 3);
    expect(result.medianResidualMs).toBeLessThan(250);
  });

  it("marks the disagreement proven when a second reference fits the same rate", () => {
    const shifted = REFERENCE.map((cue) => ({ ...cue, startMs: cue.startMs + 500 }));
    const first = reconcileTracks(PAL_TIMED, REFERENCE);
    const second = reconcileTracks(PAL_TIMED, shifted);
    expect(first.gateFailures).toEqual([RATE_OUT_OF_RANGE]);
    expect(second.gateFailures).toEqual([RATE_OUT_OF_RANGE]);
    expect(isConsistentCrossTransfer([first.model!, second.model!])).toBe(true);
  });
});

describe("isNearDuplicateTrack", () => {
  // 50 cues on one shared timing grid
  const GRID: CueLike[] = Array.from({ length: 50 }, (_, i) =>
    makeCue(i, 5000 + i * SPACING_MS),
  );

  it("recognizes a re-hosted copy of the same cue grid (either direction)", () => {
    // Re-encodes are not byte-identical: a few starts drift within a frame.
    const clone = GRID.map((cue, i) => ({
      ...cue,
      startMs: cue.startMs + (i % 25 === 0 ? 30 : 0),
    }));
    expect(isNearDuplicateTrack(GRID, clone)).toBe(true);
    expect(isNearDuplicateTrack(clone, GRID)).toBe(true);
  });

  it("rejects a same-text release on a different grid (the ASR copy)", () => {
    const shifted = GRID.map((cue) => ({ ...cue, startMs: cue.startMs + 3000 }));
    expect(isNearDuplicateTrack(GRID, shifted)).toBe(false);
  });

  it("rejects a differently segmented release", () => {
    // Same timeline, but every other cue pair merged into one cue.
    const merged: CueLike[] = [];
    for (let i = 0; i < GRID.length; i += 2) {
      const a = GRID[i]!;
      const b = GRID[i + 1]!;
      merged.push({ startMs: a.startMs, endMs: b.endMs, text: `${a.text} ${b.text}` });
    }
    expect(isNearDuplicateTrack(GRID, merged)).toBe(false);
  });

  it("rejects truncated copies and empty input", () => {
    expect(isNearDuplicateTrack(GRID, GRID.slice(0, 20))).toBe(false);
    expect(isNearDuplicateTrack([], GRID)).toBe(false);
  });
});
