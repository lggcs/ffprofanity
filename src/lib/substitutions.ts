/**
 * Profanity Substitutions
 *
 * Fun, family-friendly alternatives to profanity words.
 * Categories: silly, polite, random, custom
 */

export type SubstitutionCategory = 'silly' | 'polite' | 'random' | 'custom';

export interface SubstitutionMapping {
  profanity: string;              // The profanity word (normalized)
  substitutions: {
    silly: string[];              // Silly/fun alternatives
    polite: string[];             // Polite alternatives
    random: string[];             // Random/weird alternatives
  };
}

/**
 * Default substitution mappings
 * Each profanity word has multiple fun alternatives in different categories
 */
export const DEFAULT_SUBSTITUTIONS: SubstitutionMapping[] = [
  // F-word variations
  {
    profanity: 'fuck',
    substitutions: {
      silly: ['fudge', 'frick', 'freak', 'fiddlesticks', 'firetruck', 'fluffernutter', 'frock'],
      polite: ['darn', 'bother', 'drat'],
      random: ['bananas', 'noodles', 'shenanigans'],
    },
  },
  {
    profanity: 'fucking',
    substitutions: {
      silly: ['fudging', 'fricking', 'freaking', 'fiddlesticks-ing', 'flabbergasted'],
      polite: ['darned', 'blasted', 'confounded'],
      random: ['noodly', 'bananarama'],
    },
  },
  {
    profanity: 'fucker',
    substitutions: {
      silly: ['fudger', 'frick-fracker', 'fire-trucker', 'fellow'],
      polite: ['jerk', 'meanie', 'rascal'],
      random: ['noodle', 'potato'],
    },
  },

  // S-word variations
  {
    profanity: 'shit',
    substitutions: {
      silly: ['shoot', 'shiz', 'shenanigans', 'sugar', 'shucks', 'spaghetti', 'poopypants'],
      polite: ['crap', 'poop', 'dung'],
      random: ['bananas', 'noodles', 'wibbly-wobbly'],
    },
  },
  {
    profanity: 'shithead',
    substitutions: {
      silly: ['shoothead', 'sillyhead', 'poopyhead', 'noodlehead', 'spaghetti-head'],
      polite: ['dummy', 'fool', 'nitwit'],
      random: ['banana-brain', 'potato-head'],
    },
  },
  {
    profanity: 'bullshit',
    substitutions: {
      silly: ['bullshoot', 'bullroar', 'malarkey', 'flapdoodle', 'poppycock', 'codswallop'],
      polite: ['nonsense', 'rubbish', 'hogwash'],
      random: ['banana-oil', 'fairy-tales'],
    },
  },

  // B-word
  {
    profanity: 'bitch',
    substitutions: {
      silly: ['beach', 'birch', 'bench', 'britch', 'biscuit', 'butterscotch'],
      polite: ['meanie', 'jerk', 'rude person'],
      random: ['banana', 'noodle', 'pickle'],
    },
  },
  {
    profanity: 'bitchy',
    substitutions: {
      silly: ['beachy', 'britchy', 'grumpy-pants', 'crab-apple'],
      polite: ['grouchy', 'irritable', 'cranky'],
      random: ['noodly', 'bananical'],
    },
  },

  // C-word
  {
    profanity: 'cunt',
    substitutions: {
      silly: ['cant', 'coot', 'clown', 'coconut', 'cucumber', 'cabbage'],
      polite: ['jerk', 'meanie', 'unpleasant person'],
      random: ['banana', 'potato', 'noodle'],
    },
  },

  // D-word
  {
    profanity: 'dick',
    substitutions: {
      silly: ['dickens', 'dingle', 'dork', 'ding-dong', 'donut', 'duck'],
      polite: ['jerk', 'meanie', 'rascal'],
      random: ['noodle', 'banana', 'potato'],
    },
  },
  {
    profanity: 'dickhead',
    substitutions: {
      silly: ['dinglehead', 'ding-dong-head', 'dorkasaurus', 'doofus-head'],
      polite: ['jerk', 'dummy', 'fool'],
      random: ['banana-brain', 'potato-head', 'noodle-noggin'],
    },
  },

  // A-word
  {
    profanity: 'ass',
    substitutions: {
      silly: ['asterisk', 'applesauce', 'avocado', 'anteater', 'ankle'],
      polite: ['butt', 'bottom', 'rear'],
      random: ['banana', 'noodle', 'potato'],
    },
  },
  {
    profanity: 'asshole',
    substitutions: {
      silly: ['asterisk-hole', 'applesauce', 'avocado', 'ankle', 'airhead'],
      polite: ['jerk', 'meanie', 'rude person'],
      random: ['banana-peel', 'noodle-nose', 'potato-face'],
    },
  },
  {
    profanity: 'asshat',
    substitutions: {
      silly: ['asterisk-hat', 'applesauce-hat', 'avocado-hat', 'ankle-hat'],
      polite: ['jerk', 'fool', 'nitwit'],
      random: ['banana-cap', 'noodle-hat'],
    },
  },

  // P-word
  {
    profanity: 'pussy',
    substitutions: {
      silly: ['pushy', 'pussycat', 'pistol', 'pumpkin', 'pancake', 'pastry'],
      polite: ['wimp', 'coward', 'scaredy-cat'],
      random: ['banana', 'noodle', 'potato'],
    },
  },

  // Bastard
  {
    profanity: 'bastard',
    substitutions: {
      silly: ['bass-tard', 'barnacle', 'buttercup', 'biscuit-eater', 'buffoon'],
      polite: ['jerk', 'meanie', 'rascal', 'scoundrel'],
      random: ['banana-muffin', 'potato-cake', 'noodle-brain'],
    },
  },

  // Damn
  {
    profanity: 'damn',
    substitutions: {
      silly: ['darn', 'dang', 'doggone', 'dangit', 'drat', 'dagnabbit'],
      polite: ['bother', 'drat'],
      random: ['bananas', 'fiddlesticks'],
    },
  },
  {
    profanity: 'goddamn',
    substitutions: {
      silly: ['goddarn', 'goddang', 'goldarn', 'gol-durn'],
      polite: ['confounded', 'blasted'],
      random: ['banana-banana', 'noodly-goodness'],
    },
  },

  // Hell
  {
    profanity: 'hell',
    substitutions: {
      silly: ['heck', 'h-e-double-hockey-sticks', 'hades', 'hullabaloo'],
      polite: ['heck', 'darn'],
      random: ['bananas', 'noodles'],
    },
  },

  // Crap
  {
    profanity: 'crap',
    substitutions: {
      silly: ['cwap', 'cranberries', 'crackers', 'crayons', 'crumb-cake'],
      polite: ['poop', 'darn', 'shoot'],
      random: ['bananas', 'noodles', 'spaghetti'],
    },
  },

  // Whore
  {
    profanity: 'whore',
    substitutions: {
      silly: ['warlord', 'warthog', 'wombat', 'walrus', 'waffle'],
      polite: ['promiscuous person', 'tramp'],
      random: ['banana', 'noodle', 'potato'],
    },
  },

  // Slut
  {
    profanity: 'slut',
    substitutions: {
      silly: ['sloth', 'sloth-face', 'slug', 'slippers', 'slushie'],
      polite: ['tramp', 'loose person'],
      random: ['banana', 'noodle', 'potato'],
    },
  },

  // Twat
  {
    profanity: 'twat',
    substitutions: {
      silly: ['twit', 'twonk', 'twinkie', 'tweedy', 'twerp'],
      polite: ['jerk', 'fool', 'nitwit'],
      random: ['banana', 'noodle', 'wombat'],
    },
  },

  // Wanker
  {
    profanity: 'wanker',
    substitutions: {
      silly: ['waffle', 'wonka', 'weasel', 'wombat', 'waffle-iron'],
      polite: ['jerk', 'fool', 'idiot'],
      random: ['banana', 'noodle', 'potato'],
    },
  },

  // Bollocks
  {
    profanity: 'bollocks',
    substitutions: {
      silly: ['bailiffs', 'bangers', 'biscuits', 'balloons', 'bananas'],
      polite: ['nonsense', 'rubbish', 'poppycock'],
      random: ['noodly-nonsense', 'spaghetti-speak'],
    },
  },

  // Piss
  {
    profanity: 'piss',
    substitutions: {
      silly: ['fizz', 'fuzzy', 'prune', 'peach', 'pixel', 'pickle'],
      polite: ['pee', 'urinate'],
      random: ['banana', 'noodle'],
    },
  },
  {
    profanity: 'pissed',
    substitutions: {
      silly: ['ticked', 'miffed', 'fizzed', 'pickled', 'pruned'],
      polite: ['angry', 'upset', 'annoyed'],
      random: ['bananas', 'noodly'],
    },
  },

  // Cock
  {
    profanity: 'cock',
    substitutions: {
      silly: ['cork', 'chalk', 'clock', 'cabbage', 'coconut', 'cat'],
      polite: ['jerk', 'meanie'],
      random: ['banana', 'noodle', 'potato'],
    },
  },

  // Tits
  {
    profanity: 'tits',
    substitutions: {
      silly: ['tips', 'toots', 'treats', 'twinkies', 'tater-tots'],
      polite: ['breasts', 'bosom'],
      random: ['bananas', 'noodles'],
    },
  },

  // N-word replacements (for completeness - these should always be replaced)
  {
    profanity: 'nigga',
    substitutions: {
      silly: ['neighbor', 'ninja', 'noodle', 'novice', 'newbie'],
      polite: ['friend', 'brother', 'person'],
      random: ['banana', 'potato'],
    },
  },
  {
    profanity: 'nigger',
    substitutions: {
      silly: ['neighbor', 'ninja', 'noodle', 'novice', 'newbie'],
      polite: ['friend', 'brother', 'person'],
      random: ['banana', 'potato'],
    },
  },
];

/**
 * Build a lookup map for quick access
 */
export function buildSubstitutionMap(
  substitutions: SubstitutionMapping[]
): Map<string, SubstitutionMapping> {
  const map = new Map<string, SubstitutionMapping>();
  for (const sub of substitutions) {
    map.set(sub.profanity.toLowerCase(), sub);
  }
  return map;
}

/**
 * Get a random substitution for a profanity word
 */
export function getRandomSubstitution(
  word: string,
  category: SubstitutionCategory,
  substitutions: SubstitutionMapping[]
): string | null {
  const normalizedWord = word.toLowerCase();
  const map = buildSubstitutionMap(substitutions);

  const mapping = map.get(normalizedWord);
  if (!mapping) return null;

  const options = mapping.substitutions[category];
  if (!options || options.length === 0) return null;

  // Return random option
  return options[Math.floor(Math.random() * options.length)];
}

/**
 * Get all substitutions for a profanity word
 */
export function getAllSubstitutions(
  word: string,
  substitutions: SubstitutionMapping[]
): SubstitutionMapping | null {
  const normalizedWord = word.toLowerCase();
  const map = buildSubstitutionMap(substitutions);
  return map.get(normalizedWord) || null;
}

/**
 * Default substitution map instance
 */
export const DEFAULT_SUBSTITUTION_MAP = buildSubstitutionMap(DEFAULT_SUBSTITUTIONS);

/**
 * Settings for substitution behavior
 */
export interface SubstitutionSettings {
  enabled: boolean;
  category: SubstitutionCategory;
  customMappings: Map<string, string>;  // Override specific words
}