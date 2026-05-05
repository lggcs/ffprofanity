#!/usr/bin/env node
import fs from 'fs';

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

console.log(`Wordlist: ${wordlist.length} words\n`);

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

// Parse SRT content - handles both \r\n and \n, and handles BOM
function parseSRT(content) {
  // Strip BOM if present
  if (content.charCodeAt(0) === 0xFEFF) {
    content = content.slice(1);
  }
  
  const cues = [];
  const lines = content.split(/\r?\n/);
  
  let i = 0;
  
  while (i < lines.length) {
    // Skip blank lines
    while (i < lines.length && lines[i].trim() === '') i++;
    
    if (i >= lines.length) break;
    
    // Read cue number
    const cueNum = lines[i].trim();
    if (!/^\d+$/.test(cueNum)) {
      i++;
      continue;
    }
    i++;
    
    if (i >= lines.length) break;
    
    // Read timestamp
    const timestamp = lines[i].trim();
    if (!timestamp.includes('-->')) {
      continue;
    }
    i++;
    
    // Read text lines until blank line or next cue number
    const textLines = [];
    while (i < lines.length) {
      const line = lines[i];
      const trimmedLine = line.trim();
      
      // Stop if blank line
      if (trimmedLine === '') break;
      
      // Stop if next cue number (but only if it's at start of new block)
      if (/^\d+$/.test(trimmedLine)) {
        // Check if this looks like a new cue (previous line was blank)
        // For now, be more lenient - just check if it's followed by timestamp
        if (i + 1 < lines.length && lines[i + 1].includes('-->')) {
          break;
        }
      }
      
      // Add text (strip formatting tags)
      const text = trimmedLine.replace(/<\/?[biu]>/g, '');
      textLines.push(text);
      i++;
    }
    
    if (textLines.length > 0) {
      cues.push({
        number: parseInt(cueNum),
        timestamp,
        text: textLines.join(' ')
      });
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

// Main
const srtPath = process.argv[2] || '/home/user/Projects/ffprofanity/Houseguest (1995) Xvid-theluckyman.srt';
console.log(`Scanning: ${srtPath}\n`);

let content;
try {
  content = fs.readFileSync(srtPath, 'utf8');
  // Strip BOM if present
  if (content.charCodeAt(0) === 0xFEFF) {
    content = content.slice(1);
  }
} catch (e) {
  try {
    content = fs.readFileSync(srtPath, 'utf16le');
  } catch (e2) {
    content = fs.readFileSync(srtPath, 'latin1');
  }
}

const cues = parseSRT(content);

console.log(`Parsed ${cues.length} subtitle cues\n`);

// Scan for profanity
const profanityCues = [];
for (const cue of cues) {
  const matches = checkProfanity(cue.text);
  if (matches.length > 0) {
    profanityCues.push({
      ...cue,
      matches
    });
  }
}

console.log(`Found ${profanityCues.length} cues with potential profanity:\n`);

for (const cue of profanityCues.slice(0, 50)) {
  console.log(`[${cue.number}] ${cue.timestamp}`);
  console.log(`Text: ${cue.text}`);
  console.log(`Matches: ${cue.matches.map(m => `"${m.original}" (${m.normalized})`).join(', ')}`);
  console.log('---');
}

if (profanityCues.length > 50) {
  console.log(`\n... and ${profanityCues.length - 50} more`);
}

console.log(`\n=== Summary ===`);
console.log(`Total cues: ${cues.length}`);
console.log(`Cues with profanity: ${profanityCues.length}`);
if (cues.length > 0) {
  console.log(`Profanity rate: ${((profanityCues.length / cues.length) * 100).toFixed(2)}%`);
}