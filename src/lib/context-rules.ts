/**
 * Context rules for ambiguous profanity words
 * 
 * Some words are only profane in certain contexts.
 * This module provides allow-lists and context patterns to reduce false positives.
 */

/**
 * Words that require context checking
 * These words may be flagged but should be allowed in certain contexts
 */
export const CONTEXT_DEPENDENT_WORDS = {
  // "cock" - profane in sexual context, but valid for:
  // - firearms: "guns cock", "hammer cock", "cock the gun"
  // - animals: "rooster", "cock of the walk"
  // - miscellaneous: "cockeyed", "cocktail", "cockpit"
  cock: {
    allowedPatterns: [
      /\b(guns?\s+cock|cock(ed)?\s+(the\s+)?gun|hammer\s+cock|cock\s+hammer)\b/i,
      /\b(rooster|cock\s+of\s+the|cockeyed|cocktail|cockpit|weathercock)\b/i,
      /\b\[\w*\]\s*[\[\(]?.*cock/i, // "[Guns cock]" style descriptions
    ],
    profanePatterns: [
      /\b(suck\s+cock|cock\s+suck|big\s+cock|hard\s+cock|cock\s+in|cock\s+out)\b/i,
      /\b(lick\s+cock|cock\s+head|cock\s+face)\b/i,
    ],
  },

  // "suck/sucking" - profane in sexual context, but valid for:
  // - "suck it up", "sucks to be you", "sucking up"
  // - vacuum/cleaning context
  suck: {
    allowedPatterns: [
      /\b(suck\s+up|sucking\s+up|sucks?\s+to\s+be)\b/i,
      /\b(suck\s+it\s+up|suck\s+it\s+in)\b/i,
      /\b(suck(er)?s?\s+(on|at|in)\s+(teeth|breath|air))\b/i,
    ],
    profanePatterns: [
      /\b(suck\s+(my|his|her|a|the)\s+(cock|dick|balls?))\b/i,
      /\b(cock\s+suck|dick\s+suck)\b/i,
    ],
  },
  sucking: {
    allowedPatterns: [
      /\b(sucking\s+up)\b/i,
      /\b(sucks?\s+to\s+be)\b/i,
    ],
    profanePatterns: [
      /\b(sucking\s+(cock|dick|balls?))\b/i,
    ],
  },

  // "ass" - profane as insult, but valid for:
  // - "jackass", "dumbass", etc (compound insults are themselves profane)
  // - "Ass" as abbreviation (e.g., "A.S.S.")
  // Note: We still flag "ass" but allow certain compounds
  ass: {
    allowedPatterns: [
      /\bA\.?S\.?S\.?\b/,  // Abbreviation
      /\bASS\b(?!hole|wipe|hat)/,  // Standalone ASS not followed by profane suffix
    ],
    profanePatterns: [], // Always profane in context
  },

  // "balls" - profane in sexual context, but valid for:
  // - sports: "balls", "ball game"
  // - "balls to the wall" (acceptable expression)
  balls: {
    allowedPatterns: [
      /\b(balls?\s+(game|field|court|park|room))\b/i,
      /\b(have\s+a\s+ball|having\s+a\s+ball)\b/i,  // "having a ball" = having fun
      /\b(ball\s+room|ball\s+park|ball\s+point)\b/i,
    ],
    profanePatterns: [
      /\b(suck\s+balls?|lick\s+balls?|my\s+balls?)\b/i,
    ],
  },

  // "hell" - profane as curse, but valid for:
  // - "shell" contains it
  // - "hell" as place name or concept
  hell: {
    allowedPatterns: [
      /\bshell\b/i,  // shell contains "hell"
      /\b(hells?\s+(kitchen|angels?|bells?))\b/i,  // Place names
    ],
    profanePatterns: [], // Usually flagged as mild profanity
  },

  // "dam" / "damn" - profane as curse, but valid for:
  // - "dam" (beaver dam)
  // - names/places
  damn: {
    allowedPatterns: [
      /\bbeaver\s+dam\b/i,
      /\bdam\b(?!\n)/i,  // "dam" without n is fine
    ],
    profanePatterns: [
      /\bgoddamn?\b/i,  // goddamn is definitely profane
      /\bdamn\s+(it|you|him|her|them)\b/i,
    ],
  },

  // "crap" - profane, but very mild
  // Often used as non-profane: "crap game", just meaning "bad stuff"
  crap: {
    allowedPatterns: [],  // We'll flag it but it's mild
    profanePatterns: [],
  },

  // "pussy" - profane as slang, but valid for:
  // - "pussy cat", "pussy willow" (plants/animals)
  pussy: {
    allowedPatterns: [
      /\b(pussy\s+(cat|willow|cats?))\b/i,
    ],
    profanePatterns: [],
  },

  // "hoe" - profane as slang for prostitute, but valid for:
  // - garden tool: "hoe", "garden hoe"
  hoe: {
    allowedPatterns: [
      /\b(garden\s+)?hoe(s)?\b(?!s\b)/i,  // "hoe" or "garden hoe" without profane context
      /\buse\s+(a\s+)?hoe\b/i,
      /\bhoe\s+(the\s+)?(garden|field|soil)\b/i,
    ],
    profanePatterns: [],
  },
};

/**
 * Check if a word match should be allowed based on context
 * @param word The profanity word matched
 * @param text The full text being analyzed
 * @param matchStart Start index of the match
 * @param matchEnd End index of the match
 * @returns true if the match should be ALLOWED (not flagged as profanity)
 */
export function isAllowedInContext(
  word: string,
  text: string,
  matchStart: number,
  matchEnd: number
): boolean {
  const lowerWord = word.toLowerCase();
  const rules = CONTEXT_DEPENDENT_WORDS[lowerWord as keyof typeof CONTEXT_DEPENDENT_WORDS];
  
  if (!rules) {
    return false; // No context rules = always profane if matched
  }

  // Get surrounding context (50 chars before and after)
  const contextStart = Math.max(0, matchStart - 50);
  const contextEnd = Math.min(text.length, matchEnd + 50);
  const context = text.slice(contextStart, contextEnd);

  // Check if any allowed pattern matches
  for (const pattern of rules.allowedPatterns) {
    if (pattern.test(context)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a word match is definitely profane based on context patterns
 * @param word The profanity word matched
 * @param text The full text being analyzed  
 * @param matchStart Start index of the match
 * @param matchEnd End index of the match
 * @returns confidence score (0-100) for profanity
 */
export function getProfanityConfidence(
  word: string,
  text: string,
  matchStart: number,
  matchEnd: number
): number {
  const lowerWord = word.toLowerCase();
  const rules = CONTEXT_DEPENDENT_WORDS[lowerWord as keyof typeof CONTEXT_DEPENDENT_WORDS];
  
  if (!rules) {
    return 100; // No context rules = assume 100% profane
  }

  // Get surrounding context
  const contextStart = Math.max(0, matchStart - 50);
  const contextEnd = Math.min(text.length, matchEnd + 50);
  const context = text.slice(contextStart, contextEnd);

  // Check if any profane pattern matches (higher confidence)
  for (const pattern of rules.profanePatterns) {
    if (pattern.test(context)) {
      return 100;
    }
  }

  // Check if allowed
  if (isAllowedInContext(word, text, matchStart, matchEnd)) {
    return 0;
  }

  // Default confidence for context-dependent words
  // They're probably profane unless proven otherwise
  return 75;
}