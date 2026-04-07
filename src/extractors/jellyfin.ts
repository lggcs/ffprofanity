/**
 * Jellyfin Extractor
 * Handles subtitle detection for Jellyfin media server instances
 * 
 * URL patterns:
 * - http://localhost:8096/web/#/video
 * - http://[IP]:8096/web/
 * - https://jellyfin.example.com/web/
 */

import { BaseExtractor, type DetectedSubtitle } from "./base";

export class JellyfinExtractor extends BaseExtractor {
  name = "jellyfin";
  
  patterns = [
    // Local instances
    /^https?:\/\/localhost:\d+\/web/i,
    /^https?:\/\/127\.0\.0\.1:\d+\/web/i,
    /^https?:\/\/[\w.-]+:\d+\/web/i,
    // Local network with :8096
    /^https?:\/\/[\w.-]+:8096/i,
    // Direct video URLs
    /\/web\/.*[#&]?videoId=/i,
    // Generic jellyfin paths
    /jellyfin/i,
  ];

  getInjectedScript(): string {
    return `
      // Jellyfin page script is loaded separately
      // See: src/page-scripts/jellyfin-injected.ts
    `;
  }

  /**
   * Extract from Jellyfin API response
   * PlaybackInfo contains MediaStreams with subtitle info
   */
  extractFromResponse(url: string, responseText: string): DetectedSubtitle[] {
    const subs: DetectedSubtitle[] = [];

    // Check for PlaybackInfo API response
    if (url.includes("/PlaybackInfo") || url.includes("/playbackInfo")) {
      try {
        const data = JSON.parse(responseText);
        
        // MediaStreams contains subtitle tracks
        const mediaStreams = data.MediaStreams || [];
        for (const stream of mediaStreams) {
          if (stream.Type === "Subtitle") {
            // Check if this is an external subtitle with a URL
            const deliveryUrl = stream.DeliveryUrl || stream.Path;
            if (deliveryUrl) {
              // Build full URL if relative
              let subtitleUrl = deliveryUrl;
              if (!deliveryUrl.startsWith("http")) {
                // Extract base URL from the request
                try {
                  const baseUrl = new URL(url).origin;
                  subtitleUrl = baseUrl + (deliveryUrl.startsWith("/") ? "" : "/") + deliveryUrl;
                } catch (e) {
                  // Use as-is if URL parsing fails
                }
              }

              subs.push({
                url: subtitleUrl,
                language: stream.Language || "unknown",
                label: stream.DisplayTitle || `Track ${stream.Index}`,
                source: "jellyfin-playbackInfo",
              });
            }
          }
        }
      } catch (e) {
        // Not JSON or parsing error - ignore
      }
    }

    return subs;
  }
}

// Singleton instance
export const jellyfinExtractor = new JellyfinExtractor();