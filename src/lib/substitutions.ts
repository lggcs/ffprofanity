/**
 * Profanity Substitutions
 *
 * Fun, family-friendly alternatives to profanity words.
 * Categories: silly, polite, random, monkeys, custom
 */

export type SubstitutionCategory = 'silly' | 'polite' | 'random' | 'monkeys' | 'custom';

export interface SubstitutionMapping {
  profanity: string;              // The profanity word (normalized)
  substitutions: {
    silly: string[];              // Silly/fun alternatives
    polite: string[];             // Polite alternatives
    random: string[];             // Random/weird alternatives
    monkeys: string[];            // Monkey emoji alternatives
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
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },
  {
    profanity: 'fucking',
    substitutions: {
      silly: ['fudging', 'fricking', 'freaking', 'fiddlesticks-ing', 'flabbergasted'],
      polite: ['darned', 'blasted', 'confounded'],
      random: ['noodly', 'bananarama'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },
  {
    profanity: 'fucker',
    substitutions: {
      silly: ['fudger', 'frick-fracker', 'fire-trucker', 'fellow'],
      polite: ['jerk', 'meanie', 'rascal'],
      random: ['noodle', 'potato'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },

  // S-word variations
  {
    profanity: 'shit',
    substitutions: {
      silly: ['shoot', 'shiz', 'shenanigans', 'sugar', 'shucks', 'spaghetti', 'poopypants'],
      polite: ['crap', 'poop', 'dung'],
      random: ['bananas', 'noodles', 'wibbly-wobbly'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },
  {
    profanity: 'shithead',
    substitutions: {
      silly: ['shoothead', 'sillyhead', 'poopyhead', 'noodlehead', 'spaghetti-head'],
      polite: ['dummy', 'fool', 'nitwit'],
      random: ['banana-brain', 'potato-head'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },
  {
    profanity: 'bullshit',
    substitutions: {
      silly: ['bullshoot', 'bullroar', 'malarkey', 'flapdoodle', 'poppycock', 'codswallop'],
      polite: ['nonsense', 'rubbish', 'hogwash'],
      random: ['banana-oil', 'fairy-tales'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },

  // Shut up
  {
    profanity: 'shut up',
    substitutions: {
      silly: ['hush up', 'hush', 'hush your mouth', 'quiet', 'quiet please'],
      polite: ['please be quiet', 'hush', 'quiet down'],
      random: ['zip it', 'shush', 'muffle'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },

  // B-word
  {
    profanity: 'bitch',
    substitutions: {
      silly: ['beach', 'birch', 'bench', 'britch', 'biscuit', 'butterscotch'],
      polite: ['meanie', 'jerk', 'rude person'],
      random: ['banana', 'noodle', 'pickle'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },
  {
    profanity: 'bitchy',
    substitutions: {
      silly: ['beachy', 'britchy', 'grumpy-pants', 'crab-apple'],
      polite: ['grouchy', 'irritable', 'cranky'],
      random: ['noodly', 'bananical'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },

  // C-word
  {
    profanity: 'cunt',
    substitutions: {
      silly: ['cant', 'coot', 'clown', 'coconut', 'cucumber', 'cabbage'],
      polite: ['jerk', 'meanie', 'unpleasant person'],
      random: ['banana', 'potato', 'noodle'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },

  // D-word
  {
    profanity: 'dick',
    substitutions: {
      silly: ['dickens', 'dingle', 'dork', 'ding-dong', 'donut', 'duck'],
      polite: ['jerk', 'meanie', 'rascal'],
      random: ['noodle', 'banana', 'potato'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },
  {
    profanity: 'dickhead',
    substitutions: {
      silly: ['dinglehead', 'ding-dong-head', 'dorkasaurus', 'doofus-head'],
      polite: ['jerk', 'dummy', 'fool'],
      random: ['banana-brain', 'potato-head', 'noodle-noggin'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },

  // A-word
  {
    profanity: 'ass',
    substitutions: {
      silly: ['asterisk', 'applesauce', 'avocado', 'anteater', 'ankle'],
      polite: ['butt', 'bottom', 'rear'],
      random: ['banana', 'noodle', 'potato'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },
  {
    profanity: 'asshole',
    substitutions: {
      silly: ['asterisk-hole', 'applesauce', 'avocado', 'ankle', 'airhead'],
      polite: ['jerk', 'meanie', 'rude person'],
      random: ['banana-peel', 'noodle-nose', 'potato-face'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },
  {
    profanity: 'asshat',
    substitutions: {
      silly: ['asterisk-hat', 'applesauce-hat', 'avocado-hat', 'ankle-hat'],
      polite: ['jerk', 'fool', 'nitwit'],
      random: ['banana-cap', 'noodle-hat'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },

  // P-word
  {
    profanity: 'pussy',
    substitutions: {
      silly: ['pushy', 'pussycat', 'pistol', 'pumpkin', 'pancake', 'pastry'],
      polite: ['wimp', 'coward', 'scaredy-cat'],
      random: ['banana', 'noodle', 'potato'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },

  // Bastard
  {
    profanity: 'bastard',
    substitutions: {
      silly: ['bass-tard', 'barnacle', 'buttercup', 'biscuit-eater', 'buffoon'],
      polite: ['jerk', 'meanie', 'rascal', 'scoundrel'],
      random: ['banana-muffin', 'potato-cake', 'noodle-brain'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },

  // Damn
  {
    profanity: 'damn',
    substitutions: {
      silly: ['darn', 'dang', 'doggone', 'dangit', 'drat', 'dagnabbit'],
      polite: ['bother', 'drat'],
      random: ['bananas', 'fiddlesticks'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },
  {
    profanity: 'damnable',
    substitutions: {
      silly: ['darnable', 'blasted', 'confounded'],
      polite: ['terrible', 'awful'],
      random: ['banana-ish', 'noodly'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },
  {
    profanity: 'damned',
    substitutions: {
      silly: ['darned', 'danged', 'dratted'],
      polite: ['cursed', 'blighted'],
      random: ['bananad', 'noodled'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },
  {
    profanity: 'god',
    substitutions: {
      silly: ['gosh', 'golly', 'goodness', 'gadzooks', 'gee'],
      polite: ['goodness', 'gracious'],
      random: ['banana', 'noodle'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },
  {
    profanity: 'gods',
    substitutions: {
      silly: ['goshes', 'gollies', 'deities', 'divinities'],
      polite: ['heavens', 'goodness'],
      random: ['bananas', 'noodles'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },
  {
    profanity: 'goddamn',
    substitutions: {
      silly: ['goddarn', 'goddang', 'goldarn', 'gol-durn'],
      polite: ['confounded', 'blasted'],
      random: ['banana-banana', 'noodly-goodness'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },

  // Hell
  {
    profanity: 'hell',
    substitutions: {
      silly: ['heck', 'h-e-double-hockey-sticks', 'hades', 'hullabaloo'],
      polite: ['heck', 'darn'],
      random: ['bananas', 'noodles'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },

  // Jesus
  {
    profanity: 'jesus',
    substitutions: {
      silly: ['jeez', 'jeepers', 'jiminy', 'jumping-jehoshaphat', 'jiminy-cricket'],
      polite: ['goodness', 'gracious', 'heavens'],
      random: ['banana', 'noodle'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },

  // Christ
  {
    profanity: 'christ',
    substitutions: {
      silly: ['crikey', 'crumbs', 'crickey', 'criminy', 'caramba'],
      polite: ['goodness', 'heavens'],
      random: ['banana', 'noodle'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },

  // Crap
  {
    profanity: 'crap',
    substitutions: {
      silly: ['cwap', 'cranberries', 'crackers', 'crayons', 'crumb-cake'],
      polite: ['poop', 'darn', 'shoot'],
      random: ['bananas', 'noodles', 'spaghetti'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },

  // Whore
  {
    profanity: 'whore',
    substitutions: {
      silly: ['warlord', 'warthog', 'wombat', 'walrus', 'waffle'],
      polite: ['jerk', 'meanie', 'rascal'],
      random: ['banana', 'noodle', 'potato'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },

  // Slut
  {
    profanity: 'slut',
    substitutions: {
      silly: ['sloth', 'sloth-face', 'slug', 'slippers', 'slushie'],
      polite: ['jerk', 'meanie', 'rascal'],
      random: ['banana', 'noodle', 'potato'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },

  // Twat
  {
    profanity: 'twat',
    substitutions: {
      silly: ['twit', 'twonk', 'twinkie', 'tweedy', 'twerp'],
      polite: ['jerk', 'fool', 'nitwit'],
      random: ['banana', 'noodle', 'wombat'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },

  // Wanker
  {
    profanity: 'wanker',
    substitutions: {
      silly: ['waffle', 'wonka', 'weasel', 'wombat', 'waffle-iron'],
      polite: ['jerk', 'fool', 'idiot'],
      random: ['banana', 'noodle', 'potato'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },

  // Bollocks
  {
    profanity: 'bollocks',
    substitutions: {
      silly: ['bailiffs', 'bangers', 'biscuits', 'balloons', 'bananas'],
      polite: ['nonsense', 'rubbish', 'poppycock'],
      random: ['noodly-nonsense', 'spaghetti-speak'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },

  // Piss
  {
    profanity: 'piss',
    substitutions: {
      silly: ['fizz', 'fuzzy', 'prune', 'peach', 'pixel', 'pickle'],
      polite: ['pee', 'tinkle'],
      random: ['banana', 'noodle'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },
  {
    profanity: 'pissed',
    substitutions: {
      silly: ['ticked', 'miffed', 'fizzed', 'frazzled', 'flustered'],
      polite: ['angry', 'upset', 'annoyed'],
      random: ['bananas', 'noodly'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },

  // Cock
  {
    profanity: 'cock',
    substitutions: {
      silly: ['cork', 'chalk', 'clock', 'cabbage', 'coconut', 'cat'],
      polite: ['jerk', 'meanie'],
      random: ['banana', 'noodle', 'potato'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },

  // Tits
  {
    profanity: 'tits',
    substitutions: {
      silly: ['tips', 'toots', 'treats', 'twinkies', 'tater-tots'],
      polite: ['jerk', 'meanie', 'dummy'],
      random: ['bananas', 'noodles'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },

  // N-word replacements (for completeness - these should always be replaced)
  {
    profanity: 'nigga',
    substitutions: {
      silly: ['neighbor', 'ninja', 'noodle', 'novice', 'newbie'],
      polite: ['friend', 'brother', 'person'],
      random: ['banana', 'potato'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },
  {
    profanity: 'nigger',
    substitutions: {
      silly: ['neighbor', 'ninja', 'noodle', 'novice', 'newbie'],
      polite: ['friend', 'brother', 'person'],
      random: ['banana', 'potato'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },
  // Phrases
  {
    profanity: 'son of a bitch',
    substitutions: {
      silly: ['son of a biscuit', 'son of a gun', 'son of a sea biscuit', 'son of a sandwich'],
      polite: ['rascal', 'scoundrel', 'jerk'],
      random: ['child of a banana', 'offspring of spaghetti', 'heir of sunshine'],
      monkeys: ['🙈', '🙉', '🙊'],
    },
  },
  {
    profanity: 'swear to god',
    substitutions: {
      silly: ['promise on my popcorn', 'cross my heart', 'hope to sprout', 'swear on my sandwich', 'pinky swear'],
      polite: ['I promise', 'I assure you', 'honestly', 'truly'],
      random: ['I vow on a potato', 'may my noodles turn cold', 'by the power of pizza'],
      monkeys: ['🙈', '🙉', '🙊'],
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

  // Only use valid categories that exist in the substitutions map
  const validCategories = ['silly', 'polite', 'random', 'monkeys'] as const;
  const validCategory = validCategories.includes(category as typeof validCategories[number])
    ? category as typeof validCategories[number]
    : 'silly';

  const options = mapping.substitutions[validCategory];
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