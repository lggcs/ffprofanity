import { describe, expect, it } from "vitest";
import { isSubtitleUrl, isThumbnailSubtitleUrl } from "../src/lib/extractor";

describe("isSubtitleUrl thumbnail filtering", () => {
  it("accepts dialogue subtitle URLs", () => {
    expect(isSubtitleUrl("https://cdn.example.com/subs/en_5047d037.vtt")).toBe(true);
    expect(isSubtitleUrl("https://cdn.example.com/captions/movie.en.srt")).toBe(true);
    expect(isSubtitleUrl("https://cdn.example.com/embed/iframe_player/cache/subs/19/1962268425.vtt")).toBe(true);
  });

  it("rejects sprite/thumbnail VTT tracks (JW hover previews)", () => {
    expect(isSubtitleUrl("https://vidapi.cloud/static/i0hk/1/s20v/abc/1ces6o0/thumbnails.vtt")).toBe(false);
    expect(isSubtitleUrl("https://player.example.com/api/videos/42/embed/timeslider")).toBe(false);
    expect(isSubtitleUrl("https://player.example.com/storyboard.vtt")).toBe(false);
  });

  it("still rejects fonts, mjs and manifests", () => {
    expect(isSubtitleUrl("https://cdn.example.com/fonts/sub.woff2")).toBe(false);
    expect(isSubtitleUrl("https://cdn.example.com/ui/subtitles/SubtitlesManager.mjs")).toBe(false);
    expect(isSubtitleUrl("https://cdn.example.com/stream/index.m3u8")).toBe(false);
  });

  it("rejects malformed URLs", () => {
    expect(isSubtitleUrl("not a url")).toBe(false);
    expect(isSubtitleUrl("")).toBe(false);
  });
});

describe("isThumbnailSubtitleUrl", () => {
  it("matches thumbnail track URLs", () => {
    expect(isThumbnailSubtitleUrl("https://cdn.example.com/thumbs.vtt")).toBe(true);
    expect(isThumbnailSubtitleUrl("https://cdn.example.com/x/sprite-en.webvtt")).toBe(true);
    expect(isThumbnailSubtitleUrl("https://cdn.example.com/poster.png")).toBe(true);
  });

  it("does not match dialogue subtitle URLs", () => {
    expect(isThumbnailSubtitleUrl("https://cdn.example.com/subs/en_5047d037.vtt")).toBe(false);
    expect(isThumbnailSubtitleUrl("https://cdn.example.com/embed/iframe_player/cache/subs/19/1962268425.vtt")).toBe(false);
  });
});
