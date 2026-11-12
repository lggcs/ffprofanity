import { describe, expect, it } from "vitest";
import { PeertubeExtractor } from "../src/extractors/peertube";

// Captured live from
// https://peertube.tv/api/v1/videos/i7YNye1U2c2iCYshkQp1Ta/captions
const CAPTIONS_BODY = JSON.stringify({
  total: 1,
  data: [
    {
      language: { id: "cy", label: "Welsh" },
      automaticallyGenerated: true,
      captionPath:
        "/lazy-static/video-captions/34e5823d-3945-4fc3-9607-079522f90bee-cy.vtt",
      fileUrl:
        "https://peertube.tv/lazy-static/video-captions/34e5823d-3945-4fc3-9607-079522f90bee-cy.vtt",
      m3u8Url:
        "https://peertube.tv/static/streaming-playlists/hls/8aa4d363-7c3f-4133-8958-b8c58440640f/34e5823d-3945-4fc3-9607-079522f90bee-cy.m3u8",
      updatedAt: "2026-03-16T14:54:56.746Z",
    },
  ],
});

describe("PeertubeExtractor", () => {
  const extractor = new PeertubeExtractor();

  it("matches watch and embed path shapes on any instance", () => {
    expect(
      extractor.matches("https://peertube.tv/w/i7YNye1U2c2iCYshkQp1Ta"),
    ).toBe(true);
    expect(
      extractor.matches(
        "https://framatube.org/videos/watch/9c9de173-4d85-4c91-8a02-cf5a5d3a8b8e",
      ),
    ).toBe(true);
    expect(
      extractor.matches(
        "https://tilvids.com/videos/embed/0c1a1f2e-3d4b-5a69-8c7d-1e2f3a4b5c6d",
      ),
    ).toBe(true);
  });

  it("matches the captions API path so the background webRequest path fires", () => {
    expect(
      extractor.matches(
        "https://peertube.tv/api/v1/videos/i7YNye1U2c2iCYshkQp1Ta/captions",
      ),
    ).toBe(true);
  });

  it("does not match other sites or root /w/ paths", () => {
    expect(extractor.matches("https://www.youtube.com/watch?v=abc")).toBe(false);
    expect(extractor.matches("https://www.tiktok.com/@user/video/123")).toBe(
      false,
    );
    expect(extractor.matches("https://peertube.tv/w/")).toBe(false);
    expect(extractor.matches("https://example.com/w/short")).toBe(false);
  });

  it("extracts caption tracks from the captions API response", () => {
    const subs = extractor.extractFromResponse(
      "https://peertube.tv/api/v1/videos/i7YNye1U2c2iCYshkQp1Ta/captions",
      CAPTIONS_BODY,
    );
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      url: "https://peertube.tv/lazy-static/video-captions/34e5823d-3945-4fc3-9607-079522f90bee-cy.vtt",
      language: "cy",
      label: "Welsh (Auto)",
      source: "peertube",
    });
  });

  it("falls back to captionPath against the instance origin when fileUrl is absent", () => {
    const body = JSON.stringify({
      total: 1,
      data: [
        {
          language: { id: "en", label: "English" },
          automaticallyGenerated: false,
          captionPath: "/lazy-static/video-captions/en.vtt",
        },
      ],
    });
    const subs = extractor.extractFromResponse(
      "https://peertube.tv/api/v1/videos/uuid/captions",
      body,
    );
    expect(subs).toHaveLength(1);
    expect(subs[0]?.url).toBe("https://peertube.tv/lazy-static/video-captions/en.vtt");
    expect(subs[0]?.label).toBe("English");
  });

  it("ignores non-captions URLs and unparseable bodies", () => {
    expect(
      extractor.extractFromResponse(
        "https://peertube.tv/api/v1/videos/uuid",
        CAPTIONS_BODY,
      ),
    ).toEqual([]);
    expect(
      extractor.extractFromResponse(
        "https://peertube.tv/api/v1/videos/uuid/captions",
        "<html>not json</html>",
      ),
    ).toEqual([]);
    expect(
      extractor.extractFromResponse(
        "https://peertube.tv/api/v1/videos/uuid/captions",
        JSON.stringify({ total: 0, data: [] }),
      ),
    ).toEqual([]);
  });

  it("injects a non-empty inline detector script (no CSP on instances)", () => {
    // Unlike TikTok (CSP-gated, MAIN-world delegation), PeerTube ships no
    // CSP by default, so detection runs from the composed inline script.
    // An empty value here would silently break detection on PeerTube.
    const script = extractor.getInjectedScript();
    expect(script.length).toBeGreaterThan(50);
    expect(script).toContain("FFPROFANITY_SUBTITLES_DETECTED");
  });
});
