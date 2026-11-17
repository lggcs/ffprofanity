/**
 * Cross-track subtitle reconciliation.
 *
 * Fits how two subtitle tracks of the same video disagree in time by
 * pairing cues with matching text, and reports whether the pairing holds up
 * to sane bounds. Pure library: no DOM and no extension APIs.
 *
 * What a fit can and cannot prove: with two timelines and no external
 * reference, agreement says nothing about which track is right — only that
 * they share a timebase. Disagreement proves only that the timelines
 * differ; callers bring their own priors (label, source, coverage) to
 * decide who moves.
 */

import { fitAffine, normalizeForMatch, tokenSimilarity, type CueLike } from "./drift";

/** Fitted transform: displayed time = rate * reference time + offset */
export interface ReconcileModel {
  rate: number;
  offsetMs: number;
  fitRmsMs: number;
}

/** Outcome of pairing two tracks' cues by text */
export interface ReconcileResult {
  /** Matched lines (videoMs = reference time, subMs = displayed time), thinned */
  pairs: Array<{ videoMs: number; subMs: number }>;
  /** Null when nothing confident matched */
  model: ReconcileModel | null;
  /** Median |residual| over all matched pairs; Infinity when no model */
  medianResidualMs: number;
  /** Reference-time span covered by the matched pairs */
  spreadMs: number;
  /** Every failed sanity gate (empty when accepted) */
  gateFailures: string[];
  accepted: boolean;
}

export const RECONCILE_LIMITS = {
  /** Least matched lines for a verdict */
  minPairs: 8,
  /** Least reference-time span the matched pairs must cover */
  minSpreadMs: 60000,
  /** …and that span must reach this fraction of the displayed track's span */
  spreadFraction: 0.2,
  maxRateDeviation: 0.02,
  maxOffsetMs: 30000,
  /** Median |residual| above which the pairing is texture, not a timebase */
  maxMedianResidualMs: 250,
  /** Least tokens for a line to be matchable */
  matchTokens: 3,
  /** Least token similarity for a text match */
  matchScore: 0.8,
  /** Two candidates scoring this close are "the same line twice" — skip */
  ambiguityMargin: 0.2,
  /** First matching pass: window around the prior (site defaults are within
   * tens of seconds of each other; ±3 min absorbs resyncs without matching
   * across whole files) */
  coarseWindowMs: 180000,
  /** Tighter passes once a transform is anchored */
  refineWindowMs: 12000,
  /** Thin matched pairs to this many (evenly, endpoints kept) */
  maxPairs: 60,
} as const;

/** Gate label when the fitted rate sits outside the correction envelope. */
export const RATE_OUT_OF_RANGE = "rate-out-of-range";

/** Disagreement inside these bounds counts as "the same timebase" */
export const NEAR_IDENTITY = {
  offsetMs: 2000,
  rate: 0.001,
} as const;

export function isNearIdentityFit(model: { rate: number; offsetMs: number } | null): boolean {
  if (!model) return false;
  return (
    Math.abs(model.offsetMs) <= NEAR_IDENTITY.offsetMs &&
    Math.abs(model.rate - 1) <= NEAR_IDENTITY.rate
  );
}

/**
 * PAL-style cross-transfer fingerprint: the displayed track can pair cleanly
 * with every reference yet sit at a rate far outside the correction envelope
 * (a 25-fps PAL transfer against a 23.976-fps film master fits rate ≈ 0.959).
 * When the fits that failed ONLY the rate gate agree with each other within
 * these tolerances — same foreign rate, same lead-in — the disagreement with
 * the display's transfer is proven, and switching to a reference is warranted.
 * Applying the model is not: a rate this far out must never be remapped in.
 */
export const CROSS_TRANSFER_RATE_CONSISTENCY = 0.001;
export const CROSS_TRANSFER_OFFSET_CONSISTENCY_MS = 2000;

export function isConsistentCrossTransfer(
  models: Array<Pick<ReconcileModel, "rate" | "offsetMs">>,
): boolean {
  if (models.length < 2) return false;
  const first = models[0];
  if (!first) return false;
  for (let i = 1; i < models.length; i++) {
    const m = models[i];
    if (!m) return false;
    if (
      Math.abs(m.rate - first.rate) > CROSS_TRANSFER_RATE_CONSISTENCY ||
      Math.abs(m.offsetMs - first.offsetMs) > CROSS_TRANSFER_OFFSET_CONSISTENCY_MS
    ) {
      return false;
    }
  }
  return true;
}

/** What counts as a re-hosted copy of the same cue grid */
export const NEAR_DUPLICATE = {
  /** Paired cue starts may drift this much and still be the same grid */
  startToleranceMs: 50,
  /** The share of paired starts that must land inside the tolerance */
  matchFraction: 0.99,
} as const;

/**
 * True when two tracks share essentially the same cue timing grid — the
 * signature of a re-hosted copy of the same file (sites serve clones under
 * different ids/URLs). A near-identity fit against such a copy proves
 * nothing about the display: the "reference" is the displayed file again,
 * re-uploaded, so its agreement is not independent evidence.
 */
export function isNearDuplicateTrack(displayed: CueLike[], reference: CueLike[]): boolean {
  if (displayed.length < 2 || reference.length < 2) return false;
  if (
    Math.abs(displayed.length - reference.length) >
    Math.max(1, 0.01 * displayed.length)
  ) {
    return false;
  }
  const n = Math.min(displayed.length, reference.length);
  let close = 0;
  for (let i = 0; i < n; i++) {
    const d = displayed[i];
    const r = reference[i];
    if (!d || !r) continue;
    if (Math.abs(d.startMs - r.startMs) <= NEAR_DUPLICATE.startToleranceMs) close++;
  }
  return close / n >= NEAR_DUPLICATE.matchFraction;
}

interface PreparedCue {
  cue: CueLike;
  norm: string;
}

interface Point {
  x: number;
  y: number;
}

function countTokens(norm: string): number {
  return norm.split(" ").filter(Boolean).length;
}

function prepare(list: CueLike[], minTokens: number): PreparedCue[] {
  const out: PreparedCue[] = [];
  for (const cue of list) {
    if (!Number.isFinite(cue.startMs) || !Number.isFinite(cue.endMs)) continue;
    if (cue.endMs < cue.startMs) continue;
    const norm = normalizeForMatch(cue.text);
    if (countTokens(norm) < minTokens) continue;
    out.push({ cue, norm });
  }
  out.sort((a, b) => a.cue.startMs - b.cue.startMs);
  return out;
}

/** Normalized texts that occur exactly once in a prepared list */
function uniqueByText(list: PreparedCue[]): Map<string, PreparedCue> {
  const first = new Map<string, PreparedCue>();
  const dupes = new Set<string>();
  for (const c of list) {
    if (dupes.has(c.norm)) continue;
    if (first.has(c.norm)) {
      dupes.add(c.norm);
      first.delete(c.norm);
      continue;
    }
    first.set(c.norm, c);
  }
  return first;
}

function lowerBound(starts: number[], target: number): number {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const midVal = starts[mid];
    if (midVal === undefined || midVal < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Least-squares affine fit with iterative outlier rejection: on each pass the
 * worst-residual point is dropped while any residual exceeds thresholdMs.
 */
function robustFit(
  points: Point[],
  thresholdMs: number,
  maxPasses: number,
): { rate: number; offsetMs: number } | null {
  if (points.length === 0) return null;
  let working = points;
  for (let pass = 0; pass < maxPasses; pass++) {
    const affine = fitAffine(working);
    if (!affine) return null;
    let worstIdx = -1;
    let worst = 0;
    for (let i = 0; i < working.length; i++) {
      const p = working[i];
      if (!p) continue;
      const resid = Math.abs(p.y - (affine.rate * p.x + affine.offset));
      if (resid > worst) {
        worst = resid;
        worstIdx = i;
      }
    }
    if (worst <= thresholdMs || working.length <= 2) {
      return { rate: affine.rate, offsetMs: affine.offset };
    }
    working = working.slice(0, worstIdx).concat(working.slice(worstIdx + 1));
  }
  const affine = fitAffine(working);
  return affine ? { rate: affine.rate, offsetMs: affine.offset } : null;
}

/**
 * Match displayed cues against the reference inside a window around the
 * predicted position, keeping at most one pair per displayed cue and the
 * matched reference indices strictly increasing.
 */
function refine(
  disp: PreparedCue[],
  ref: PreparedCue[],
  refStarts: number[],
  rate: number,
  offsetMs: number,
  windowMs: number,
): Array<{ videoMs: number; subMs: number }> {
  const pairs: Array<{ videoMs: number; subMs: number }> = [];
  if (refStarts.length === 0 || !Number.isFinite(rate) || rate <= 0) return pairs;
  let lastRefIdx = -1;
  for (const d of disp) {
    const predicted = (d.cue.startMs - offsetMs) / rate;
    if (!Number.isFinite(predicted)) continue;
    let idx = lowerBound(refStarts, predicted - windowMs);
    let best = -1;
    let bestScore = 0;
    let secondScore = 0;
    for (; idx < ref.length; idx++) {
      const r = ref[idx];
      if (!r) continue;
      if (r.cue.startMs > predicted + windowMs) break;
      const score = tokenSimilarity(d.norm, r.norm);
      if (score > bestScore) {
        secondScore = bestScore;
        bestScore = score;
        best = idx;
      } else if (score > secondScore) {
        secondScore = score;
      }
    }
    if (best < 0) continue;
    if (bestScore < RECONCILE_LIMITS.matchScore) continue;
    if (secondScore > bestScore - RECONCILE_LIMITS.ambiguityMargin) continue;
    if (best <= lastRefIdx) continue;
    const r = ref[best];
    if (!r) continue;
    lastRefIdx = best;
    pairs.push({ videoMs: r.cue.startMs, subMs: d.cue.startMs });
  }
  return pairs;
}

function pointsOf(pairs: Array<{ videoMs: number; subMs: number }>): Point[] {
  return pairs.map((p) => ({ x: p.videoMs, y: p.subMs }));
}

function rmsOf(pairs: Array<{ videoMs: number; subMs: number }>, rate: number, offsetMs: number): number {
  if (pairs.length === 0) return 0;
  const sq = pairs.reduce((s, p) => s + (p.subMs - (rate * p.videoMs + offsetMs)) ** 2, 0);
  return Math.sqrt(sq / pairs.length);
}

function medianOf(values: number[]): number {
  if (values.length === 0) return Infinity;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  return sorted.length % 2 === 1 ? hi ?? Infinity : ((lo ?? 0) + (hi ?? 0)) / 2;
}

/** Keep first/last and evenly spaced pairs in between */
function thin(
  pairs: Array<{ videoMs: number; subMs: number }>,
  maxPairs: number,
): Array<{ videoMs: number; subMs: number }> {
  if (pairs.length <= maxPairs) return pairs;
  const step = Math.ceil(pairs.length / maxPairs);
  const out: Array<{ videoMs: number; subMs: number }> = [];
  for (let i = 0; i < pairs.length; i += step) {
    const p = pairs[i];
    if (p) out.push(p);
  }
  const last = pairs[pairs.length - 1];
  if (last && out[out.length - 1] !== last) out.push(last);
  return out;
}

/**
 * Pair `displayed` against `reference` by text and fit how their timelines
 * disagree (displayed = rate * reference + offset). Gates fail closed: a
 * result is only accepted when the pairing is dense, long-spanning and
 * self-consistent.
 */
export function reconcileTracks(
  displayed: CueLike[],
  reference: CueLike[],
  limits: Partial<Record<keyof typeof RECONCILE_LIMITS, number>> = {},
): ReconcileResult {
  const L: Record<keyof typeof RECONCILE_LIMITS, number> = { ...RECONCILE_LIMITS, ...limits };
  const rejected = (reason: string): ReconcileResult => ({
    pairs: [],
    model: null,
    medianResidualMs: Infinity,
    spreadMs: 0,
    gateFailures: [reason],
    accepted: false,
  });

  const disp = prepare(displayed, L.matchTokens);
  const ref = prepare(reference, L.matchTokens);
  if (disp.length < 2 || ref.length < 2) return rejected("too-few-cues");

  // 1) Coarse seed transform from lines that are unique in both tracks and
  // match exactly after normalization.
  const dispUnique = uniqueByText(disp);
  const refUnique = uniqueByText(ref);
  const seeds: Point[] = [];
  for (const [norm, d] of dispUnique) {
    const r = refUnique.get(norm);
    if (r) seeds.push({ x: r.cue.startMs, y: d.cue.startMs });
  }
  let rate = 1;
  let offsetMs = 0;
  const seedFit = seeds.length >= 2 ? robustFit(seeds, 3000, 3) : null;
  if (seedFit) {
    rate = seedFit.rate;
    offsetMs = seedFit.offsetMs;
  } else {
    // Proportional prior: assume both tracks open at the movie's first line
    // and stretch the reference over the displayed span. It only has to land
    // the ±3 minute window the coarse matching pass needs.
    const dFirst = disp[0]?.cue.startMs ?? 0;
    const dLast = disp[disp.length - 1]?.cue.startMs ?? 0;
    const rFirst = ref[0]?.cue.startMs ?? 0;
    const rLast = ref[ref.length - 1]?.cue.startMs ?? 0;
    const dSpan = dLast - dFirst;
    const rSpan = rLast - rFirst;
    if (dSpan <= 0 || rSpan <= 0) return rejected("span-unknown");
    const priorRate = dSpan / rSpan;
    if (!Number.isFinite(priorRate) || priorRate < 0.9 || priorRate > 1.1) {
      return rejected("no-anchored-seed");
    }
    rate = priorRate;
    offsetMs = dFirst - priorRate * rFirst;
  }

  // 2) Refinement: windowed text matching around the current transform,
  // robustly refit between passes.
  const refStarts = ref.map((c) => c.cue.startMs);
  let pairs = refine(disp, ref, refStarts, rate, offsetMs, L.coarseWindowMs);
  let fit = robustFit(pointsOf(pairs), 800, 3);
  if (fit) {
    rate = fit.rate;
    offsetMs = fit.offsetMs;
  }
  pairs = refine(disp, ref, refStarts, rate, offsetMs, L.refineWindowMs);
  fit = robustFit(pointsOf(pairs), 800, 3);
  if (fit) {
    rate = fit.rate;
    offsetMs = fit.offsetMs;
  }
  pairs = refine(disp, ref, refStarts, rate, offsetMs, L.refineWindowMs);
  fit = robustFit(pointsOf(pairs), 800, 3);
  if (fit) {
    rate = fit.rate;
    offsetMs = fit.offsetMs;
  }

  if (pairs.length < L.minPairs) return rejected("too-few-pairs");

  // 3) Final affine + sanity gates on the full pair set.
  const affine = fitAffine(pointsOf(pairs));
  if (!affine) return rejected("no-fit");
  const residuals = pairs.map((p) => Math.abs(p.subMs - (affine.rate * p.videoMs + affine.offset)));
  const medianResidualMs = medianOf(residuals);
  let minRefMs = Infinity;
  let maxRefMs = -Infinity;
  for (const p of pairs) {
    if (p.videoMs < minRefMs) minRefMs = p.videoMs;
    if (p.videoMs > maxRefMs) maxRefMs = p.videoMs;
  }
  const spreadMs = maxRefMs - minRefMs;
  const dFirst = disp[0]?.cue.startMs ?? 0;
  const dLast = disp[disp.length - 1]?.cue.startMs ?? 0;
  const displayedSpanMs = dLast - dFirst;

  const model: ReconcileModel = {
    rate: affine.rate,
    offsetMs: affine.offset,
    fitRmsMs: rmsOf(pairs, affine.rate, affine.offset),
  };

  const gateFailures: string[] = [];
  if (!Number.isFinite(spreadMs) || spreadMs < L.minSpreadMs) {
    gateFailures.push("insufficient-spread");
  }
  if (displayedSpanMs > 0 && spreadMs < L.spreadFraction * displayedSpanMs) {
    gateFailures.push("reference-truncated");
  }
  if (!Number.isFinite(model.rate) || Math.abs(model.rate - 1) > L.maxRateDeviation) {
    gateFailures.push(RATE_OUT_OF_RANGE);
  }
  if (!Number.isFinite(model.offsetMs) || Math.abs(model.offsetMs) > L.maxOffsetMs) {
    gateFailures.push("offset-out-of-range");
  }
  if (!Number.isFinite(medianResidualMs) || medianResidualMs > L.maxMedianResidualMs) {
    gateFailures.push("median-residual-high");
  }
  if (gateFailures.length > 0) {
    return { pairs: [], model, medianResidualMs, spreadMs, gateFailures, accepted: false };
  }

  return {
    pairs: thin(pairs, L.maxPairs),
    model,
    medianResidualMs,
    spreadMs,
    gateFailures: [],
    accepted: true,
  };
}
