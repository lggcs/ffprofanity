import { describe, expect, it } from "vitest";
import { TikTokExtractor } from "../src/extractors/tiktok";

describe("TikTokExtractor", () => {
  const extractor = new TikTokExtractor();

  it("matches TikTok video and profile URLs", () => {
    expect(
      extractor.matches("https://www.tiktok.com/@dannycartelclayton/video/7363991464470138145"),
    ).toBe(true);
    expect(extractor.matches("https://tiktok.com/@user/video/123")).toBe(true);
  });

  it("does not match other sites", () => {
    expect(extractor.matches("https://www.youtube.com/watch?v=abc")).toBe(false);
    expect(extractor.matches("https://v16m-webapp.tiktokcdn-us.com/video/tos/x.mp4")).toBe(false);
  });

  it("declares no inline injected script (CSP delegation contract)", () => {
    // TikTok's CSP blocks inline <script> elements; extraction must run via
    // the MAIN-world page-script bundle injected from the background script.
    // A non-empty value here would silently break detection on TikTok.
    expect(extractor.getInjectedScript()).toBe("");
  });
});
