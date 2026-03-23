/**
 * Speech Detector using Web Audio API
 *
 * NON-DISRUPTIVE drift detection - samples during normal playback
 * without seeking or pausing the video.
 */

export interface SpeechDetectionResult {
  isSpeaking: boolean;
  energy: number;
  zeroCrossingRate: number;
  confidence: number;
}

export interface DriftSample {
  expectedTime: number;
  detectedTime: number;
  drift: number;
  confidence: number;
  timestamp: number;
}

export class SpeechDetector {
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private isConnected: boolean = false;

  private readonly ENERGY_MIN = 0.015;
  private readonly ENERGY_MAX = 0.5;
  private readonly ZCR_MIN = 0.02;
  private readonly ZCR_MAX = 0.15;

  private timeDomainData: Float32Array | null = null;

  async connect(videoElement: HTMLVideoElement): Promise<boolean> {
    try {
      this.videoElement = videoElement;

      this.audioContext = new AudioContext();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 4096;
      this.analyser.smoothingTimeConstant = 0.3;

      this.timeDomainData = new Float32Array(this.analyser.fftSize);

      // Use MediaElementSourceNode only - avoids captureStream audio interference
      try {
        this.source = this.audioContext.createMediaElementSource(videoElement);
        this.source.connect(this.analyser);
        this.analyser.connect(this.audioContext.destination);
        this.isConnected = true;
        return true;
      } catch (e) {
        console.warn("[FFProfanity] Could not connect to audio:", e);
      }

      return false;
    } catch (error) {
      console.error("[FFProfanity] SpeechDetector connection error:", error);
      return false;
    }
  }

  disconnect(): void {
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    this.analyser = null;
    this.isConnected = false;
    this.timeDomainData = null;
  }

  isConnectedToAudio(): boolean {
    return this.isConnected && this.analyser !== null;
  }

  analyze(): SpeechDetectionResult {
    if (!this.analyser || !this.timeDomainData) {
      return {
        isSpeaking: false,
        energy: 0,
        zeroCrossingRate: 0,
        confidence: 0,
      };
    }

    this.analyser.getFloatTimeDomainData(
      this.timeDomainData as Float32Array<ArrayBuffer>,
    );

    let sumSquares = 0;
    for (let i = 0; i < this.timeDomainData.length; i++) {
      sumSquares += this.timeDomainData[i] * this.timeDomainData[i];
    }
    const energy = Math.sqrt(sumSquares / this.timeDomainData.length);

    let zcr = 0;
    for (let i = 1; i < this.timeDomainData.length; i++) {
      zcr += Math.abs(
        Math.sign(this.timeDomainData[i]) -
          Math.sign(this.timeDomainData[i - 1]),
      );
    }
    zcr /= this.timeDomainData.length;

    const isSpeaking =
      energy > this.ENERGY_MIN &&
      energy < this.ENERGY_MAX &&
      zcr > this.ZCR_MIN &&
      zcr < this.ZCR_MAX;

    const energyConfidence = Math.max(0, 1 - Math.abs(energy - 0.05) / 0.1);
    const zcrConfidence = Math.max(0, 1 - Math.abs(zcr - 0.08) / 0.1);
    const confidence = isSpeaking ? (energyConfidence + zcrConfidence) / 2 : 0;

    return { isSpeaking, energy, zeroCrossingRate: zcr, confidence };
  }

  /**
   * NON-DISRUPTIVE drift detection
   * Samples drift during normal playback WITHOUT seeking or pausing.
   */
  detectCurrentDrift(
    cues: Array<{ startMs: number; endMs: number; text: string }>,
    currentVideoTimeSec: number,
  ): DriftSample | null {
    if (!this.isConnected || !this.analyser) {
      return null;
    }

    const currentTimeMs = currentVideoTimeSec * 1000;
    const activeCue = cues.find(
      (cue) => currentTimeMs >= cue.startMs && currentTimeMs <= cue.endMs,
    );

    if (!activeCue) {
      return null;
    }

    const analysis = this.analyze();

    if (analysis.isSpeaking && analysis.confidence > 0.5) {
      const drift = currentVideoTimeSec - activeCue.startMs / 1000;

      return {
        expectedTime: activeCue.startMs / 1000,
        detectedTime: currentVideoTimeSec,
        drift,
        confidence: analysis.confidence,
        timestamp: Date.now(),
      };
    }

    return null;
  }
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function standardDeviation(values: number[]): number {
  if (values.length === 0) return 0;
  const avg = mean(values);
  const squareDiffs = values.map((v) => Math.pow(v - avg, 2));
  return Math.sqrt(mean(squareDiffs));
}

let speechDetectorInstance: SpeechDetector | null = null;

export function getSpeechDetector(): SpeechDetector {
  if (!speechDetectorInstance) {
    speechDetectorInstance = new SpeechDetector();
  }
  return speechDetectorInstance;
}
