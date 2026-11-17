import { describe, expect, it } from "vitest";
import {
  COVERAGE_ACCEPTABLE_RATIO,
  calculateRecommendScore,
  canonicalizeTrackLabels,
  isVariantTrackLabel,
  selectBestTrack,
  sortTracksForDisplay,
  trackCoverageRatio,
  trackKey,
  trackLanguageGroup,
  upgradeDuplicateTrack,
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

describe("canonicalizeTrackLabels", () => {
  it("resolves raw codes and placeholders to language names", () => {
    const tracks = [
      track({ id: "n1", label: "ENG", language: "eng" }),
      track({ id: "n2", label: "UNKNOWN", language: "unknown" }),
      track({ id: "n3", label: "HRV", language: "" }),
    ];

    canonicalizeTrackLabels(tracks);

    expect(tracks[0]?.label).toBe("English");
    // The lone unresolvable placeholder lands in the (numbered, when several)
    // Unknown group instead of surfacing raw relay text.
    expect(tracks[1]?.label).toBe("Unknown");
    // No language field: the code token itself still resolves.
    expect(tracks[2]?.label).toBe("Croatian");
  });

  it("numbers one language as one sequence across relays, variants preserved", () => {
    // The reported lookmovie2 mixture: a page-relayed variant, a movie-access
    // relay name, and a native relay placeholder — one list, three shapes.
    const tracks = [
      track({ id: "v", label: "English 1 A", language: "eng" }),
      track({ id: "p", label: "English", language: "English" }),
      track({ id: "k", label: "UNKNOWN", language: "eng" }),
    ];

    canonicalizeTrackLabels(tracks);

    expect(tracks[0]?.label).toBe("English 1 A");
    expect(tracks[1]?.label).toBe("English 2");
    expect(tracks[2]?.label).toBe("English 3");
    // The "(a)"-style demotion prior still applies after renumbering.
    expect(isVariantTrackLabel(tracks[0]?.label ?? "")).toBe(true);

    // Idempotent: re-running the pass must not renumber.
    canonicalizeTrackLabels(tracks);
    expect(tracks.map((t) => t.label)).toEqual(["English 1 A", "English 2", "English 3"]);
  });

  it("strips a page-relayed number from a lone track", () => {
    const tracks = [track({ id: "s", label: "English 1", language: "eng" })];

    canonicalizeTrackLabels(tracks);

    expect(tracks[0]?.label).toBe("English");
  });

  it("leaves viewer-owned labels and descriptive names untouched", () => {
    const tracks = [
      track({ id: "u1", label: "MY MOVIE.srt", source: "user", language: "en" }),
      track({
        id: "p1",
        label: "English 4",
        source: "lookmovie.user-subtitle-selected",
      }),
      track({ id: "d1", label: "English SDH", language: "en" }),
    ];

    canonicalizeTrackLabels(tracks);

    expect(tracks[0]?.label).toBe("MY MOVIE.srt");
    expect(tracks[1]?.label).toBe("English 4");
    expect(tracks[2]?.label).toBe("English SDH");
  });
});

describe("canonicalizeTrackLabels — unknown group", () => {
  it("collects unresolvable placeholders into a numbered Unknown group", () => {
    const tracks = [
      track({ id: "u1", label: "UNKNOWN", language: "unknown" }),
      track({ id: "e1", label: "ENG", language: "eng" }),
      track({ id: "u2", label: "UNKNOWN", language: "unknown" }),
    ];

    canonicalizeTrackLabels(tracks);

    expect(tracks.map((t) => t.label)).toEqual([
      "Unknown 1",
      "English",
      "Unknown 2",
    ]);

    // Idempotent: later passes keep the numbers stable.
    canonicalizeTrackLabels(tracks);
    expect(tracks.map((t) => t.label)).toEqual([
      "Unknown 1",
      "English",
      "Unknown 2",
    ]);
  });

  it("renumbers the group when a member later resolves", () => {
    const tracks = [
      track({ id: "u1", label: "UNKNOWN", language: "unknown" }),
      track({ id: "u2", label: "UNKNOWN", language: "unknown" }),
      track({ id: "u3", label: "UNKNOWN", language: "unknown" }),
    ];

    canonicalizeTrackLabels(tracks);
    expect(tracks.map((t) => t.label)).toEqual([
      "Unknown 1",
      "Unknown 2",
      "Unknown 3",
    ]);

    // The labeled twin arrives by URL upgrade; the group renumbers around it.
    tracks[1]!.language = "scc";
    canonicalizeTrackLabels(tracks);
    expect(tracks.map((t) => t.label)).toEqual([
      "Unknown 1",
      "Serbian (Cyrillic)",
      "Unknown 2",
    ]);
  });

  it("leaves real relay names untouched even without a resolvable language", () => {
    const tracks = [
      track({ id: "r1", label: "Arabic (Saudia)", language: "unknown" }),
      track({ id: "r2", label: "", language: "und" }),
    ];

    canonicalizeTrackLabels(tracks);

    expect(tracks[0]?.label).toBe("Arabic (Saudia)");
    expect(tracks[1]?.label).toBe("Unknown");
  });

  it("numbers a name-labeled relay together with its coded copies", () => {
    const tracks = [
      track({ id: "c", label: "HRV", language: "hrv" }),
      track({ id: "w", label: "Croatian", language: "" }),
    ];

    canonicalizeTrackLabels(tracks);

    expect(tracks[0]?.label).toBe("Croatian 1");
    expect(tracks[1]?.label).toBe("Croatian 2");
  });
});

describe("trackLanguageGroup", () => {
  it("groups by the resolved language name", () => {
    expect(trackLanguageGroup(track({ language: "en" }))).toBe("English");
    expect(trackLanguageGroup(track({ language: "scc" }))).toBe(
      "Serbian (Cyrillic)",
    );
    expect(trackLanguageGroup(track({ label: "HRV", language: "hrv" }))).toBe(
      "Croatian",
    );
  });

  it("falls back to the relay label when it is a real name it cannot map", () => {
    expect(
      trackLanguageGroup(track({ label: "Arabic (Saudia)", language: "unknown" })),
    ).toBe("Arabic (Saudia)");
    expect(
      trackLanguageGroup(track({ label: "MOVIE.srt", source: "user", language: "" })),
    ).toBe("MOVIE.srt");
  });

  it("sends unresolved placeholders to the Unknown group", () => {
    expect(
      trackLanguageGroup(track({ label: "Unknown 3", language: "unknown" })),
    ).toBe("Unknown");
  });
});

describe("upgradeDuplicateTrack", () => {
  it("adopts language metadata from the arriving twin the stored copy lacks", () => {
    const stored = track({
      id: "stored",
      url: fullCaptions.url,
      label: "UNKNOWN",
      language: "unknown",
    });
    const twin = track({
      id: "twin",
      url: fullCaptions.url,
      label: "English SDH",
      language: "en",
      isSDH: true,
    });

    expect(upgradeDuplicateTrack(stored, twin)).toBe(true);
    expect(stored.language).toBe("en");
    expect(stored.label).toBe("English SDH");
    expect(stored.isSDH).toBe(true);
  });

  it("never downgrades a resolved copy or rewrites a viewer-owned one", () => {
    const resolved = track({ id: "r", label: "ENG", language: "eng" });
    const unknownTwin = track({
      id: "u",
      label: "UNKNOWN",
      language: "unknown",
    });
    expect(upgradeDuplicateTrack(resolved, unknownTwin)).toBe(false);
    expect(resolved.label).toBe("ENG");

    const upload = track({
      id: "up",
      label: "MOVIE.srt",
      source: "user",
      language: "",
    });
    const namedTwin = track({ id: "n", label: "English", language: "en" });
    expect(upgradeDuplicateTrack(upload, namedTwin)).toBe(false);
    expect(upload.label).toBe("MOVIE.srt");
  });

  it("is idempotent once upgraded", () => {
    const stored = track({ id: "s", label: "UNKNOWN", language: "unknown" });
    const twin = track({ id: "t", label: "ENG", language: "eng" });

    expect(upgradeDuplicateTrack(stored, twin)).toBe(true);
    expect(upgradeDuplicateTrack(stored, twin)).toBe(false);
  });
});

describe("sortTracksForDisplay", () => {
  it("orders viewer-owned, preferred language, A–Z, Unknown last", () => {
    const upload = track({
      id: "up",
      label: "MOVIE.srt",
      source: "user",
      language: "",
    });
    const en1 = track({ id: "en1", label: "English 1", language: "en" });
    const es = track({ id: "es", label: "Spanish", language: "es" });
    const hr = track({ id: "hr", label: "HRV", language: "hrv" });
    const en2 = track({ id: "en2", label: "English 2", language: "en" });
    const un1 = track({ id: "un1", label: "Unknown 1", language: "unknown" });
    const un2 = track({ id: "un2", label: "Unknown 2", language: "unknown" });

    const out = sortTracksForDisplay(
      [en1, es, hr, en2, un1, upload, un2],
      "en",
    );

    // Within each group the incoming array order survives (numbering order).
    expect(out.map((t) => t.id)).toEqual([
      "up",
      "en1",
      "en2",
      "hr",
      "es",
      "un1",
      "un2",
    ]);
  });

  it("keeps the remaining groups alphabetical when the preferred one is absent", () => {
    const en = track({ id: "en", language: "en" });
    const sq = track({ id: "sq", label: "SQ", language: "sq" });

    const out = sortTracksForDisplay([en, sq], "hu");

    // Albanian sorts before English when nothing matches the preference.
    expect(out.map((t) => t.id)).toEqual(["sq", "en"]);
  });
});
