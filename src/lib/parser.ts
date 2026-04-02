/**
 * Subtitle Parser
 * Parses SRT, ASS/SSA, and WEBVTT formats into normalized Cue objects
 */

import type { Cue } from "../types";

export interface XTimestampMap {
  mpegTs: number;
  localMs: number;
  offsetMs: number;
}

export interface ParseResult {
  cues: Cue[];
  format: "srt" | "ass" | "vtt" | "xml" | "json3";
  errors: string[];
  timestampMap?: XTimestampMap;
}

/**
 * Parse timestamp from SRT format (00:00:00,000) to milliseconds
 */
function parseSRTTimestamp(timestamp: string): number {
  const match = timestamp.match(/(\d{2}):(\d{2}):(\d{2})[,\.](\d{3})/);
  if (!match) return 0;

  const hours = parseInt(match[1], 10) * 3600000;
  const minutes = parseInt(match[2], 10) * 60000;
  const seconds = parseInt(match[3], 10) * 1000;
  const millis = parseInt(match[4], 10);

  return hours + minutes + seconds + millis;
}

/**
 * Parse timestamp from WEBVTT format (00:00:00.000 or 00:00.000) to milliseconds
 */
function parseVTTTimestamp(timestamp: string): number {
  // Try full format first
  let match = timestamp.match(/(\d{2}):(\d{2}):(\d{2})\.(\d{3})/);
  if (match) {
    const hours = parseInt(match[1], 10) * 3600000;
    const minutes = parseInt(match[2], 10) * 60000;
    const seconds = parseInt(match[3], 10) * 1000;
    const millis = parseInt(match[4], 10);
    return hours + minutes + seconds + millis;
  }

  // Try short format (mm:ss.ms)
  match = timestamp.match(/(\d{2}):(\d{2})\.(\d{3})/);
  if (match) {
    const minutes = parseInt(match[1], 10) * 60000;
    const seconds = parseInt(match[2], 10) * 1000;
    const millis = parseInt(match[3], 10);
    return minutes + seconds + millis;
  }

  return 0;
}

/**
 * Parse ASS/SSA timestamp (H:MM:SS.cc) to milliseconds
 */
function parseASSTimestamp(timestamp: string): number {
  const match = timestamp.match(/(\d+):(\d{2}):(\d{2})\.(\d{2})/);
  if (!match) return 0;

  const hours = parseInt(match[1], 10) * 3600000;
  const minutes = parseInt(match[2], 10) * 60000;
  const seconds = parseInt(match[3], 10) * 1000;
  const centis = parseInt(match[4], 10) * 10;

  return hours + minutes + seconds + centis;
}

export function parseXTimestampMap(content: string): XTimestampMap | null {
  const match = content.match(
    /X-TIMESTAMP-MAP=MPEGTS:(\d+)\s*,\s*LOCAL:(\d{2}):(\d{2}):(\d{2})\.(\d{3})/i,
  );
  if (!match) return null;

  const mpegTs = parseInt(match[1], 10);
  const hours = parseInt(match[2], 10);
  const minutes = parseInt(match[3], 10);
  const seconds = parseInt(match[4], 10);
  const millis = parseInt(match[5], 10);

  const localMs = (hours * 3600 + minutes * 60 + seconds) * 1000 + millis;
  const offsetMs = Math.round(mpegTs / 90) - localMs;

  return { mpegTs, localMs, offsetMs };
}

/**
 * Determine subtitle format from content
 */
export function detectFormat(content: string): "srt" | "ass" | "vtt" | "xml" | "json3" | null {
  // Remove BOM and trim whitespace
  const trimmed = content.replace(/^\uFEFF/, "").trim();

  // YouTube JSON3 format (wireMagic: pb3)
  if (trimmed.startsWith("{") && trimmed.includes('"wireMagic"')) {
    return "json3";
  }

  // YouTube Timedtext XML format (most common from timedtext API)
  // Can be <transcript> or TTML format
  if (trimmed.match(/^<\?xml/) || trimmed.match(/<transcript[\s>]/i) || trimmed.match(/<tt\s/i)) {
    return "xml";
  }

  // WEBVTT can have optional headers after WEBVTT, e.g., "WEBVTT\nX-TIMESTAMP-MAP..."
  // Also check for YouTube's format which may have "WEBVTT" at start
  if (/^WEBVTT(?:\s|$|\n)/i.test(trimmed)) return "vtt";

  // ASS/SSA format
  if (trimmed.match(/^\[Script Info\]/i) || trimmed.match(/^[Ss][Ss][Aa]/))
    return "ass";

  // SRT format: cue number followed by timestamp
  if (trimmed.match(/^\d+\s*\r?\n\d{2}:\d{2}:\d{2}[,\.]\d{3}/)) return "srt";

  // Fallback: Try to detect by timestamp patterns (YouTube VTT often has timestamps immediately)
  // VTT timestamps use . separator for fractional seconds
  if (trimmed.match(/\d{2}:\d{2}:\d{2}\.\d{3}\s*-->/)) return "vtt";

  // SRT timestamps use , separator
  if (trimmed.match(/\d{2}:\d{2}:\d{2},\d{3}\s*-->/)) return "srt";

  return null;
}

/**
 * Create empty Cue object
 */
function createCue(
  id: number,
  startMs: number,
  endMs: number,
  text: string,
): Cue {
  const cleanedText = cleanSubtitleText(text);
  return {
    id,
    startMs,
    endMs,
    text: cleanedText,
    censoredText: cleanedText,
    hasProfanity: false,
    profanityScore: 0,
    profanityMatches: [],
  };
}

/**
 * Parse SRT format subtitles
 */
export function parseSRT(content: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = content.trim().split(/\r?\n\r?\n/);
  let id = 0;

  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    if (lines.length < 2) continue;

    // First line might be cue identifier or timestamp
    let idx = 0;
    let cueId = id;

    // Check if first line is a number (cue ID)
    if (lines[0].match(/^\d+$/)) {
      cueId = parseInt(lines[0], 10);
      idx = 1;
    }

    // Parse timestamp line
    const timestampLine = lines[idx];
    if (!timestampLine) continue;

    const timestampMatch = timestampLine.match(
      /(\d{2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,\.]\d{3})/,
    );
    if (!timestampMatch) continue;

    const startMs = parseSRTTimestamp(timestampMatch[1]);
    const endMs = parseSRTTimestamp(timestampMatch[2]);

    // Rest is text
    const text = lines
      .slice(idx + 1)
      .join("\n")
      .trim();
    if (!text) continue;

    cues.push(createCue(cueId, startMs, endMs, text));
    id++;
  }

  return cues;
}

/**
 * Parse WEBVTT format subtitles
 * @param content VTT content string
 * @param offsetMs Optional offset in milliseconds to subtract from all timestamps (for HLS segments)
 * @returns Parsed cues
 */
export function parseVTT(content: string, offsetMs: number = 0): Cue[] {
  const cues: Cue[] = [];
  const lines = content.split(/\r?\n/);
  let i = 0;
  let id = 0;

  // Skip WEBVTT header and X-TIMESTAMP-MAP
  while (i < lines.length && !lines[i].match(/\d{2}:\d{2}/)) {
    i++;
  }

  while (i < lines.length) {
    const timestampMatch = lines[i].match(
      /(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})/,
    );

    if (timestampMatch) {
      const startMs = parseVTTTimestamp(timestampMatch[1]);
      const endMs = parseVTTTimestamp(timestampMatch[2]);

      const textLines: string[] = [];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() &&
        !lines[i].match(/\d{2}:\d{2}/)
      ) {
        textLines.push(lines[i].trim());
        i++;
      }

      const text = textLines.join("\n").trim();
      const adjustedStartMs = offsetMs > 0 ? startMs - offsetMs : startMs;
      const adjustedEndMs = offsetMs > 0 ? endMs - offsetMs : endMs;

      if (text && adjustedStartMs < adjustedEndMs && adjustedStartMs >= 0) {
        cues.push(createCue(id, adjustedStartMs, adjustedEndMs, text));
        id++;
      }
    } else {
      i++;
    }
  }

  return cues;
}

export function parseASS(content: string): Cue[] {
  const cues: Cue[] = [];
  const lines = content.split(/\r?\n/);
  let inEvents = false;
  let formatFields: string[] = [];
  let id = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.match(/^\[Events\]/i)) {
      inEvents = true;
      continue;
    }

    if (trimmed.match(/^\[/) && inEvents) {
      inEvents = false;
      continue;
    }

    if (inEvents) {
      if (trimmed.match(/^Format:/i)) {
        // Parse format line
        formatFields = trimmed
          .replace(/^Format:\s*/i, "")
          .split(",")
          .map((f) => f.trim().toLowerCase());
        continue;
      }

      if (trimmed.match(/^Dialogue:/i)) {
        // Parse dialogue line
        const dialogueContent = trimmed.replace(/^Dialogue:\s*/i, "");
        const parts = dialogueContent.split(",");

        // Need at least Start, End, Text fields
        if (parts.length < 10) continue;

        const startIndex = formatFields.indexOf("start");
        const endIndex = formatFields.indexOf("end");
        const textIndex = formatFields.indexOf("text");

        if (startIndex === -1 || endIndex === -1 || textIndex === -1) {
          // Fallback to default positions
          const startMs = parseASSTimestamp(parts[1] || "0:00:00.00");
          const endMs = parseASSTimestamp(parts[2] || "0:00:00.00");
          // Text may contain commas, so join remaining parts
          const text = parts
            .slice(9)
            .join(",")
            .replace(/\\N/gi, "\n")
            .replace(/\\n/gi, "\n");

          if (text.trim()) {
            cues.push(createCue(id, startMs, endMs, text));
            id++;
          }
        } else {
          const startMs = parseASSTimestamp(parts[startIndex] || "0:00:00.00");
          const endMs = parseASSTimestamp(parts[endIndex] || "0:00:00.00");
          // Text may contain commas
          const text = parts
            .slice(textIndex)
            .join(",")
            .replace(/\\N/gi, "\n")
            .replace(/\\n/gi, "\n");

          if (text.trim()) {
            cues.push(createCue(id, startMs, endMs, text));
            id++;
          }
        }
      }
    }
  }

  return cues;
}

/**
 * Parse YouTube Timedtext XML format
 * Handles both <transcript> format and TTML format
 * 
 * YouTube <transcript> format:
 * <transcript>
 *   <text start="0" dur="2.5">Hello world</text>
 *   <text start="3" dur="1.5">How are you?</text>
 * </transcript>
 * 
 * TTML format:
 * <tt ...>
 *   <body>
 *     <div>
 *       <p begin="0s" end="2.5s">Hello world</p>
 *     </div>
 *   </body>
 * </tt>
 */
export function parseYouTubeXML(content: string): Cue[] {
  const cues: Cue[] = [];
  let id = 0;

  // Decode HTML entities
  function decodeHTMLEntities(text: string): string {
    const entities: Record<string, string> = {
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&#39;': "'",
      '&apos;': "'",
      '&nbsp;': ' ',
    };
    return text.replace(/&[^;]+;/g, (match) => entities[match] || match);
  }

  // Parse time from various formats
  function parseTime(timeStr: string): number {
    // Handle seconds (e.g., "2.5", "2.500")
    const floatMatch = timeStr.match(/^(\d+(?:\.\d+)?)$/);
    if (floatMatch) {
      return Math.round(parseFloat(floatMatch[1]) * 1000);
    }

    // Handle HH:MM:SS.mmm format
    const fullMatch = timeStr.match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (fullMatch) {
      const hours = parseInt(fullMatch[1], 10) * 3600000;
      const minutes = parseInt(fullMatch[2], 10) * 60000;
      const seconds = Math.round(parseFloat(fullMatch[3]) * 1000);
      return hours + minutes + seconds;
    }

    // Handle MM:SS.mmm format
    const shortMatch = timeStr.match(/(\d+):(\d+(?:\.\d+)?)/);
    if (shortMatch) {
      const minutes = parseInt(shortMatch[1], 10) * 60000;
      const seconds = Math.round(parseFloat(shortMatch[2]) * 1000);
      return minutes + seconds;
    }

    return 0;
  }

  // Extract text content from XML node (handling nested elements)
  function extractTextContent(node: Element): string {
    // For TTML, text might be in <span> elements
    let text = '';
    
    // Check for <span> children
    const spans = node.querySelectorAll('span');
    if (spans.length > 0) {
      spans.forEach(span => {
        text += span.textContent + ' ';
      });
      return text.trim();
    }
    
    // Use textContent directly
    return node.textContent?.trim() || '';
  }

  try {
    // Use DOMParser for browser environment
    const parser = new DOMParser();
    const doc = parser.parseFromString(content, 'text/xml');

    // Check for parsing errors
    const parseError = doc.querySelector('parsererror');
    if (parseError) {
      // Try to extract error message
      console.warn('[Parser] XML parsing error:', parseError.textContent);
      return [];
    }

    // Try YouTube <transcript> format first
    const textElements = doc.querySelectorAll('text');
    if (textElements.length > 0) {
      textElements.forEach((elem) => {
        const start = parseFloat(elem.getAttribute('start') || '0');
        const dur = parseFloat(elem.getAttribute('dur') || '0');
        const text = decodeHTMLEntities(elem.textContent?.trim() || '');

        if (text && dur > 0) {
          cues.push(createCue(
            id,
            Math.round(start * 1000),
            Math.round((start + dur) * 1000),
            text
          ));
          id++;
        }
      });

      // Sort by start time
      cues.sort((a, b) => a.startMs - b.startMs);
      return cues;
    }

    // Try TTML format
    const pElements = doc.querySelectorAll('p');
    if (pElements.length > 0) {
      pElements.forEach((elem) => {
        const begin = parseTime(elem.getAttribute('begin') || '0');
        const end = parseTime(elem.getAttribute('end') || '0');
        const text = decodeHTMLEntities(extractTextContent(elem));

        if (text && end > begin) {
          cues.push(createCue(id, begin, end, text));
          id++;
        }
      });

      cues.sort((a, b) => a.startMs - b.startMs);
      return cues;
    }

    // Try <body><div><p> structure (another TTML variant)
    const bodyElements = doc.querySelectorAll('body p, body div p');
    if (bodyElements.length > 0) {
      bodyElements.forEach((elem) => {
        const begin = parseTime(elem.getAttribute('begin') || '0');
        const end = parseTime(elem.getAttribute('end') || '0');
        const text = decodeHTMLEntities(extractTextContent(elem));

        if (text && end > begin) {
          cues.push(createCue(id, begin, end, text));
          id++;
        }
      });

      cues.sort((a, b) => a.startMs - b.startMs);
      return cues;
    }

  } catch (error) {
    console.error('[Parser] Error parsing YouTube XML:', error);
  }

  return cues;
}

/**
 * Parse YouTube JSON3 format (wireMagic: pb3)
 * This is YouTube's newer caption format returned by timedtext API.
 * 
 * Format structure:
 * {
 *   "wireMagic": "pb3",
 *   "events": [{
 *     "tStartMs": 0,
 *     "dDurationMs": 16639,
 *     "segs": [{ "utf8": "Hello" }, { "utf8": " world" }]
 *   }]
 * }
 */
export function parseYouTubeJSON3(content: string): Cue[] {
  const cues: Cue[] = [];
  let id = 0;

  try {
    const data = JSON.parse(content);
    
    // Validate it's JSON3 format
    if (data.wireMagic !== "pb3" || !Array.isArray(data.events)) {
      console.warn('[Parser] Not valid JSON3 format');
      return [];
    }

    for (const event of data.events) {
      if (!event.segs || !Array.isArray(event.segs)) continue;
      
      const startMs = event.tStartMs || 0;
      const durationMs = event.dDurationMs || 0;
      const endMs = startMs + durationMs;
      
      // Concatenate all segments into text
      const text = event.segs
        .map((seg: any) => seg.utf8 || '')
        .join('')
        .trim();
      
      if (text && durationMs > 0) {
        cues.push(createCue(id, startMs, endMs, text));
        id++;
      }
    }

    cues.sort((a, b) => a.startMs - b.startMs);
  } catch (error) {
    console.error('[Parser] Error parsing YouTube JSON3:', error);
  }

  return cues;
}

/**
 * Clean subtitle text by decoding HTML entities and stripping formatting tags
 * Handles double-encoded entities like &amp;lt; -> &lt; -> <
 */
export function cleanSubtitleText(text: string): string {
  let result = text;

  // Decode HTML entities multiple times to handle double/triple encoding
  // e.g., &amp;lt; -> &lt; -> <
  for (let i = 0; i < 3; i++) {
    const prev = result;
    const div = document.createElement("div");
    div.innerHTML = result;
    result = div.textContent || result;

    // If no change, stop decoding
    if (result === prev) break;
  }

  // Strip HTML/VTT formatting tags
  result = result.replace(/<\/?[a-zA-Z][a-zA-Z0-9]*[^>]*>/gi, '');
  result = result.replace(/<[^>]*\/>/gi, '');

  // Strip VTT voice tags: <v Speaker>
  result = result.replace(/<v\s+[^>]*>/gi, '');

  // Strip VTT class tags: <c.classname>
  result = result.replace(/<c\.[^>]*>/gi, '');

  // Strip any remaining angle bracket content (malformed tags)
  result = result.replace(/<[^>]*>/g, '');

  // Clean up whitespace
  result = result.replace(/\s+/g, ' ').trim();

  return result;
}

/**
 * Sanitize text for safe DOM insertion
 */
export function sanitizeText(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Parse subtitle content and return normalized cues
 */
export function parseSubtitle(
  content: string,
  offsetMs: number = 0,
): ParseResult {
  const format = detectFormat(content);
  const errors: string[] = [];

  if (!format) {
    errors.push(
      "Unable to detect subtitle format. Supported formats: SRT, ASS/SSA, WEBVTT, XML, JSON3",
    );
    return { cues: [], format: "srt", errors };
  }

  let cues: Cue[] = [];
  let timestampMap: XTimestampMap | undefined;

  try {
    switch (format) {
      case "srt":
        cues = parseSRT(content);
        break;
      case "ass":
        cues = parseASS(content);
        break;
      case "vtt":
        cues = parseVTT(content, offsetMs);
        timestampMap = parseXTimestampMap(content) || undefined;
        break;
      case "xml":
        cues = parseYouTubeXML(content);
        break;
      case "json3":
        cues = parseYouTubeJSON3(content);
        break;
    }

    cues.sort((a, b) => a.startMs - b.startMs);

    cues.forEach((cue, index) => {
      cue.id = index;
    });
  } catch (error) {
    errors.push(
      `Parse error: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }

  return { cues, format, errors, timestampMap };
}
