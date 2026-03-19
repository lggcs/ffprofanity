/**
 * Cue Index for O(log n) lookup during video playback
 * Uses interval tree-like structure for efficient time-based queries
 */

import type { Cue } from '../types';

interface CueNode {
  cue: Cue;
  start: number;
  end: number;
}

// Pre-mute buffer in milliseconds - mute this many ms before profanity starts
const MUTE_ADVANCE_MS = 200;
// Post-mute buffer - stay muted this many ms after profanity ends
const MUTE_DELAY_MS = 50;

export class CueIndex {
  private cues: Cue[] = [];
  private sortedByStart: CueNode[] = [];
  private profanityCues: CueNode[] = []; // Sorted list of profanity-only cues

  /**
   * Build index from cue list
   */
  build(cues: Cue[]): void {
    this.cues = cues;
    this.sortedByStart = cues
      .map(cue => ({ cue, start: cue.startMs, end: cue.endMs }))
      .sort((a, b) => a.start - b.start);

    // Build separate index for profanity cues (for faster mute lookups)
    this.profanityCues = cues
      .filter(cue => cue.hasProfanity)
      .map(cue => ({ cue, start: cue.startMs, end: cue.endMs }))
      .sort((a, b) => a.start - b.start);
  }
  
  /**
   * Find the active cue at a given timestamp (in ms)
   * Returns the first matching cue or null
   */
  findActive(timestampMs: number, offsetMs: number = 0): Cue | null {
    const adjustedTime = timestampMs + offsetMs;
    
    // Binary search for first cue that starts before or at adjustedTime
    let low = 0;
    let high = this.sortedByStart.length - 1;
    
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const node = this.sortedByStart[mid];
      
      if (node.start <= adjustedTime) {
        // Check if this cue is active
        if (node.end >= adjustedTime) {
          return node.cue;
        }
        // Look for overlapping cues
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    
    return null;
  }
  
  /**
   * Find all active cues at a given timestamp
   * Useful for overlapping subtitles
   */
  findAllActive(timestampMs: number, offsetMs: number = 0): Cue[] {
    const adjustedTime = timestampMs + offsetMs;
    const active: Cue[] = [];
    
    for (const node of this.sortedByStart) {
      if (node.start <= adjustedTime && node.end >= adjustedTime) {
        active.push(node.cue);
      }
      // Early exit if we've passed all possible matches
      if (node.start > adjustedTime) break;
    }
    
    return active;
  }
  
  /**
   * Get the next N cues after the current timestamp
   * Useful for preview/prefetch
   */
  getNextCues(timestampMs: number, count: number, offsetMs: number = 0): Cue[] {
    const adjustedTime = timestampMs + offsetMs;
    const next: Cue[] = [];
    
    for (const node of this.sortedByStart) {
      if (node.start > adjustedTime && next.length < count) {
        next.push(node.cue);
      }
    }
    
    return next;
  }
  
  /**
   * Get total duration covered by cues
   */
  getTotalDuration(): number {
    if (this.cues.length === 0) return 0;
    const lastCue = this.cues[this.cues.length - 1];
    return lastCue.endMs;
  }
  
  /**
   * Get count of cues
   */
  getCueCount(): number {
    return this.cues.length;
  }
  
  /**
   * Clear index
   */
  clear(): void {
    this.cues = [];
    this.sortedByStart = [];
    this.profanityCues = [];
  }

  /**
   * Get all cues
   */
  getAllCues(): Cue[] {
    return [...this.cues];
  }

  /**
   * Find profanity cue at given timestamp with pre-mute buffer
   * Returns the profanity cue if we should be muted, null otherwise
   */
  findProfanityCue(timestampMs: number, offsetMs: number = 0): Cue | null {
    const adjustedTime = timestampMs + offsetMs;

    // Binary search for profanity cue
    let low = 0;
    let high = this.profanityCues.length - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const node = this.profanityCues[mid];

      // Check if we're within the cue (with buffers)
      const cueStartWithBuffer = node.start - MUTE_ADVANCE_MS;
      const cueEndWithBuffer = node.end + MUTE_DELAY_MS;

      if (adjustedTime >= cueStartWithBuffer && adjustedTime < cueEndWithBuffer) {
        return node.cue;
      }

      // Adjust search range
      if (adjustedTime < node.start) {
        // We're before this cue, search earlier
        high = mid - 1;
      } else {
        // We're after this cue, search later
        low = mid + 1;
      }
    }

    return null;
  }

  /**
   * Check if we should be muted at the given timestamp
   * Returns true if within MUTE_ADVANCE_MS of a profanity cue or inside one
   */
  shouldMute(timestampMs: number, offsetMs: number = 0): boolean {
    return this.findProfanityCue(timestampMs, offsetMs) !== null;
  }

  /**
   * Get upcoming profanity cues (for pre-fetch/warning)
   */
  getUpcomingProfanity(timestampMs: number, lookaheadMs: number, offsetMs: number = 0): Cue[] {
    const adjustedTime = timestampMs + offsetMs;
    const endTime = adjustedTime + lookaheadMs;
    const upcoming: Cue[] = [];

    for (const node of this.profanityCues) {
      if (node.start >= adjustedTime && node.start <= endTime) {
        upcoming.push(node.cue);
      }
      // Early exit
      if (node.start > endTime) break;
    }

    return upcoming;
  }
}