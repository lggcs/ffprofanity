/**
 * Drift Corrector - Passive Sampling
 *
 * Collects drift samples during normal playback WITHOUT seeking.
 * Samples are collected by the content script during updatePlayback().
 */

import { SpeechDetector, median, type DriftSample } from "./speechDetector";

export interface DriftCorrectionResult {
  offsetMs: number;
  confidence: number;
  samplesAnalyzed: number;
  source: "auto" | "manual" | "none";
}

export class DriftCorrector {
  private samples: DriftSample[] = [];
  private currentOffset: number = 0;
  private hasCorrected: boolean = false;
  private minSamples: number = 15;
  private maxSamples: number = 30;

  constructor(minSamples: number = 15) {
    this.minSamples = minSamples;
  }

  /**
   * Add a drift sample during normal playback.
   * Called from updatePlayback() - does NOT seek or pause.
   */
  addSample(sample: DriftSample): void {
    if (this.hasCorrected) return;

    this.samples.push(sample);

    if (this.samples.length >= this.maxSamples) {
      this.calculateDrift();
    }
  }

  /**
   * Check if we have enough samples and calculate drift.
   * Called automatically when maxSamples reached, or manually.
   */
  calculateDrift(): DriftCorrectionResult {
    if (this.samples.length < this.minSamples) {
      return {
        offsetMs: 0,
        confidence: 0,
        samplesAnalyzed: this.samples.length,
        source: "none",
      };
    }

    const drifts = this.samples.map((s) => s.drift).sort((a, b) => a - b);
    const medianDriftSec = median(drifts);
    const offsetMs = -medianDriftSec * 1000;

    const confidence = this.calculateConfidence(drifts);

    console.log("[FFProfanity] Passive drift detection complete:", {
      samples: this.samples.length,
      offsetMs: offsetMs.toFixed(0),
      confidence: confidence.toFixed(2),
      drifts: drifts.map((d) => d.toFixed(3)).slice(0, 5),
    });

    this.currentOffset = offsetMs;
    this.hasCorrected = true;

    return {
      offsetMs,
      confidence,
      samplesAnalyzed: this.samples.length,
      source: "auto",
    };
  }

  /**
   * Check if enough samples have been collected
   */
  hasEnoughSamples(): boolean {
    return this.samples.length >= this.minSamples;
  }

  /**
   * Check if drift correction has been applied
   */
  isCorrected(): boolean {
    return this.hasCorrected;
  }

  /**
   * Get current sample count
   */
  getSampleCount(): number {
    return this.samples.length;
  }

  /**
   * Get required sample count
   */
  getRequiredSamples(): number {
    return this.minSamples;
  }

  /**
   * Get current offset
   */
  getCurrentOffset(): number {
    return this.currentOffset;
  }

  /**
   * Set manual offset
   */
  setManualOffset(offsetMs: number): void {
    this.currentOffset = offsetMs;
    this.hasCorrected = true;
  }

  /**
   * Reset for a new video
   */
  reset(): void {
    this.samples = [];
    this.currentOffset = 0;
    this.hasCorrected = false;
  }

  /**
   * Get all collected samples
   */
  getSamples(): DriftSample[] {
    return [...this.samples];
  }

  private calculateConfidence(drifts: number[]): number {
    if (drifts.length < 2) return 0.5;

    const avg = drifts.reduce((a, b) => a + b, 0) / drifts.length;
    const squareDiffs = drifts.map((d) => Math.pow(d - avg, 2));
    const stdDev = Math.sqrt(
      squareDiffs.reduce((a, b) => a + b, 0) / drifts.length,
    );

    const normalizedStdDev = stdDev / 0.5;
    const confidence = Math.max(0.1, Math.min(1, 1 - normalizedStdDev));
    const sampleBonus = Math.min(0.2, drifts.length * 0.01);

    return Math.min(1, confidence + sampleBonus);
  }
}

let driftCorrectorInstance: DriftCorrector | null = null;

export function getDriftCorrector(): DriftCorrector {
  if (!driftCorrectorInstance) {
    driftCorrectorInstance = new DriftCorrector();
  }
  return driftCorrectorInstance;
}

export function resetDriftCorrector(): void {
  if (driftCorrectorInstance) {
    driftCorrectorInstance.reset();
  }
}
