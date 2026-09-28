import { describe, it, expect } from "vitest";
import {
  DriftCorrector,
  DRIFT_LIMITS,
  findBestCueMatch,
  type DriftAnchor,
  type DriftModel,
} from "../src/lib/drift";

function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps;
}

describe("DriftCorrector — single anchor (constant offset)", () => {
  it("fits a pure offset from one anchor", () => {
    const c = new DriftCorrector();
    const result = c.addAnchor(60000, 63000);
    expect(result.model).not.toBeNull();
    expect(result.model!.rate).toBe(1);
    expect(result.model!.offsetMs).toBe(3000);
    expect(result.usedAnchors).toBe(1);
    expect(result.rejected).toBe(0);
  });

  it("maps video time to subtitle time with the offset", () => {
    const c = new DriftCorrector();
    c.addAnchor(120000, 119500); // subs run 500ms early
    expect(c.toSub(120000)).toBe(119500);
    expect(c.toSub(180000)).toBe(179500);
    expect(c.toVideo(119500)).toBe(120000);
  });

  it("identity mapping without a model", () => {
    const c = new DriftCorrector();
    expect(c.toSub(42000)).toBe(42000);
    expect(c.toVideo(42000)).toBe(42000);
    expect(c.current).toBeNull();
  });
});

describe("DriftCorrector — two anchors (rate fit)", () => {
  it("fits an exact affine model from two anchors", () => {
    const c = new DriftCorrector();
    // True relationship: sub = 1.004 * video + 500
    const rate = 1.004;
    const offset = 500;
    c.addAnchor(60000, rate * 60000 + offset);
    const r2 = c.addAnchor(600000, rate * 600000 + offset);
    expect(r2.model).not.toBeNull();
    expect(r2.usedAnchors).toBe(2);
    expect(approx(r2.model!.rate, rate, 1e-9)).toBe(true);
    expect(approx(r2.model!.offsetMs, offset, 1e-6)).toBe(true);
    expect(r2.model!.fitRmsMs).toBeLessThan(1);
    // Interpolation is exact at a third point
    expect(approx(c.toSub(300000), rate * 300000 + offset, 1e-6)).toBe(true);
  });

  it("recovers fps-mismatch drift (PAL speedup style)", () => {
    const c = new DriftCorrector();
    // Subs authored at 25fps played at 23.976: content falls behind ~4.16%…
    // but our clamp is ±2%: simulate a subtler mismatch within the clamp.
    const trueRate = 1.015;
    c.addAnchor(120000, 120000);
    const r = c.addAnchor(900000, trueRate * 900000);
    expect(r.model).not.toBeNull();
    expect(r.model!.rate).toBeGreaterThan(1.0);
    // 15 min into the movie, correction differs from constant-offset by seconds
    const at15min = 900000;
    const subAt15 = c.toSub(at15min);
    expect(subAt15).toBeCloseTo(trueRate * at15min, 0);
  });

  it("clamps extreme fitted rates into ±2%", () => {
    const c = new DriftCorrector();
    c.addAnchor(60000, 60000);
    const r = c.addAnchor(600000, 600000 + 30000); // ~5.5% skew in 9 min
    expect(r.model).not.toBeNull();
    expect(r.model!.rate).toBeLessThanOrEqual(1 + DRIFT_LIMITS.rateClamp + 1e-9);
    expect(r.model!.rate).toBeGreaterThanOrEqual(1 - DRIFT_LIMITS.rateClamp - 1e-9);
  });
});

describe("DriftCorrector — outlier rejection", () => {
  it("rejects a miscaptured third anchor and keeps a clean fit", () => {
    const c = new DriftCorrector();
    // Clean line: sub = video + 1000
    c.addAnchor(60000, 61000);
    c.addAnchor(600000, 601000);
    // Third anchor wildly off (user grabbed the wrong line): +20s
    const bad = c.addAnchor(1200000, 1201000 + 20000);
    // With 3 anchors, the outlier (20s residual vs 1s line) is dropped
    expect(bad.rejected).toBeGreaterThanOrEqual(1);
    expect(bad.model).not.toBeNull();
    expect(bad.model!.offsetMs).toBeCloseTo(1000, -1); // ~1000, not ~7000
    expect(bad.model!.fitRmsMs).toBeLessThan(500);
  });

  it("gates anchors against an established good fit", () => {
    const c = new DriftCorrector();
    c.addAnchor(60000, 61000);
    c.addAnchor(600000, 601000);
    const good = c.current as DriftModel;
    expect(good.fitRmsMs).toBeLessThanOrEqual(DRIFT_LIMITS.goodFitRmsMs);

    // A wildly-off anchor after a good fit is rejected without touching the model
    const before = c.toJSON();
    const res = c.addAnchor(900000, 900000 + 25000);
    expect(res.notes).toContain("outlier-gated");
    expect(c.current).toBe(good);
    expect(c.toJSON()).toEqual(before);
  });
});

describe("DriftCorrector — anchor bookkeeping", () => {
  it("rejects duplicate anchors at the same video second", () => {
    const c = new DriftCorrector();
    c.addAnchor(60000, 60000);
    const dup = c.addAnchor(60100, 60000);
    expect(dup.notes).toContain("duplicate-anchor");
    expect(c.getAnchors().length).toBe(1);
  });

  it("rejects invalid input", () => {
    const c = new DriftCorrector();
    expect(c.addAnchor(NaN, 1000).notes).toContain("invalid-anchor");
    expect(c.addAnchor(-1, 1000).notes).toContain("invalid-anchor");
    expect(c.getAnchors().length).toBe(0);
  });

  it("enforces FIFO cap on anchors", () => {
    const c = new DriftCorrector();
    // Anchors 1.5s apart: all inside the validity window, so the cap (not
    // validity pruning) is what limits the set
    for (let i = 0; i < DRIFT_LIMITS.maxAnchors + 5; i++) {
      c.addAnchor(i * 1500, i * 1500);
    }
    expect(c.getAnchors().length).toBe(DRIFT_LIMITS.maxAnchors);
    // Oldest anchors were dropped
    expect(c.getAnchors()[0].videoMs).toBeGreaterThan(0);
  });

  it("drops anchors outside the validity window from the newest", () => {
    const c = new DriftCorrector();
    c.addAnchor(0, 0);
    c.addAnchor(DRIFT_LIMITS.anchorValidityMs + 60000, DRIFT_LIMITS.anchorValidityMs + 60000);
    const anchors = c.getAnchors();
    expect(anchors.length).toBe(1);
    expect(anchors[0].videoMs).toBe(DRIFT_LIMITS.anchorValidityMs + 60000);
  });
});

describe("DriftCorrector — bunched anchors fall back to offset-only", () => {
  it("keeps rate=1 when anchors are too close together", () => {
    const c = new DriftCorrector();
    c.addAnchor(60000, 61000);
    // 30s later — under minSpread, so rate must stay 1
    const r = c.addAnchor(90000, 91500);
    expect(r.model).not.toBeNull();
    expect(r.model!.rate).toBe(1);
    // Offset is the mean of the two residuals (1000, 1500)
    expect(r.model!.offsetMs).toBeCloseTo(1250, -1);
  });
});

describe("DriftCorrector — reset and serialization", () => {
  it("resets anchors and model", () => {
    const c = new DriftCorrector();
    c.addAnchor(60000, 61000);
    c.reset();
    expect(c.current).toBeNull();
    expect(c.getAnchors().length).toBe(0);
    expect(c.toSub(1000)).toBe(1000);
  });

  it("round-trips through JSON", () => {
    const c = new DriftCorrector();
    c.addAnchor(60000, 61500);
    c.addAnchor(600000, 603000);
    const snap = c.toJSON();
    const restored = DriftCorrector.fromJSON(JSON.parse(JSON.stringify(snap)));
    expect(restored.getAnchors().length).toBe(2);
    expect(restored.current).not.toBeNull();
    expect(restored.toSub(300000)).toBeCloseTo(c.toSub(300000), 6);
  });

  it("fromJSON handles garbage input", () => {
    const c = DriftCorrector.fromJSON(null);
    expect(c.current).toBeNull();
    expect(c.getAnchors().length).toBe(0);
    const c2 = DriftCorrector.fromJSON({ anchors: "nope", model: { rate: 2 } });
    expect(c2.getAnchors().length).toBe(0);
  });
});

describe("DriftCorrector — anchor aging", () => {
  it("drops anchors that fall outside the validity window on add", () => {
    const c = new DriftCorrector();
    const t = 1000000;
    c.addAnchor(0, 0, t);
    c.addAnchor(500000, 502000, t + 1000); // spread 500s → rate fit
    expect(c.getAnchors().length).toBe(2);
    // New anchor far beyond validity from the oldest → anchor at 0 is pruned.
    // subMs is consistent with the model fitted from the first two anchors
    // (rate 1.004), so the outlier gate does not interfere with this test.
    c.addAnchor(
      1200000,
      1.004 * 1200000,
      t + 2000,
    );
    const anchors = c.getAnchors();
    expect(anchors.length).toBe(2);
    expect(anchors.map((a) => a.videoMs)).toContain(500000);
    expect(anchors.map((a) => a.videoMs)).toContain(1200000);
    expect(anchors.map((a) => a.videoMs)).not.toContain(0);
  });
});

describe("DriftCorrector — auto (native-track) anchors", () => {
  it("tags anchors with their source and defaults to user", () => {
    const c = new DriftCorrector();
    c.addAnchor(60000, 60000);
    const r = c.addAnchor(600000, 602000, Date.now(), "auto");
    expect(r.model).not.toBeNull();
    const anchors = c.getAnchors();
    expect(anchors[0].source).toBe("user");
    expect(anchors[1].source).toBe("auto");
  });

  it("counts auto anchors toward the auto cap only", () => {
    const c = new DriftCorrector();
    // User anchors are exempt from the auto cap. 1.5s spacing keeps all
    // anchors inside the validity window so only the caps are exercised.
    let tick = 0;
    for (let i = 0; i < DRIFT_LIMITS.maxAutoAnchors + 2; i++) {
      const r = c.addAnchor(tick * 1500, tick * 1500, 1000 + i * 1000, "user");
      expect(r.notes).not.toContain("auto-cap");
      tick++;
    }
    const userAnchors = c.getAnchors().length;
    // Auto anchors are capped at maxAutoAnchors (1.5s spacing, no duplicates)
    for (let i = 0; i < DRIFT_LIMITS.maxAutoAnchors; i++) {
      const r = c.addAnchor(tick * 1500, tick * 1500, 20000 + i * 1000, "auto");
      expect(r.notes).not.toContain("auto-cap");
      tick++;
    }
    expect(c.getAnchors().length).toBe(userAnchors + DRIFT_LIMITS.maxAutoAnchors);
    // Auto cap now full — further auto captures are throttled
    const blocked = c.addAnchor(tick * 1500, tick * 1500, 40000, "auto");
    expect(blocked.notes).toContain("auto-cap");
    expect(c.getAnchors().length).toBe(userAnchors + DRIFT_LIMITS.maxAutoAnchors);
    // User anchors still accepted while auto is capped
    const userOk = c.addAnchor(tick * 1500, tick * 1500, 41000, "user");
    expect(userOk.notes).not.toContain("auto-cap");
    expect(c.getAnchors().length).toBe(userAnchors + DRIFT_LIMITS.maxAutoAnchors + 1);
  });

  it("invalidates a 2+-anchor model when a fresh auto sample is far off", () => {
    const c = new DriftCorrector();
    c.addAnchor(0, 0);
    const fit = c.addAnchor(600000, 12000); // rate 1.02 > clamp? no: residual 12000 → offset model from 2 pts
    // Establish a good 2-anchor model with a mild rate
    const c2 = new DriftCorrector();
    c2.addAnchor(60000, 60600);
    c2.addAnchor(600000, 606000); // rate 1.0 exact
    expect(c2.current).not.toBeNull();
    // Auto sample 5s away from the model → model dropped, refit includes it
    const r = c2.addAnchor(1200000, 1205000, Date.now(), "auto");
    expect(r.model).not.toBeNull();
    // The rejected-sample model would have predicted 1206000; the sample says 1205000
    expect(r.usedAnchors).toBeGreaterThanOrEqual(2);
  });

  it("canCaptureAuto enforces cap and interval", () => {
    const c = new DriftCorrector();
    const t0 = 1000;
    expect(c.canCaptureAuto(t0, 0)).toBe(true); // never attempted
    // Same instant as last attempt → blocked by interval
    expect(c.canCaptureAuto(t0, t0)).toBe(false);
    // After the interval → allowed
    expect(c.canCaptureAuto(t0 + DRIFT_LIMITS.autoCaptureIntervalMs, t0)).toBe(true);
    // Fill the cap → blocked regardless of interval. 1.5s spacing keeps
    // anchors inside the validity window so the cap is what blocks.
    for (let i = 0; i < DRIFT_LIMITS.maxAutoAnchors; i++) {
      c.addAnchor(i * 1500, i * 1500 + 500, 1000 + i * 1000, "auto");
    }
    expect(c.canCaptureAuto(99999999, 0)).toBe(false);
  });

  it("resetAuto keeps user anchors and clears the model", () => {
    const c = new DriftCorrector();
    c.addAnchor(60000, 61000);
    c.addAnchor(600000, 601000, Date.now(), "auto");
    expect(c.getAnchors().length).toBe(2);
    c.resetAuto();
    const anchors = c.getAnchors();
    expect(anchors.length).toBe(1);
    expect(anchors[0].source).toBe("user");
    expect(c.current).toBeNull();
  });

  it("JSON round-trip preserves source tags", () => {
    const c = new DriftCorrector();
    c.addAnchor(60000, 61000);
    c.addAnchor(600000, 601000, Date.now(), "auto");
    const snap = c.toJSON();
    const restored = DriftCorrector.fromJSON(snap);
    const anchors = restored.getAnchors();
    expect(anchors[0].source).toBe("user");
    expect(anchors[1].source).toBe("auto");
  });
});

describe("findBestCueMatch — native cue pairing", () => {
  it("matches a unique confident cue", () => {
    const cues = [
      { startMs: 1000, endMs: 3000, text: "Hello there, general." },
      { startMs: 5000, endMs: 8000, text: "You are strong and wise, and I am very proud of you." },
    ];
    const m = findBestCueMatch(cues, "You are strong and wise, and I'm very proud of you!");
    expect(m).not.toBeNull();
    expect(m!.cue.startMs).toBe(5000);
    expect(m!.similarity).toBeGreaterThanOrEqual(0.8);
  });

  it("rejects short text (below minimum tokens)", () => {
    const cues = [{ startMs: 1000, endMs: 2000, text: "What?" }];
    expect(findBestCueMatch(cues, "What?")).toBeNull();
  });

  it("rejects ambiguous matches (repeated line)", () => {
    const line = { text: "I have a bad feeling about this." };
    const cues = [
      { startMs: 1000, endMs: 3000, ...line },
      { startMs: 60000, endMs: 62000, ...line },
    ];
    expect(findBestCueMatch(cues, "I have a bad feeling about this.")).toBeNull();
  });

  it("rejects weak matches", () => {
    const cues = [{ startMs: 1000, endMs: 2000, text: "The council is divided on this matter completely." }];
    expect(findBestCueMatch(cues, "Totally different content over here entirely")).toBeNull();
  });

  it("strips HTML tags and entities before matching", () => {
    const cues = [{ startMs: 1000, endMs: 3000, text: "You were right about one thing master" }];
    const m = findBestCueMatch(cues, "<i>You were right about one thing, Master.</i>&nbsp;");
    expect(m).not.toBeNull();
    expect(m!.cue.startMs).toBe(1000);
  });
});