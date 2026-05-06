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
    monkeys?: string[];           // Legacy: monkey fast-path in detector bypasses this entirely
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

  // Shut up
  {
    profanity: 'shut up',
    substitutions: {
      silly: ['hush up', 'hush', 'hush your mouth', 'quiet', 'quiet please'],
      polite: ['please be quiet', 'hush', 'quiet down'],
      random: ['zip it', 'shush', 'muffle'],
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
    profanity: 'damnable',
    substitutions: {
      silly: ['darnable', 'blasted', 'confounded'],
      polite: ['terrible', 'awful'],
      random: ['banana-ish', 'noodly'],
    },
  },
  {
    profanity: 'damned',
    substitutions: {
      silly: ['darned', 'danged', 'dratted'],
      polite: ['cursed', 'blighted'],
      random: ['bananad', 'noodled'],
    },
  },
  {
    profanity: 'god',
    substitutions: {
      silly: ['gosh', 'golly', 'goodness', 'gadzooks', 'gee'],
      polite: ['goodness', 'gracious'],
      random: ['banana', 'noodle'],
    },
  },
  {
    profanity: 'gods',
    substitutions: {
      silly: ['goshes', 'gollies', 'deities', 'divinities'],
      polite: ['heavens', 'goodness'],
      random: ['bananas', 'noodles'],
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

  // Jesus
  {
    profanity: 'jesus',
    substitutions: {
      silly: ['jeez', 'jeepers', 'jiminy', 'jumping-jehoshaphat', 'jiminy-cricket'],
      polite: ['goodness', 'gracious', 'heavens'],
      random: ['banana', 'noodle'],
    },
  },

  // Christ
  {
    profanity: 'christ',
    substitutions: {
      silly: ['crikey', 'crumbs', 'crickey', 'criminy', 'caramba'],
      polite: ['goodness', 'heavens'],
      random: ['banana', 'noodle'],
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
      polite: ['jerk', 'meanie', 'rascal'],
      random: ['banana', 'noodle', 'potato'],
    },
  },

  // Slut
  {
    profanity: 'slut',
    substitutions: {
      silly: ['sloth', 'sloth-face', 'slug', 'slippers', 'slushie'],
      polite: ['jerk', 'meanie', 'rascal'],
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
      polite: ['pee', 'tinkle'],
      random: ['banana', 'noodle'],
    },
  },
  {
    profanity: 'pissed',
    substitutions: {
      silly: ['ticked', 'miffed', 'fizzed', 'frazzled', 'flustered'],
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
      polite: ['jerk', 'meanie', 'dummy'],
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
  // Phrases
  {
    profanity: 'son of a bitch',
    substitutions: {
      silly: ['son of a biscuit', 'son of a gun', 'son of a sea biscuit', 'son of a sandwich'],
      polite: ['rascal', 'scoundrel', 'jerk'],
      random: ['child of a banana', 'offspring of spaghetti', 'heir of sunshine'],
    },
  },
  {
    profanity: 'swear to god',
    substitutions: {
      silly: ['promise on my popcorn', 'cross my heart', 'hope to sprout', 'swear on my sandwich', 'pinky swear'],
      polite: ['I promise', 'I assure you', 'honestly', 'truly'],
      random: ['I vow on a potato', 'may my noodles turn cold', 'by the power of pizza'],
    },
  },

  // === Root fallback entries (needed for compound-word decomposition) ===

  // Arse (British/Commonwealth) — root for arsehole, etc.
  {
    profanity: 'arse',
    substitutions: {
      silly: ['asterisk', 'avocado', 'ankle', 'applesauce', 'anteater'],
      polite: ['butt', 'bottom', 'rear'],
      random: ['banana', 'noodle', 'potato'],
    },
  },
  {
    profanity: 'arsehole',
    substitutions: {
      silly: ['asterisk-hole', 'avocado', 'ankle', 'airhead', 'applesauce'],
      polite: ['jerk', 'meanie', 'rude person'],
      random: ['banana-peel', 'noodle-nose', 'potato-face'],
    },
  },

  // Bitch compounds
  {
    profanity: 'bitchass',
    substitutions: {
      silly: ['beach-buns', 'birch-bottom', 'biscuit-booty', 'bench-bottom'],
      polite: ['total jerk', 'complete meanie'],
      random: ['banana-noodle', 'potato-cake'],
    },
  },

  // Douche
  {
    profanity: 'douche',
    substitutions: {
      silly: ['dandelion', 'dodo', 'dipstick', 'dirt-bike', 'doughnut'],
      polite: ['jerk', 'meanie', 'fool'],
      random: ['banana', 'potato', 'noodle'],
    },
  },
  {
    profanity: 'douchebag',
    substitutions: {
      silly: ['dandelion-bag', 'dodo-bag', 'dipstick', 'doughnut-bag'],
      polite: ['jerk', 'meanie', 'rascal'],
      random: ['banana-bag', 'potato-sack'],
    },
  },

  // Dumb compounds
  {
    profanity: 'dumbass',
    substitutions: {
      silly: ['silly-goose', 'numbskull', 'goofball', 'blockhead', 'dingbat'],
      polite: ['fool', 'silly person', 'unwise person'],
      random: ['noodle-head', 'potato-brain'],
    },
  },

  // Fag (slur) — family-safe substitution only, never reference the original
  {
    profanity: 'fag',
    substitutions: {
      silly: ['fog', 'fig', 'fudge', 'flag', 'fizz'],
      polite: ['jerk', 'bully', 'meanie'],
      random: ['banana', 'noodle', 'waffle'],
    },
  },

  // Hells
  {
    profanity: 'hells',
    substitutions: {
      silly: ['hecks', 'h-e-double-hockey-sticks-es', 'hadeses', 'hullaballoos'],
      polite: ['hecks', 'darns'],
      random: ['bananas', 'noodles'],
    },
  },

  // Jackass
  {
    profanity: 'jackass',
    substitutions: {
      silly: ['jack-rabbit', 'jackfruit', 'jack-in-the-box', 'jelly-bean'],
      polite: ['fool', 'nitwit', 'rascal'],
      random: ['banana-split', 'potato-head'],
    },
  },

  // MF / motherfucker (root fallback handles motherfucking, mothafucker etc.)
  {
    profanity: 'motherfucker',
    substitutions: {
      silly: ['mother-trucker', 'muffin-trucker', 'moose-tracker', 'maple-tracker'],
      polite: ['jerk', 'terrible person', 'villain'],
      random: ['banana-truck', 'noodle-wagon', 'potato-cart'],
    },
  },
  {
    profanity: 'motherfucking',
    substitutions: {
      silly: ['mother-trucking', 'muffin-trucking', 'moose-tracking'],
      polite: ['terribly', 'awfully', 'darned'],
      random: ['banana-trucking', 'noodle-riding'],
    },
  },

  // Nigg variants
  {
    profanity: 'niglet',
    substitutions: {
      silly: ['nugget', 'noodle', 'nubbin', 'newbie'],
      polite: ['child', 'youngster', 'little one'],
      random: ['banana', 'potato'],
    },
  },

  // Piss compounds
  {
    profanity: 'pissed off',
    substitutions: {
      silly: ['ticked off', 'steamed up', 'frazzled', 'flummoxed', 'discombobulated'],
      polite: ['angry', 'upset', 'annoyed'],
      random: ['bananad', 'noodled'],
    },
  },

  // Retard (slur) — must be family-safe, never reference original
  {
    profanity: 'retard',
    substitutions: {
      silly: ['noodlebrain', 'scatterbrain', 'dingbat', 'goofball'],
      polite: ['unwise person', 'someone who made a mistake'],
      random: ['banana-brain', 'potato-head'],
    },
  },

  // Skank
  {
    profanity: 'skank',
    substitutions: {
      silly: ['skunk', 'skillet', 'skate', 'skipper'],
      polite: ['jerk', 'meanie', 'rascal'],
      random: ['banana', 'noodle', 'potato'],
    },
  },

  // Trash compounds
  {
    profanity: 'white trash',
    substitutions: {
      silly: ['wild raccoon', 'wobbly washing machine', 'waffle crumbs'],
      polite: ['rude person', 'inconsiderate person'],
      random: ['banana-peel', 'noodle-strings'],
    },
  },
  // Wank compounds
  {
    profanity: 'wanking',
    substitutions: {
      silly: ['waffling', 'waltzing', 'wandering', 'wobbling'],
      polite: ['fooling around', 'dawdling'],
      random: ['banana-dancing', 'noodle-flailing'],
    },
  },

  // === Slurs and hate speech — family-safe substitutions only, never reference original meaning ===

  { profanity: 'beaner', substitutions: { silly: ['beanbag', 'bean-counter', 'bean-sprout'], polite: ['jerk', 'bully', 'meanie'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'chink', substitutions: { silly: ['chime', 'chinchilla', 'chipmunk', 'cherry'], polite: ['jerk', 'bully', 'meanie'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'gook', substitutions: { silly: ['goose', 'gopher', 'gummy-bear', 'gobstopper'], polite: ['jerk', 'bully', 'meanie'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'kike', substitutions: { silly: ['kite', 'kiwi', 'kitten', 'kale'], polite: ['jerk', 'bully', 'meanie'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'spic', substitutions: { silly: ['spice', 'sparkle', 'spinach', 'sprinkle'], polite: ['jerk', 'bully', 'meanie'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'wetback', substitutions: { silly: ['watermelon-back', 'waffle-back', 'water-slide'], polite: ['jerk', 'bully', 'meanie'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'honky', substitutions: { silly: ['honk-honk', 'hamster', 'honeycomb'], polite: ['jerk', 'bully', 'meanie'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'wop', substitutions: { silly: ['waffle', 'walrus', 'wombat', 'windmill'], polite: ['jerk', 'bully', 'meanie'], random: ['banana', 'noodle', 'pretzel'] } },
  { profanity: 'dago', substitutions: { silly: ['daisy', 'daffodil', 'dandelion'], polite: ['jerk', 'bully', 'meanie'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'dego', substitutions: { silly: ['daisy', 'daffodil', 'dandelion'], polite: ['jerk', 'bully', 'meanie'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'jap', substitutions: { silly: ['jigsaw', 'jellybean', 'jamboree', 'jalapeno'], polite: ['jerk', 'bully', 'meanie'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'kraut', substitutions: { silly: ['crouton', 'croissant', 'cucumber'], polite: ['jerk', 'bully', 'meanie'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'polack', substitutions: { silly: ['polka-dot', 'pond-skater', 'popsicle'], polite: ['jerk', 'bully', 'meanie'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'mick', substitutions: { silly: ['microwave', 'mittens', 'muffin', 'marshmallow'], polite: ['jerk', 'bully', 'meanie'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'paki', substitutions: { silly: ['panda', 'pumpkin', 'pineapple', 'pogo-stick'], polite: ['jerk', 'bully', 'meanie'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'coon', substitutions: { silly: ['coon-hound', 'cucumber', 'cupcake', 'coconut'], polite: ['jerk', 'bully', 'meanie'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'hebe', substitutions: { silly: ['honeybee', 'himalayan', 'huckleberry'], polite: ['jerk', 'bully', 'meanie'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'shylock', substitutions: { silly: ['shamrock', 'shelter', 'sherbet', 'shovel'], polite: ['jerk', 'bully', 'meanie'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'yid', substitutions: { silly: ['yodel', 'yo-yo', 'yogurt', 'yam'], polite: ['jerk', 'bully', 'meanie'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'abbo', substitutions: { silly: ['abacus', 'accordion', 'avocado'], polite: ['jerk', 'bully', 'meanie'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'macaca', substitutions: { silly: ['macaroni', 'maraca', 'mango', 'magpie'], polite: ['jerk', 'bully', 'meanie'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'sambo', substitutions: { silly: ['samba', 'sunflower', 'sandcastle'], polite: ['jerk', 'bully', 'meanie'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'nazi', substitutions: { silly: ['nacho', 'noodle-soup', 'nugget-bucket'], polite: ['villain', 'bully', 'terrible person'], random: ['banana', 'potato', 'waffle'] } },
  { profanity: 'swastika', substitutions: { silly: ['spiral', 'starburst', 'swirl', 'suncatcher'], polite: ['bad symbol', 'hate symbol'], random: ['banana', 'noodle', 'pretzel'] } },

  // === Sexual/anatomical terms — family-safe, never reference the original meaning ===

  { profanity: 'anal', substitutions: { silly: ['annual', 'antenna', 'anchovy', 'anvil'], polite: ['rude', 'inappropriate'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'anus', substitutions: { silly: ['anchor', 'ankle', 'anvil', 'avocado'], polite: ['bottom', 'rear'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'boner', substitutions: { silly: ['bongo', 'bonfire', 'bologna', 'bobsled'], polite: ['mistake', 'blunder', 'error'], random: ['banana', 'noodle', 'pretzel'] } },
  { profanity: 'clit', substitutions: { silly: ['clock', 'clam', 'cloudberry', 'clover'], polite: ['rude word', 'inappropriate word'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'cum', substitutions: { silly: ['cookie', 'cupcake', 'compass', 'cucumber'], polite: ['arrive', 'finish', 'reach'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'dildo', substitutions: { silly: ['dinosaur', 'dilapidated-duck', 'dill-pickle', 'diving-board'], polite: ['rude object', 'inappropriate item'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'hentai', substitutions: { silly: ['henna', 'helicopter', 'hemisphere', 'hemp'], polite: ['inappropriate show', 'rude cartoon'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'orgasm', substitutions: { silly: ['orchestra', 'organism', 'orangutan', 'ostrich'], polite: ['happy moment', 'thrill', 'excitement'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'porn', substitutions: { silly: ['popcorn', 'porcupine', 'porthole', 'postcard'], polite: ['inappropriate content', 'rude content', 'bad content'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'porno', substitutions: { silly: ['popcorn', 'porcupine', 'porthole', 'portobello'], polite: ['inappropriate content', 'rude content', 'bad content'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'schlong', substitutions: { silly: ['schedule', 'schnauzer', 'schooner', 'skipper'], polite: ['rude word', 'inappropriate word'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'dong', substitutions: { silly: ['dungeon', 'dodo-bird', 'dolphin', 'doorbell'], polite: ['rude word', 'inappropriate word'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'pecker', substitutions: { silly: ['peacock', 'peanut', 'pelican', 'pendulum'], polite: ['rude word', 'inappropriate word'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'choad', substitutions: { silly: ['toad', 'choir', 'chowder', 'chimichanga'], polite: ['rude word', 'inappropriate word'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'chode', substitutions: { silly: ['toad', 'choir', 'chowder', 'chimichanga'], polite: ['rude word', 'inappropriate word'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'jizz', substitutions: { silly: ['jazz', 'jigsaw', 'jamboree', 'jalapeno'], polite: ['rude word', 'inappropriate word'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'spunk', substitutions: { silly: ['spark', 'spirit', 'sparkle', 'spatula'], polite: ['courage', 'determination', 'grit'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'creampie', substitutions: { silly: ['cream-soda', 'creamsicle', 'crayon-box'], polite: ['dessert', 'pastry', 'treat'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'felch', substitutions: { silly: ['festival', 'felt-tip', 'ferry-ride'], polite: ['rude word', 'inappropriate word'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'enema', substitutions: { silly: ['enameled', 'envelope', 'encyclopedia'], polite: ['medical procedure', 'treatment'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'hooker', substitutions: { silly: ['hookah', 'hooligan', 'bookend', 'honey-hook'], polite: ['jerk', 'meanie', 'rascal'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'blowjob', substitutions: { silly: ['blow-dry', 'blowfish', 'blizzard', 'blue-jay'], polite: ['rude act', 'inappropriate act'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'handjob', substitutions: { silly: ['handstand', 'handshake', 'handball', 'handiwork'], polite: ['rude act', 'inappropriate act'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'deepthroat', substitutions: { silly: ['deep-thinker', 'deep-dish', 'deep-sea', 'deep-freeze'], polite: ['rude act', 'inappropriate act'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'rimjob', substitutions: { silly: ['rim-shot', 'riddle', 'rainbow', 'river-dance'], polite: ['rude act', 'inappropriate act'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'footjob', substitutions: { silly: ['foot-stool', 'football', 'footprint', 'footloose'], polite: ['rude act', 'inappropriate act'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'titfuck', substitutions: { silly: ['tiramisu', 'tick-tock', 'tiddly-pom'], polite: ['rude act', 'inappropriate act'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'tittyfuck', substitutions: { silly: ['tiddlywinks', 'tiramisu', 'tickle-trunk'], polite: ['rude act', 'inappropriate act'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'sixtynine', substitutions: { silly: ['sixty-eight', 'sixty-something', 'sixty-seven', 'seventy-one'], polite: ['rude number joke', 'inappropriate joke'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'threesome', substitutions: { silly: ['tricycle', 'triple-scoop', 'three-ring', 'trifecta'], polite: ['group activity', 'party'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'orgy', substitutions: { silly: ['orchard', 'orca', 'organ', 'origami'], polite: ['wild party', 'ruckus'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'gangbang', substitutions: { silly: ['gangplank', 'gangway', 'gong-show', 'gallery'], polite: ['rude act', 'inappropriate act'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'bareback', substitutions: { silly: ['horseback', 'hobby-horse', 'horse-ride', 'pony-ride'], polite: ['risky', 'careless', 'unprotected'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'lolita', substitutions: { silly: ['lollipop', 'ladybug', 'lullaby', 'lantern'], polite: ['inappropriate reference'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'shota', substitutions: { silly: ['shortbread', 'shotput', 'showtime', 'shuttle'], polite: ['inappropriate reference'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'futanari', substitutions: { silly: ['futon', 'furniture', 'future', 'fuzzy'], polite: ['inappropriate reference'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'yaoi', substitutions: { silly: ['yogurt', 'yellow', 'yoyo', 'yacht'], polite: ['inappropriate reference'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'ecchi', substitutions: { silly: ['echidna', 'eclipse', 'excalibur', 'enchilada'], polite: ['inappropriate reference'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'camgirl', substitutions: { silly: ['camper', 'campfire', 'cameo', 'camera-shy'], polite: ['inappropriate reference'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'camslut', substitutions: { silly: ['camp-stove', 'candy-stripe', 'camera-shy'], polite: ['inappropriate reference'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'camwhore', substitutions: { silly: ['camp-ground', 'canopy', 'camouflage'], polite: ['inappropriate reference'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'erotic', substitutions: { silly: ['aromatic', 'exotic', 'electric', 'energetic'], polite: ['inappropriate', 'rude'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'naked', substitutions: { silly: ['noodle', 'napping', 'nifty', 'nest'], polite: ['undressed', 'unclothed'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'topless', substitutions: { silly: ['top-hat', 'topspin', 'topaz', 'topsy-turvy'], polite: ['inappropriate'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'upskirt', substitutions: { silly: ['upside-down', 'uplifting', 'upbeat', 'upgrade'], polite: ['inappropriate'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'flasher', substitutions: { silly: ['flashlight', 'flashcard', 'flash-dance', 'flannel'], polite: ['rude person', 'troublemaker', 'pest'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'lingerie', substitutions: { silly: ['leotard', 'long-johns', 'lumber-jacket', 'laundry'], polite: ['undergarments', 'sleepwear'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'femdom', substitutions: { silly: ['femur', 'fender', 'festival', 'fern'], polite: ['rude reference'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'strapon', substitutions: { silly: ['straw', 'strap', 'streamer', 'stroller'], polite: ['rude reference'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'pegging', substitutions: { silly: ['pogo-stick', 'peg-leg', 'penguin', 'peanut-butter'], polite: ['rude reference'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'footfetish', substitutions: { silly: ['footloose', 'footprint', 'football', 'foot-stool'], polite: ['rude reference'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'kink', substitutions: { silly: ['kite', 'kitten', 'kiwi', 'kale'], polite: ['unusual preference'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'kinky', substitutions: { silly: ['kooky', 'kaleidoscopic', 'kind-hearted'], polite: ['unusual'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'fetish', substitutions: { silly: ['festival', 'feather', 'fettuccine', 'ferret'], polite: ['unusual preference'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'bdsm', substitutions: { silly: ['bobsled', 'basketball', 'butterscotch'], polite: ['rude reference'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'bondage', substitutions: { silly: ['bandage', 'bon voyage', 'boulder', 'bouquet'], polite: ['rude reference'], random: ['banana', 'noodle', 'waffle'] } },

  // === Sex-work/derogatory terms ===

  { profanity: 'bimbo', substitutions: { silly: ['bambino', 'bamboo', 'barracuda', 'bubblegum'], polite: ['ditz', 'airhead', 'flibbertigibbet'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'dyke', substitutions: { silly: ['dike', 'dime', 'dinosaur', 'dipstick'], polite: ['jerk', 'bully', 'meanie'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'milf', substitutions: { silly: ['moth', 'miniature', 'marshmallow', 'muffin'], polite: ['rude reference'], random: ['banana', 'noodle', 'waffle'] } },

  // === Violence/crime terms ===

  { profanity: 'rape', substitutions: { silly: ['grape', 'rope', 'drape', 'scrape'], polite: ['terrible act', 'crime', 'serious offense'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'pedophile', substitutions: { silly: ['pedometer', 'pelican', 'pencil', 'pedestrian'], polite: ['terrible person', 'criminal', 'monster'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'incest', substitutions: { silly: ['insect', 'instrument', 'ice-cream', 'interlude'], polite: ['terrible act', 'crime'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'beastial', substitutions: { silly: ['festival', 'bicycle', 'butterscotch', 'broccoli'], polite: ['inappropriate', 'rude'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'bestial', substitutions: { silly: ['festival', 'bicycle', 'butterscotch', 'broccoli'], polite: ['inappropriate', 'rude'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'molest', substitutions: { silly: ['moustache', 'molecule', 'muffin', 'merry-go-round'], polite: ['bother', 'pester', 'harass'], random: ['banana', 'noodle', 'waffle'] } },

  // === Compound profanity without root-word prefix match ===

  { profanity: 'apeshit', substitutions: { silly: ['banana-split', 'ape-escape', 'acrobatics', 'applesauce'], polite: ['crazy', 'wild', 'freaking out'], random: ['primate-pudding', 'noodle-explosion'] } },
  { profanity: 'bugger', substitutions: { silly: ['badger', 'bugle', 'butterfly', 'bubblegum'], polite: ['bother', 'pest', 'nuisance'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'dipshit', substitutions: { silly: ['dipstick', 'dimpling', 'dippity-doo', 'dill-pickle'], polite: ['nitwit', 'dolt', 'blockhead'], random: ['banana-brain', 'potato-head'] } },
  { profanity: 'faggot', substitutions: { silly: ['fajita', 'falcon', 'festival', 'fidget'], polite: ['jerk', 'bully', 'meanie'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'jerkoff', substitutions: { silly: ['jogger', 'jester', 'jack-in-the-box', 'jamboree'], polite: ['goofball', 'fool', 'show-off'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'limpdick', substitutions: { silly: ['limp-noodle', 'lima-bean', 'limber-lemur', 'licorice'], polite: ['wimp', 'pushover', 'weakling'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'prick', substitutions: { silly: ['praline', 'pretzel', 'pickpocket', 'pogo-stick'], polite: ['jerk', 'meanie', 'rude person'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'pimp', substitutions: { silly: ['prince', 'piper', 'pogo', 'pumpernickel'], polite: ['bully', 'exploiter', 'rascal'], random: ['banana', 'noodle', 'waffle'] } },
  { profanity: 'bollox', substitutions: { silly: ['bologna', 'bordeaux', 'broccoli', 'bubblegum'], polite: ['nonsense', 'rubbish', 'hogwash'], random: ['banana', 'noodle', 'waffle'] } },

  // Compound phrases (spaces removed by normalization)
  { profanity: 'pieceofshit', substitutions: { silly: ['piece-of-cake', 'piece-of-pie', 'piece-of-candy'], polite: ['junk', 'garbage', 'trash'], random: ['banana-split', 'noodle-soup'] } },
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

  // Monkey category is handled by fast-path in ProfanityDetector, not here
  if (category === 'monkeys') return null;

  const validCategories = ['silly', 'polite', 'random'] as const;
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