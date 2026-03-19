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

export class CueIndex {
  private cues: Cue[] = [];
  private sortedByStart: CueNode[] = [];
  
  /**
   * Build index from cue list
   */
  build(cues: Cue[]): void {
    this.cues = cues;
    this.sortedByStart = cues
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
  }
  
  /**
   * Get all cues
   */
  getAllCues(): Cue[] {
    return [...this.cues];
  }
}