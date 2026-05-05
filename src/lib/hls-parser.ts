/**
 * Shared HLS manifest parser for page scripts
 *
 * Bundled into each page script IIFE by esbuild — no runtime module loading.
 */

import { SubtitleTrack } from "./network-interception";

/**
 * Parse an HLS manifest and extract subtitle track URLs
 */
export function parseHLSManifest(content: string, baseUrl: string): SubtitleTrack[] {
  const subs: SubtitleTrack[] = [];
  const lines = content.split("\n");
  let currentInfo: {
    type?: string;
    language?: string;
    label?: string;
    groupId?: string;
  } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith("#EXT-X-MEDIA:TYPE=SUBTITLES")) {
      currentInfo = { type: "subtitles" };
      const attrs = line.slice("#EXT-X-MEDIA:".length);
      const langMatch = attrs.match(/LANGUAGE="([^"]+)"/i);
      const nameMatch = attrs.match(/NAME="([^"]+)"/i);
      const groupIdMatch = attrs.match(/GROUP-ID="([^"]+)"/i);

      if (langMatch) currentInfo.language = langMatch[1].toLowerCase();
      if (nameMatch) currentInfo.label = nameMatch[1];
      if (groupIdMatch) currentInfo.groupId = groupIdMatch[1];
    }

    if (currentInfo && currentInfo.type === "subtitles" && !line.startsWith("#") && line.length > 0) {
      const subUrl = new URL(line, baseUrl).href;
      subs.push({
        url: subUrl,
        language: currentInfo.language || "unknown",
        label: currentInfo.label || currentInfo.language || "Unknown",
      });
      currentInfo = null;
    }
  }

  return subs;
}