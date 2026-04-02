/**
 * Library exports
 */

export { parseSubtitle, parseSRT, parseVTT, parseASS, detectFormat, sanitizeText } from './parser';
export {
  ProfanityDetector,
  createDetector,
  normalizeText,
  tokenize,
  levenshteinDistance,
  isFuzzyMatch,
  countSyllables,
  countTotalSyllables,
  estimateWordTiming,
  calibrateSpeakingRate,
  computeProfanityWindows,
  RELIGIOUS_WHITELIST,
  type SpeakingRateCalibration,
} from './detector';
export { StorageManager, storage } from './storage';
export { CueIndex } from './cueIndex';
export {
  DEFAULT_SUBSTITUTIONS,
  DEFAULT_SUBSTITUTION_MAP,
  buildSubstitutionMap,
  getRandomSubstitution,
  getAllSubstitutions,
  type SubstitutionCategory,
  type SubstitutionMapping,
  type SubstitutionSettings,
} from './substitutions';
export {
  LANGUAGE_NAMES,
  extractLanguageFromUrl,
  getLanguageName,
  languageMatches,
} from './language';