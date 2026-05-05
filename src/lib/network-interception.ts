/**
 * Shared network interception helpers for page scripts
 *
 * These are bundled into each page script IIFE by esbuild, so imports
 * are inlined at build time — no runtime module loading needed.
 */

import { extractLanguageFromUrl, getLanguageName, isValidSubtitleUrl } from "./page-script-helpers";

/**
 * Metadata about a detected subtitle track
 */
export interface SubtitleTrack {
  url: string;
  language: string;
  label: string;
}

/**
 * Callback type for when a subtitle track URL is detected by network interception
 */
export type SubtitleDetectedCallback = (track: SubtitleTrack, source: string) => void;

/**
 * Callback type for when subtitle content is captured by network interception
 */
export type SubtitleContentCallback = (
  content: string,
  language: string,
  label: string,
  url: string,
  extra?: Record<string, unknown>,
) => void;

/**
 * Create a sendSubtitles function that posts detected tracks to the content script
 */
export function createSendSubtitles(extractorId: string) {
  const sentUrls = new Set<string>();

  return function sendSubtitles(
    subs: SubtitleTrack[],
    source: string,
  ): void {
    if (!subs || subs.length === 0) return;

    const uniqueSubs = subs.filter((s) => {
      if (!s.url) return false;
      if (!isValidSubtitleUrl(s.url)) return false;
      if (sentUrls.has(s.url)) return false;
      sentUrls.add(s.url);
      return true;
    });

    if (uniqueSubs.length === 0) return;

    window.postMessage(
      {
        type: "FFPROFANITY_SUBTITLES_DETECTED",
        source: `${extractorId}.${source}`,
        subtitles: uniqueSubs.map((s) => ({
          url: s.url,
          language: s.language || "unknown",
          label: s.label || "Unknown",
        })),
      },
      "*",
    );
  };
}

/**
 * Create a sendSubtitleContent function that posts captured content to the content script
 */
export function createSendSubtitleContent(extractorId: string) {
  const sentContent = new Set<string>();

  return function sendSubtitleContent(
    content: string,
    language: string,
    label: string,
    url?: string,
    extra?: Record<string, unknown>,
  ): void {
    const contentHash = content.length + "_" + content.indexOf("-->");
    if (sentContent.has(contentHash)) return;
    sentContent.add(contentHash);

    window.postMessage(
      {
        type: "FFPROFANITY_SUBTITLE_CONTENT",
        source: extractorId,
        content,
        language,
        label,
        ...(url ? { url } : {}),
        ...extra,
      },
      "*",
    );
  };
}

/**
 * Options for interceptXHR / interceptFetch
 */
export interface InterceptOptions {
  /** Source label for detected subtitle tracks (e.g., "xhr-subtitle") */
  subtitleSource?: string;
  /** Source label for HLS manifest detections (e.g., "xhr-hls") */
  hlsSource?: string;
  /** Source label for subtitle content captures */
  contentSource?: string;
  /** Whether to check for HLS manifests */
  checkHLS?: boolean;
  /** Whether to check for direct subtitle URLs (.vtt, .srt, .ass, .ssa) */
  checkSubtitles?: boolean;
  /** Custom URL filter: return true to process this URL */
  urlFilter?: (url: string) => boolean;
  /** Called when subtitle content is captured from a direct URL interception */
  onContent?: SubtitleContentCallback;
  /** Called for each detected HLS subtitle track before sending */
  onHLSTrack?: (track: SubtitleTrack) => void;
  /** Stream type hint (e.g., "live" or "vod") — included in content messages */
  streamType?: string;
  /** Parse HLS manifest function — injected to avoid circular deps */
  parseHLSManifest?: (content: string, baseUrl: string) => SubtitleTrack[];
  /** Fetch subtitle content function — called for each HLS track */
  fetchSubtitleContent?: (url: string, language: string, label: string, isHLSManifest: boolean) => Promise<string | null>;
}

/**
 * Install XHR interception for subtitle detection
 */
export function interceptXHR(sendSubtitles: ReturnType<typeof createSendSubtitles>, opts: InterceptOptions = {}): void {
  const {
    subtitleSource = "xhr-subtitle",
    hlsSource = "xhr-hls",
    contentSource = "xhr-intercepted",
    checkHLS = true,
    checkSubtitles = true,
    urlFilter,
    onContent,
    onHLSTrack,
    streamType,
    parseHLSManifest: parseHLS,
    fetchSubtitleContent,
  } = opts;

  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method: string, url: string) {
    (this as any)._ffprofanity_url = url;
    return originalXHROpen.apply(this, arguments as any);
  };

  XMLHttpRequest.prototype.send = function () {
    const xhr = this;
    const reqUrl = (xhr as any)._ffprofanity_url || "";

    xhr.addEventListener("load", function () {
      const canReadResponseText =
        xhr.responseType === "" || xhr.responseType === "text";

      if (urlFilter && !urlFilter(reqUrl)) return;

      // HLS manifest detection
      if (checkHLS && canReadResponseText && parseHLS) {
        if (
          reqUrl.includes(".m3u8") ||
          reqUrl.includes("master") ||
          reqUrl.includes("playlist")
        ) {
          try {
            const content = xhr.responseText;
            const subs = parseHLS(content, reqUrl);
            if (subs.length > 0) {
              sendSubtitles(subs, hlsSource);
              for (const sub of subs) {
                onHLSTrack?.(sub);
                if (fetchSubtitleContent) {
                  const isHLS = sub.url.includes(".m3u8") || sub.url.includes("subtitle") || sub.url.includes("subs");
                  fetchSubtitleContent(sub.url, sub.language, sub.label, isHLS);
                }
              }
            }
          } catch { /* not valid HLS */ }
        }
      }

      // Direct subtitle URL detection
      if (checkSubtitles && /\.(vtt|srt|ass|ssa)(\?|$)/i.test(reqUrl) && !reqUrl.includes("blob:")) {
        const lang = extractLanguageFromUrl(reqUrl);
        const label = getLanguageName(lang);
        sendSubtitles([{ url: reqUrl, language: lang, label }], subtitleSource);

        // Capture content if readable
        if (canReadResponseText && onContent) {
          const content = xhr.responseText;
          if (content && content.length > 10) {
            onContent(content, lang, label, reqUrl);
          }
        } else if (xhr.responseType === "arraybuffer" && xhr.response && onContent) {
          try {
            const decoder = new TextDecoder("utf-8");
            const content = decoder.decode(xhr.response as ArrayBuffer);
            if (content && content.length > 10) {
              onContent(content, lang, label, reqUrl);
            }
          } catch { /* ignore decode errors */ }
        }
      }
    });

    return originalXHRSend.apply(this, arguments as any);
  };
}

/**
 * Install fetch interception for subtitle detection
 */
export function interceptFetch(sendSubtitles: ReturnType<typeof createSendSubtitles>, opts: InterceptOptions = {}): void {
  const {
    subtitleSource = "fetch-subtitle",
    hlsSource = "fetch-hls",
    contentSource = "fetch-intercepted",
    checkHLS = true,
    checkSubtitles = true,
    urlFilter,
    onContent,
    onHLSTrack,
    streamType,
    parseHLSManifest: parseHLS,
    fetchSubtitleContent,
  } = opts;

  const originalFetch = window.fetch;

  (window as any).fetch = async function (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url || "";

    try {
      const response = await originalFetch.apply(this, arguments as any);

      if (urlFilter && !urlFilter(url)) return response;

      // HLS manifest detection
      if (checkHLS && parseHLS) {
        if (url.includes(".m3u8") || url.includes("master") || url.includes("playlist")) {
          try {
            const clonedResponse = response.clone();
            const content = await clonedResponse.text();
            const subs = parseHLS(content, url);
            if (subs.length > 0) {
              sendSubtitles(subs, hlsSource);
              for (const sub of subs) {
                onHLSTrack?.(sub);
                if (fetchSubtitleContent) {
                  const isHLS = sub.url.includes(".m3u8") || sub.url.includes("subtitle") || sub.url.includes("subs");
                  fetchSubtitleContent(sub.url, sub.language, sub.label, isHLS);
                }
              }
            }
          } catch { /* ignore */ }
        }
      }

      // Direct subtitle URL detection
      if (checkSubtitles && /\.(vtt|srt|ass|ssa)(\?|$)/i.test(url) && !url.includes("blob:")) {
        const lang = extractLanguageFromUrl(url);
        const label = getLanguageName(lang);
        sendSubtitles([{ url, language: lang, label }], subtitleSource);

        if (onContent) {
          try {
            const content = await response.clone().text();
            if (content && content.length > 10) {
              onContent(content, lang, label, url);
            }
          } catch { /* ignore */ }
        }
      }

      return response;
    } catch (error) {
      throw error;
    }
  };
}

/**
 * Create a shared log function that respects the debug flag
 */
export function createLog(prefix?: string): (...args: unknown[]) => void {
  const tag = prefix ? `[FFProfanity${prefix}]` : "[FFProfanity]";
  return function (...args: unknown[]) {
    if ((window as any).__FFPROFANITY_DEBUG__) {
      console.log(tag, ...args);
    }
  };
}