/**
 * Drift Correction Library
 * Corrects subtitle timing drift relative to actual audio.
 *
 * Model: subMs = rate * videoMs + offsetMs   (affine, video time → subtitle time)
 * 1 anchor = constant offset (rate=1); 2+ anchors = rate fitted and clamped
 * (fixes fps-mismatch drift that a constant offset cannot).
 */

/** Bounds and thresholds for a sane drift model */
export const DRIFT_LIMITS = {
  maxOffsetMs: 30000,
  maxRateDeviation: 0.1,
  rateClamp: 0.02,
  maxAnchors: 50,
  minSpreadMs: 60000,
  anchorValidityMs: 15 * 60000,
  outlierThresholdMs: 2000,
  outlierGateMs: 3000,
  goodFitRmsMs: 150,
  minAnchorsForModel: 1,
  /** Max simultaneous auto-captured anchors (user anchors uncounted) */
  maxAutoAnchors: 20,
  /** Auto sample residual vs a 2+-anchor model that invalidates the model */
  autoResidualMs: 4000,
  /** Interval (ms) between automatic anchor captures */
  autoCaptureIntervalMs: 30000,
} as const;

/** Where an anchor came from: user press or native-track auto-pairing */
export type DriftAnchorSource = "user" | "auto";

/** An anchor: the cue at subMs was being heard while the video was at videoMs */
export interface DriftAnchor {
  videoMs: number;
  subMs: number;
  capturedAt: number;
  /** How it was captured (absent on old records = user) */
  source?: DriftAnchorSource;
}

/** Fitted affine model (video → subtitle time) */
export interface DriftModel {
  /** subtitle time = rate * video time + offset */
  rate: number;
  offsetMs: number;
  /** anchors used by the fit (after outlier rejection) */
  anchorCount: number;
  /** RMS residual of the fit (ms) */
  fitRmsMs: number;
  /** video-time span covered by the anchor set (ms) */
  spreadMs: number;
  /** wall-clock time of the fit */
  fittedAt: number;
}

/** Result of a (re)fit */
export interface DriftFitResult {
  model: DriftModel | null;
  /** anchors used after outlier rejection */
  usedAnchors: number;
  rejected: number;
  notes: string[];
}

/** Serializable snapshot */
export interface DriftSnapshot {
  anchors: DriftAnchor[];
  model: DriftModel | null;
}

/**
 * Normalize subtitle text for cross-source matching (native player cue vs
 * parsed cue): lowercase, strip tags/markup, punctuation, collapse whitespace.
 * Never rendered — safe to keep punctuation-stripped.
 */
export function normalizeForMatch(text: string): string {
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Jaccard similarity over word tokens (0..1) */
export function tokenSimilarity(a: string, b: string): number {
  const ta = a.split(" ").filter(Boolean);
  const tb = b.split(" ").filter(Boolean);
  if (ta.length === 0 || tb.length === 0) return 0;
  const setA = new Set(ta);
  const setB = new Set(tb);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  return inter / (setA.size + setB.size - inter);
}

/** Minimum normalized length for a text pair to be a confident match */
const MIN_MATCH_TOKENS = 3;

/**
 * Find the best cue matching nativeText among candidates (a slice of the
 * base, subtitle-timeline cue list). Returns the cue and its similarity, or
 * null when nothing matches confidently. Ambiguous matches (two candidates
 * scoring within 0.2 of the best) return null so callers skip the sample.
 */
export function findBestCueMatch(
  candidates: CueLike[],
  nativeText: string,
): { cue: CueLike; similarity: number } | null {
  const target = normalizeForMatch(nativeText);
  if (target.split(" ").filter(Boolean).length < MIN_MATCH_TOKENS) return null;

  let best: CueLike | null = null;
  let bestScore = 0;
  let secondScore = 0;
  for (const cue of candidates) {
    const score = tokenSimilarity(target, normalizeForMatch(cue.text));
    if (score > bestScore) {
      secondScore = bestScore;
      bestScore = score;
      best = cue;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }
  if (!best || bestScore < 0.8) return null;
  // Ambiguity guard: repeated lines ("What?") appear at several times —
  // pairing the wrong occurrence would poison the model.
  if (secondScore > bestScore - 0.2) return null;
  return { cue: best, similarity: bestScore };
}

/** Minimal cue shape the matcher needs (avoids content-script type cycle) */
export interface CueLike {
  startMs: number;
  endMs: number;
  text: string;
}

/** Clamp rate into the accepted range */
function clampRate(rate: number): number {
  const lo = 1 - DRIFT_LIMITS.rateClamp;
  const hi = 1 + DRIFT_LIMITS.rateClamp;
  return Math.min(hi, Math.max(lo, rate));
}

/** Compute least-squares rate/offset for pairs (x=videoMs, y=subMs) */
function fitAffine(points: Array<{ x: number; y: number }>): { rate: number; offset: number } | null {
  const n = points.length;
  const first = points[0];
  if (n === 0 || !first) return null;
  if (n === 1) return { rate: 1, offset: first.y - first.x };

  const meanX = points.reduce((s, p) => s + p.x, 0) / n;
  const meanY = points.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    const dx = p.x - meanX;
    sxx += dx * dx;
    sxy += (p.y - meanY) * dx;
  }
  if (sxx === 0) return { rate: 1, offset: meanY - meanX };
  const rate = sxy / sxx;
  const offset = meanY - rate * meanX;
  return { rate, offset };
}

/** RMS residual of points against a model */
function rmsOf(points: Array<{ x: number; y: number }>, rate: number, offset: number): number {
  if (points.length === 0) return 0;
  const sq = points.reduce((s, p) => s + (p.y - (rate * p.x + offset)) ** 2, 0);
  return Math.sqrt(sq / points.length);
}

/** Video-time spread of a set of anchors */
function spreadOf(points: Array<{ x: number; y: number }>): number {
  if (points.length < 2) return 0;
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    if (p.x < min) min = p.x;
    if (p.x > max) max = p.x;
  }
  return max - min;
}

/**
 * Drift corrector: anchors in, affine model out.
 * One anchor = constant offset (rate=1); two or more = rate fitted and clamped.
 */
export class DriftCorrector {
  private anchors: DriftAnchor[] = [];
  private model: DriftModel | null = null;

  constructor(initial?: Partial<DriftSnapshot>) {
    if (initial?.anchors) this.anchors = initial.anchors.slice(0, DRIFT_LIMITS.maxAnchors);
    this.model = initial?.model ?? null;
  }

  /** Count of anchors captured by auto-pairing (derived — eviction/pruning safe) */
  private get autoCount(): number {
    return this.anchors.reduce((n, a) => (a.source === "auto" ? n + 1 : n), 0);
  }

  /** Current model, if any */
  get current(): DriftModel | null {
    return this.model;
  }

  /** Current anchors (copy) */
  getAnchors(): DriftAnchor[] {
    return this.anchors.slice();
  }

  /**
   * Whether another auto anchor may be captured now (cap + rate limiting).
   * `lastAttempt === 0` means "never attempted" (fresh session).
   */
  canCaptureAuto(now: number = Date.now(), lastAttempt: number = 0): boolean {
    if (this.autoCount >= DRIFT_LIMITS.maxAutoAnchors) return false;
    if (lastAttempt <= 0) return true;
    return now - lastAttempt >= DRIFT_LIMITS.autoCaptureIntervalMs;
  }

  /**
   * Capture an anchor and refit.
   * Returns the fit result; a rejected anchor leaves the model unchanged.
   */
  addAnchor(
    videoMs: number,
    subMs: number,
    now: number = Date.now(),
    source: DriftAnchorSource = "user",
  ): DriftFitResult {
    const v = Number(videoMs);
    const s = Number(subMs);
    if (!Number.isFinite(v) || !Number.isFinite(s) || v < 0) {
      return { model: this.model, usedAnchors: 0, rejected: 1, notes: ["invalid-anchor"] };
    }

    // Refuse near-duplicates (same rounded video second)
    const rounded = Math.round(v / 1000);
    if (this.anchors.some((a) => Math.round(a.videoMs / 1000) === rounded)) {
      return { model: this.model, usedAnchors: 0, rejected: 1, notes: ["duplicate-anchor"] };
    }

    // Auto samples are cheap but noisier than user captures: cap their share
    // so user anchors always dominate the fit. Reaching the cap throttles
    // further auto captures (caller checks canCaptureAuto).
    if (source === "auto" && this.autoCount >= DRIFT_LIMITS.maxAutoAnchors) {
      return { model: this.model, usedAnchors: 0, rejected: 1, notes: ["auto-cap"] };
    }

    if (this.anchors.length >= DRIFT_LIMITS.maxAnchors) {
      this.anchors.shift(); // FIFO
    }

    this.anchors.push({ videoMs: v, subMs: s, capturedAt: now, source });

    // Drop anchors too far from the newest (stale positions after seeks)
    const newest = this.anchors[this.anchors.length - 1];
    if (newest) {
      this.anchors = this.anchors.filter(
        (a) => Math.abs(a.videoMs - newest.videoMs) <= DRIFT_LIMITS.anchorValidityMs,
      );
    }

    // Gate a new anchor against an existing good fit (protects against miscaptures).
    // Only applies once the model was fitted from 2+ anchors — a single-anchor
    // model is just an offset assumption, and the second anchor legitimately
    // deviates from it (that deviation is exactly what reveals drift).
    if (this.model && this.model.anchorCount >= 2 && this.model.fitRmsMs <= DRIFT_LIMITS.goodFitRmsMs) {
      const residual = Math.abs(s - (this.model.rate * v + this.model.offsetMs));
      if (residual > DRIFT_LIMITS.outlierGateMs) {
        this.anchors.pop();
        return { model: this.model, usedAnchors: this.model.anchorCount, rejected: 1, notes: ["outlier-gated"] };
      }
    }

    // Auto samples carry noisier pairings than user captures: if a fresh
    // auto sample lands far from the current 2+-anchor model, the pairing
    // or the old model has degraded — trust the new evidence and refit from
    // the full anchor set without the stale model.
    if (source === "auto" && this.model && this.model.anchorCount >= 2) {
      const residual = Math.abs(s - (this.model.rate * v + this.model.offsetMs));
      if (residual > DRIFT_LIMITS.autoResidualMs) {
        this.model = null;
      }
    }

    return this.refit();
  }

  /**
   * Fit offset (1 anchor) or rate+offset (2+), with outlier rejection.
   */
  refit(): DriftFitResult {
    if (this.anchors.length === 0) {
      this.model = null;
      return { model: null, usedAnchors: 0, rejected: 0, notes: ["no-anchors"] };
    }

    let working = this.anchors.slice();
    let rejected = 0;
    const notes: string[] = [];
    let model: DriftModel | null = null;

    for (let iter = 0; iter < 5; iter++) {
      if (working.length === 0) {
        model = null;
        break;
      }

      const points = working.map((a) => ({ x: a.videoMs, y: a.subMs }));
      const s = spreadOf(points);
      const bunched = working.length > 1 && s < DRIFT_LIMITS.minSpreadMs;
      const affine = fitAffine(points);
      if (!affine) {
        model = null;
        break;
      }

      let rate = affine.rate;
      let offset = affine.offset;
      let bunchedOffset = false;

      if (bunched) {
        // Spread too small for a stable rate: fit offset from mean, keep rate=1
        rate = 1;
        offset = working.reduce((acc, a) => acc + (a.subMs - a.videoMs), 0) / working.length;
        bunchedOffset = true;
      }

      // Sanity bounds: beyond these the anchor pairing is wrong — drop worst anchor
      if (Math.abs(offset) > DRIFT_LIMITS.maxOffsetMs || Math.abs(rate - 1) > DRIFT_LIMITS.maxRateDeviation) {
        const worst = this.worstResidualIndex(working, rate, offset);
        if (worst === null) {
          model = null;
          notes.push("out-of-bounds-fit");
          break;
        }
        working.splice(worst, 1);
        rejected++;
        notes.push("dropped-outlier");
        continue;
      }

      // Outlier rejection pass (only with enough spread)
      if (!bunchedOffset && working.length >= 3) {
        const residuals = working.map((a) => Math.abs(a.subMs - (rate * a.videoMs + offset)));
        let maxResidual = 0;
        let maxIdx = -1;
        for (let i = 0; i < residuals.length; i++) {
          const r = residuals[i];
          if (r !== undefined && r > maxResidual) {
            maxResidual = r;
            maxIdx = i;
          }
        }
        if (maxIdx >= 0 && maxResidual > DRIFT_LIMITS.outlierThresholdMs) {
          working.splice(maxIdx, 1);
          rejected++;
          notes.push("dropped-outlier");
          continue;
        }
      }

      model = {
        rate: clampRate(rate),
        offsetMs: offset,
        anchorCount: working.length,
        fitRmsMs: rmsOf(points, rate, offset),
        spreadMs: s,
        fittedAt: Date.now(),
      };
      break;
    }

    this.model = model;
    return {
      model,
      usedAnchors: model ? model.anchorCount : 0,
      rejected,
      notes,
    };
  }

  /** Index of the worst-residual anchor, or null when only one remains */
  private worstResidualIndex(working: DriftAnchor[], rate: number, offset: number): number | null {
    if (working.length <= 1) return null;
    let worstIdx = -1;
    let worst = -1;
    for (let i = 0; i < working.length; i++) {
      const a = working[i];
      if (!a) continue;
      const r = Math.abs(a.subMs - (rate * a.videoMs + offset));
      if (r > worst) {
        worst = r;
        worstIdx = i;
      }
    }
    return worstIdx >= 0 ? worstIdx : null;
  }

  /** Map video time → subtitle time */
  toSub(videoMs: number): number {
    if (!this.model) return videoMs;
    return this.model.rate * videoMs + this.model.offsetMs;
  }

  /** Inverse map: subtitle time → video time */
  toVideo(subMs: number): number {
    if (!this.model) return subMs;
    return (subMs - this.model.offsetMs) / this.model.rate;
  }

  /** Clear anchors and model */
  reset(): void {
    this.anchors = [];
    this.model = null;
  }

  /** Drop auto anchors only (user anchors survive) */
  resetAuto(): void {
    this.anchors = this.anchors.filter((a) => a.source !== "auto");
    this.model = null;
  }

  /** Drop the model but keep anchors (e.g. after settings change) */
  invalidateModel(): void {
    this.model = null;
  }

  /** Serializable snapshot */
  toJSON(): DriftSnapshot {
    return { anchors: this.anchors.slice(), model: this.model };
  }

  static fromJSON(data: unknown): DriftCorrector {
    const d = (data || {}) as Partial<DriftSnapshot>;
    return new DriftCorrector({
      anchors: Array.isArray(d.anchors) ? d.anchors : [],
      model: d.model ?? null,
    });
  }
}