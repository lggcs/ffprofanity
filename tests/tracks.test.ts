import { describe, expect, it } from "vitest";
import {
  COVERAGE_ACCEPTABLE_RATIO,
  calculateRecommendScore,
  isVariantTrackLabel,
  selectBestTrack,
  trackCoverageRatio,
  trackKey,
} from "../src/lib/tracks";
import type { SubtitleTrack } from "../src/types";

// Pee-wee's Big Holiday: 1:29:13.76
const DURATION_MS = 5_353_760;

const settings = { preferredLanguage: "en", preferSDH: false };

function track(overrides: Partial<SubtitleTrack>): SubtitleTrack {
  return {
    id: "t",
    label: "English",
    language: "en",
    isSDH: false,
    isDefault: false,
    source: "network",
    recommendScore: 0,
    ...overrides,
  };
}

// The site's "English 1": 400 cues, 00:02:01.999 - 00:28:13.527
const truncatedEnglish = track({
  id: "en400",
  url: "https://www.lookmovie2.to/storage6/movies/x/subtitles/en_5047d037da5aac.vtt",
  label: "English 1",
  cueCount: 400,
  firstCueMs: 121_999,
  lastCueMs: 1_693_527,
});

// The player's own caption file: 1488 cues, 00:02:00 - 01:25:32, language
// unparseable from its hashed /captions/... URL.
const fullCaptions = track({
  id: "captions",
  url: "https://www.lookmovie2.to/captions/9a/45/d8/9a45d8ca8e8acc.vtt",
  label: "UNKNOWN",
  language: "unknown",
  cueCount: 1488,
  firstCueMs: 119_587,
  lastCueMs: 5_132_344,
});

describe("trackCoverageRatio", () => {
  it("measures how much of the runtime a track reaches", () => {
    expect(trackCoverageRatio(truncatedEnglish, DURATION_MS)).toBeCloseTo(0.3163, 3);
    expect(trackCoverageRatio(fullCaptions, DURATION_MS)).toBeCloseTo(0.9587, 3);
  });

  it("returns null when the span or the runtime is unknown", () => {
    expect(trackCoverageRatio(track({ lastCueMs: undefined }), DURATION_MS)).toBeNull();
    expect(trackCoverageRatio(truncatedEnglish, 0)).toBeNull();
    expect(trackCoverageRatio(truncatedEnglish, Number.NaN)).toBeNull();
  });

  it("clamps tracks that outlast the runtime", () => {
    expect(trackCoverageRatio(track({ lastCueMs: DURATION_MS * 2 }), DURATION_MS)).toBe(1);
  });
});

describe("coverage-aware scoring", () => {
  it("prefers a complete track in an unknown language over a truncated English one", () => {
    const selection = selectBestTrack(
      [truncatedEnglish, fullCaptions],
      settings,
      { videoDurationMs: DURATION_MS },
    );

    expect(selection.track?.id).toBe("captions");
    expect(selection.autoSelected).toBe(true);
  });

  it("keeps the label-based ranking when no span has been measured yet", () => {
    const unmeasured = selectBestTrack(
      [
        track({ id: "en400", label: "English 1" }),
        track({ id: "captions", label: "UNKNOWN", language: "unknown" }),
      ],
      settings,
      { videoDurationMs: DURATION_MS },
    );

    expect(unmeasured.track?.id).toBe("en400");
  });

  it("still auto-selects a truncated track when it is the only option", () => {
    // A short-but-usable file beats showing no subtitles at all, so the
    // coverage penalty must not veto the only candidate.
    const selection = selectBestTrack([truncatedEnglish], settings, {
      videoDurationMs: DURATION_MS,
    });

    expect(selection.track?.id).toBe("en400");
    expect(selection.autoSelected).toBe(true);
  });

  it("scores a partial track below a full one even with a language match", () => {
    const partial = calculateRecommendScore(truncatedEnglish, settings, {
      videoDurationMs: DURATION_MS,
    });
    const full = calculateRecommendScore(fullCaptions, settings, {
      videoDurationMs: DURATION_MS,
    });

    expect(full).toBeGreaterThan(partial);
  });

  it("leaves the score untouched for streaming sources with an unknown duration", () => {
    const plain = calculateRecommendScore(fullCaptions, settings);
    expect(plain).toBe(calculateRecommendScore(fullCaptions, settings, { videoDurationMs: 0 }));
  });
});

describe("COVERAGE_ACCEPTABLE_RATIO", () => {
  it("accepts the full caption file but not the 400-cue English file", () => {
    expect(trackCoverageRatio(fullCaptions, DURATION_MS)!).toBeGreaterThanOrEqual(
      COVERAGE_ACCEPTABLE_RATIO,
    );
    expect(trackCoverageRatio(truncatedEnglish, DURATION_MS)!).toBeLessThan(
      COVERAGE_ACCEPTABLE_RATIO,
    );
  });
});

describe("trackKey", () => {
  it("identifies a track by URL so re-announcements match", () => {
    const announced = track({ id: "intercepted-1", url: fullCaptions.url });
    expect(trackKey(announced)).toBe(trackKey(fullCaptions));
  });

  it("falls back to the id for tracks without a URL", () => {
    expect(trackKey(track({ id: "embedded-1", url: undefined }))).toBe("embedded-1");
  });
});

describe("variant track labels", () => {
  it("recognizes lookmovie-style variant suffixes", () => {
    expect(isVariantTrackLabel("English 1 A")).toBe(true);
    expect(isVariantTrackLabel("English (a)")).toBe(true);
    expect(isVariantTrackLabel("English 2 B")).toBe(true);
    expect(isVariantTrackLabel("english 1 a")).toBe(true);
    expect(isVariantTrackLabel("English 4")).toBe(false);
    expect(isVariantTrackLabel("English")).toBe(false);
    expect(isVariantTrackLabel("English SDH")).toBe(false);
    expect(isVariantTrackLabel("UNKNOWN")).toBe(false);
  });

  it("ranks a variant release below the plain release of the same language", () => {
    const variant = track({ id: "variant", label: "English 1 A" });
    const plain = track({ id: "plain", label: "English" });
    expect(calculateRecommendScore(variant, settings)).toBeLessThan(
      calculateRecommendScore(plain, settings),
    );
  });

  it("still auto-selects a lone variant track", () => {
    // The demotion must not veto the only candidate: 10 (language) − 4 stays
    // auto-selectable, like the truncated-track coverage rule.
    const variant = track({ id: "variant", label: "English 1 A" });
    expect(calculateRecommendScore(variant, settings)).toBeGreaterThanOrEqual(0);
    const selection = selectBestTrack([variant], settings);
    expect(selection.track?.id).toBe("variant");
    expect(selection.autoSelected).toBe(true);
  });
});
