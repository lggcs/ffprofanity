#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

// Read the clean wordlist
const wordlistPath = '/home/user/Projects/ffprofanity/src/lib/wordlist.ts';
const wordlistContent = fs.readFileSync(wordlistPath, 'utf8');

// Parse wordlist from TypeScript file
const wordlistMatch = wordlistContent.match(/export const DEFAULT_WORDLIST = \[([\s\S]*?)\];/);
let wordlist = [];
if (wordlistMatch) {
  wordlist = wordlistMatch[1]
    .split('\n')
    .map(line => line.trim().replace(/^"(.*)"[,]?$/, '$1'))
    .filter(line => line && !line.startsWith('//'))
    .map(word => word.replace(/"/g, '').replace(/,$/, ''));
}

// Normalize function
function normalizeText(text) {
  const SUBSTITUTIONS = {
    '@': 'a', '4': 'a', '3': 'e', '1': 'i', '!': 'i',
    '0': 'o', '5': 's', '$': 's', '7': 't', '+': 't'
  };
  let normalized = text.toLowerCase();
  for (const [sub, replacement] of Object.entries(SUBSTITUTIONS)) {
    normalized = normalized.replace(new RegExp(`[${sub}]`, 'g'), replacement);
  }
  return normalized;
}

// Context rules for ambiguous words
const CONTEXT_RULES = {
  cock: {
    allowedPatterns: [
      /\b(guns?\s+cock|cock(ed)?\s+(the\s+)?gun|hammer\s+cock|cock\s+hammer)\b/i,
      /\b(rooster|cock\s+of\s+the|cockeyed|cocktail|cockpit|weathercock)\b/i,
      /\b\[\w*\]\s*[\[\(]?.*cock/i,
    ],
  },
  suck: {
    allowedPatterns: [
      /\b(suck\s+up|sucking\s+up|sucks?\s+to\s+be)\b/i,
      /\b(suck\s+it\s+up|suck\s+it\s+in)\b/i,
    ],
  },
  sucking: {
    allowedPatterns: [
      /\b(sucking\s+up)\b/i,
    ],
  },
};

// Create wordlist set
const wordlistSet = new Set(wordlist.map(w => normalizeText(w)));

// Parse ASS/SSA timestamp (H:MM:SS.cc) to milliseconds
function parseASSTimestamp(timestamp) {
  const match = timestamp.match(/(\d+):(\d{2}):(\d{2})\.(\d{2})/);
  if (!match) return 0;

  const hours = parseInt(match[1], 10) * 3600000;
  const minutes = parseInt(match[2], 10) * 60000;
  const seconds = parseInt(match[3], 10) * 1000;
  const centis = parseInt(match[4], 10) * 10; // centiseconds to ms

  return hours + minutes + seconds + centis;
}

// Parse ASS/SSA format
function parseASS(content) {
  // Strip BOM if present
  if (content.charCodeAt(0) === 0xFEFF) {
    content = content.slice(1);
  }
  
  const lines = content.split(/\r?\n/);
  const cues = [];
  let inEvents = false;
  let formatFields = [];
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
        formatFields = trimmed.replace(/^Format:\s*/i, '').split(',').map(f => f.trim().toLowerCase());
        continue;
      }

      if (trimmed.match(/^Dialogue:/i)) {
        // Parse dialogue line
        const dialogueContent = trimmed.replace(/^Dialogue:\s*/i, '');
        const parts = dialogueContent.split(',');

        // Need at least Start, End, Text fields
        if (parts.length < 10) continue;

        const startIndex = formatFields.indexOf('start');
        const endIndex = formatFields.indexOf('end');
        const textIndex = formatFields.indexOf('text');

        let startMs, endMs, text;
        
        if (startIndex === -1 || endIndex === -1 || textIndex === -1) {
          // Fallback to default positions
          startMs = parseASSTimestamp(parts[1] || '0:00:00.00');
          endMs = parseASSTimestamp(parts[2] || '0:00:00.00');
          // Text may contain commas, so join remaining parts
          text = parts.slice(9).join(',').replace(/\\N/gi, '\n').replace(/\\n/gi, '\n');
        } else {
          startMs = parseASSTimestamp(parts[startIndex] || '0:00:00.00');
          endMs = parseASSTimestamp(parts[endIndex] || '0:00:00.00');
          // Text may contain commas
          text = parts.slice(textIndex).join(',').replace(/\\N/gi, '\n').replace(/\\n/gi, '\n');
        }

        // Strip ASS tags
        text = text
          .replace(/\{\\[^}]*\}/g, '')  // {\tag} override tags
          .replace(/\\[a-zA-Z]([^\\}]*)/g, '')  // \tag codes
          .trim();

        if (text) {
          cues.push({
            number: ++id,
            startMs,
            endMs,
            text: text.replace(/\n/g, ' ')
          });
        }
      }
    }
  }

  return cues;
}

// Check if word is allowed in context
function isAllowedInContext(word, text, matchIndex) {
  const lowerWord = word.toLowerCase();
  const rules = CONTEXT_RULES[lowerWord];
  
  if (!rules) return false;
  
  // Get surrounding context (50 chars before and after)
  const contextStart = Math.max(0, matchIndex - 50);
  const contextEnd = Math.min(text.length, matchIndex + word.length + 50);
  const context = text.slice(contextStart, contextEnd);
  
  for (const pattern of rules.allowedPatterns) {
    if (pattern.test(context)) {
      return true;
    }
  }
  
  return false;
}

// Check for profanity
function checkProfanity(text) {
  const words = text.toLowerCase().match(/\b[\w']+\b/g) || [];
  const normalizedWords = words.map(w => normalizeText(w));
  
  const matches = [];
  for (let i = 0; i < words.length; i++) {
    if (wordlistSet.has(normalizedWords[i])) {
      // Find position in original text
      const wordIndex = text.toLowerCase().indexOf(words[i].toLowerCase());
      if (wordIndex !== -1 && !isAllowedInContext(words[i], text, wordIndex)) {
        matches.push({ original: words[i], normalized: normalizedWords[i] });
      }
    }
  }
  
  return matches;
}

// Main - scan all ASS files in subtitles directory
const subtitlesDir = process.argv[2] || '/home/user/Projects/ffprofanity/subtitles';

console.log(`Wordlist: ${wordlist.length} words\n`);
console.log(`Scanning directory: ${subtitlesDir}\n`);

const files = fs.readdirSync(subtitlesDir)
  .filter(f => f.endsWith('.ass'))
  .sort();

let totalCues = 0;
let totalProfanity = 0;
const allMatches = [];

for (const file of files) {
  const filepath = path.join(subtitlesDir, file);
  let content;
  try {
    content = fs.readFileSync(filepath, 'utf8');
    if (content.charCodeAt(0) === 0xFEFF) {
      content = content.slice(1);
    }
  } catch (e) {
    console.log(`Error reading ${file}: ${e.message}`);
    continue;
  }

  const cues = parseASS(content);
  totalCues += cues.length;

  // Scan for profanity
  for (const cue of cues) {
    const matches = checkProfanity(cue.text);
    if (matches.length > 0) {
      totalProfanity++;
      allMatches.push({
        file,
        cue,
        matches
      });
    }
  }

  console.log(`${file}: ${cues.length} cues`);
}

console.log(`\n=== Summary ===`);
console.log(`Total files: ${files.length}`);
console.log(`Total cues: ${totalCues}`);
console.log(`Cues with profanity: ${totalProfanity}`);
if (totalCues > 0) {
  console.log(`Profanity rate: ${((totalProfanity / totalCues) * 100).toFixed(2)}%`);
}

// Show samples
console.log(`\n=== Sample Profanity Cues (first 30) ===`);
for (const match of allMatches.slice(0, 30)) {
  console.log(`\n[${match.file}] Cue #${match.cue.number}`);
  console.log(`Text: ${match.cue.text.slice(0, 100)}${match.cue.text.length > 100 ? '...' : ''}`);
  console.log(`Matches: ${match.matches.map(m => `"${m.original}"`).join(', ')}`);
}

if (allMatches.length > 30) {
  console.log(`\n... and ${allMatches.length - 30} more profanity cues`);
}