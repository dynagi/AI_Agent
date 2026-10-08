/**
 * What AURA knows about everyday things people order, so "order milk" can be turned into the right search and the
 * right product on the store page. Everything here is plain data; services/orderIntent.ts reads it.
 *
 * A *dimension* is one thing that can differ between products of the same kind (milk: type; momos: filling).
 * Each choice in a dimension has `terms` (words that mean it, including what stores print on the pack, e.g. Amul "Taaza" = toned)
 * and `avoid` (words that mean a *different* choice, so "toned" does not match "double toned").
 */

export type OrderCategory = 'grocery' | 'food';

export interface Choice { key: string; terms: string[]; avoid?: string[] }
export interface Option { label: string; choices: Record<string, string>; size?: string }
export interface Spec {
  category: OrderCategory;
  /** Words that name the item. The first one is the canonical head used to match product names. */
  aliases: string[];
  dims?: Record<string, Choice[]>;
  /** Dimensions the user must have decided before AURA picks a product. */
  required?: string[];
  question?: string;
  /** One-tap answers shown when something required is missing. */
  options?: Option[];
  sizes?: string[];
  brands?: string[];
  /** Product names containing these are never the item (chocolate "milk", milk "powder"…). A word the user typed is removed from this list. */
  exclude?: string[];
  /** Sold in fixed packs: "12 eggs" means the pack of 12. */
  packCount?: boolean;
}

const dim = (rows: [string, string[], string[]?][]): Choice[] => rows.map(([key, terms, avoid]) => ({ key, terms, avoid }));

const MILK_TYPES = dim([
  ['toned', ['toned', 'taaza'], ['double toned', 'full cream', 'skimmed', 'slim', 'a2', 'buffalo', 'gold']],
  ['double toned', ['double toned', 'dtm'], ['full cream', 'skimmed', 'a2', 'buffalo', 'gold']],
  ['full cream', ['full cream', 'gold', 'whole'], ['toned', 'skimmed', 'slim']],
  ['skimmed', ['skimmed', 'skim', 'slim'], ['full cream', 'gold']],
  ['cow', ['cow'], ['buffalo']],
  ['buffalo', ['buffalo'], ['cow']],
  ['a2', ['a2']],
  ['oat', ['oat']], ['almond', ['almond']], ['soy', ['soy', 'soya']],
]);

export const CATALOG: Record<string, Spec> = {
  milk: {
    category: 'grocery', aliases: ['milk', 'doodh'], dims: { type: MILK_TYPES }, required: ['type'],
    question: 'Which milk would you like?',
    options: [
      { label: 'Toned · 500 ml', choices: { type: 'toned' }, size: '500 ml' },
      { label: 'Toned · 1 L', choices: { type: 'toned' }, size: '1 l' },
      { label: 'Full cream · 500 ml', choices: { type: 'full cream' }, size: '500 ml' },
      { label: 'Full cream · 1 L', choices: { type: 'full cream' }, size: '1 l' },
      { label: 'Cow milk · 500 ml', choices: { type: 'cow' }, size: '500 ml' },
      { label: 'Double toned · 500 ml', choices: { type: 'double toned' }, size: '500 ml' },
    ],
    sizes: ['500 ml', '1 l', '2 l'],
    brands: ['amul', 'mother dairy', 'nandini', 'heritage', 'nestle', 'epigamia', 'country delight', 'gokul', 'parag', 'verka', 'milky mist', 'akshayakalpa'],
    exclude: ['chocolate', 'shake', 'powder', 'cake', 'cookie', 'cookies', 'biscuit', 'biscuits', 'bar', 'bread', 'ice cream', 'coffee', 'tea', 'soap', 'lotion', 'mix', 'masala', 'paneer', 'curd', 'butter', 'ghee', 'peda', 'sweet', 'cadbury', 'dairy milk', 'milkybar', 'horlicks', 'bournvita', 'boost', 'complan', 'condensed', 'creamer', 'whitener', 'cereal', 'cornflakes', 'muesli', 'face', 'body'],
  },
  curd: {
    category: 'grocery', aliases: ['curd', 'dahi', 'yogurt', 'yoghurt'],
    dims: { type: dim([['plain', ['plain', 'fresh', 'set']], ['greek', ['greek']], ['probiotic', ['probiotic']], ['low fat', ['low fat', 'light']]]) },
    sizes: ['200 g', '400 g', '1 kg'], brands: ['amul', 'mother dairy', 'epigamia', 'nestle', 'milky mist'],
    exclude: ['rice', 'chips', 'dip', 'masala', 'seasoning', 'flavoured', 'shake', 'lassi'],
  },
  egg: {
    category: 'grocery', aliases: ['egg', 'eggs', 'anda'], packCount: true,
    dims: { type: dim([['white', ['white']], ['brown', ['brown']], ['farm', ['farm fresh', 'farm']], ['protein', ['protein', 'omega']]]) },
    sizes: ['6', '12', '30'], brands: ['eggoz', 'keggs', 'suguna'],
    exclude: ['noodles', 'roll', 'curry', 'bhurji', 'boiled', 'masala', 'mayonnaise', 'mayo', 'sandwich', 'pasta', 'chocolate', 'cake', 'cookies'],
  },
  bread: {
    category: 'grocery', aliases: ['bread', 'pav'], required: ['type'], question: 'Which bread?',
    dims: { type: dim([['white', ['white', 'sandwich']], ['brown', ['brown', 'whole wheat', 'atta']], ['multigrain', ['multigrain', 'multi grain']], ['pav', ['pav', 'bun']]]) },
    options: [
      { label: 'White sandwich', choices: { type: 'white' } }, { label: 'Brown / whole wheat', choices: { type: 'brown' } },
      { label: 'Multigrain', choices: { type: 'multigrain' } }, { label: 'Pav', choices: { type: 'pav' } },
    ],
    brands: ['britannia', 'harvest gold', 'modern', 'english oven', 'amul'],
    exclude: ['crumbs', 'sticks', 'pakora', 'masala', 'spread', 'jam', 'butter', 'pizza'],
  },
  butter: { category: 'grocery', aliases: ['butter', 'makhan'], brands: ['amul', 'mother dairy', 'nandini'], sizes: ['100 g', '500 g'], exclude: ['peanut', 'chicken', 'masala', 'cookies', 'biscuit', 'popcorn', 'naan', 'paneer', 'milk', 'cake', 'lotion', 'body'] },
  paneer: { category: 'grocery', aliases: ['paneer'], brands: ['amul', 'mother dairy', 'milky mist'], sizes: ['200 g', '500 g'], exclude: ['tikka', 'masala', 'butter', 'curry', 'roll', 'pizza', 'burger', 'sandwich', 'pakora', 'biryani', 'spread', 'frozen'] },
  atta: { category: 'grocery', aliases: ['atta', 'wheat flour'], brands: ['aashirvaad', 'pillsbury', 'fortune', 'annapurna'], sizes: ['1 kg', '5 kg', '10 kg'], exclude: ['noodles', 'biscuit', 'cookies', 'bread', 'maggi', 'ladoo', 'rusk'] },
  rice: { category: 'grocery', aliases: ['rice', 'chawal'], dims: { type: dim([['basmati', ['basmati']], ['sona masoori', ['sona masoori', 'sona']], ['brown', ['brown']]]) }, sizes: ['1 kg', '5 kg'], exclude: ['noodles', 'cake', 'cracker', 'puffed', 'flour', 'bran', 'oil', 'vinegar', 'snack', 'chips', 'milk', 'poha'] },
  oil: { category: 'grocery', aliases: ['oil', 'tel'], dims: { type: dim([['sunflower', ['sunflower']], ['mustard', ['mustard', 'sarso']], ['groundnut', ['groundnut', 'peanut']], ['olive', ['olive']], ['coconut', ['coconut']]]) }, sizes: ['1 l', '5 l'], exclude: ['hair', 'body', 'massage', 'essential', 'face', 'baby', 'pickle', 'balm', 'serum'] },
  sugar: { category: 'grocery', aliases: ['sugar', 'cheeni'], sizes: ['1 kg', '5 kg'], exclude: ['free', 'cane juice', 'syrup', 'candy', 'sachet', 'cube', 'biscuit', 'cookies', 'chocolate'] },
  onion: { category: 'grocery', aliases: ['onion', 'onions', 'pyaz'], exclude: ['rings', 'chips', 'powder', 'paste', 'dip', 'seeds', 'spring', 'flakes'] },
  tomato: { category: 'grocery', aliases: ['tomato', 'tomatoes', 'tamatar'], exclude: ['ketchup', 'sauce', 'puree', 'chips', 'soup', 'paste', 'seeds', 'chutney', 'pickle', 'dried', 'cherry'] },
  potato: { category: 'grocery', aliases: ['potato', 'potatoes', 'aloo'], exclude: ['chips', 'fries', 'wedges', 'tikki', 'powder', 'patty', 'sweet', 'flakes', 'mash'] },
  banana: { category: 'grocery', aliases: ['banana', 'bananas', 'kela'], exclude: ['chips', 'shake', 'powder', 'bread', 'cake', 'wafer', 'flavour'] },

  momo: {
    category: 'food', aliases: ['momo', 'momos'], required: ['type'], question: 'Which momos?',
    dims: {
      type: dim([['veg', ['veg', 'vegetable'], ['chicken', 'non veg', 'mutton', 'paneer', 'cheese', 'egg']], ['chicken', ['chicken'], ['veg', 'paneer']], ['paneer', ['paneer'], ['chicken']], ['cheese', ['cheese', 'corn cheese'], ['chicken']]]),
      style: dim([['steamed', ['steamed', 'steam'], ['fried', 'kurkure', 'tandoori', 'afghani']], ['fried', ['fried'], ['steamed']], ['tandoori', ['tandoori'], ['steamed']]]),
    },
    options: [
      { label: 'Veg steamed', choices: { type: 'veg', style: 'steamed' } }, { label: 'Chicken steamed', choices: { type: 'chicken', style: 'steamed' } },
      { label: 'Veg fried', choices: { type: 'veg', style: 'fried' } }, { label: 'Chicken fried', choices: { type: 'chicken', style: 'fried' } },
      { label: 'Paneer steamed', choices: { type: 'paneer', style: 'steamed' } },
    ],
    exclude: ['sauce', 'chutney', 'mayo', 'mayonnaise', 'combo meal'],
  },
  pizza: { category: 'food', aliases: ['pizza', 'pizzas'], dims: { type: dim([['margherita', ['margherita', 'margarita']], ['farmhouse', ['farmhouse']], ['pepperoni', ['pepperoni']], ['paneer', ['paneer']], ['chicken', ['chicken']]]) }, exclude: ['base', 'sauce', 'dough', 'seasoning', 'puff', 'sandwich', 'burger', 'roll'] },
  burger: { category: 'food', aliases: ['burger', 'burgers'], dims: { type: dim([['veg', ['veg', 'aloo tikki', 'vegetable'], ['chicken', 'non veg']], ['chicken', ['chicken'], ['veg']], ['paneer', ['paneer']], ['cheese', ['cheese']]]) }, exclude: ['bun', 'patty', 'sauce', 'combo'] },
  biryani: { category: 'food', aliases: ['biryani', 'biriyani'], dims: { type: dim([['veg', ['veg', 'vegetable'], ['chicken', 'mutton', 'egg']], ['chicken', ['chicken'], ['veg', 'mutton']], ['mutton', ['mutton'], ['chicken', 'veg']], ['egg', ['egg']], ['paneer', ['paneer']]]) }, exclude: ['masala', 'spice', 'rice mix', 'seasoning'] },
  fries: { category: 'food', aliases: ['fries', 'french fries'], exclude: ['frozen', 'seasoning', 'masala packet'] },
  noodles: { category: 'food', aliases: ['noodles', 'chowmein', 'chow mein', 'hakka noodles'], exclude: ['instant', 'packet', 'maggi', 'masala', 'pack of'] },
  sandwich: { category: 'food', aliases: ['sandwich', 'sandwiches'], exclude: ['bread', 'spread', 'maker'] },
  dosa: { category: 'food', aliases: ['dosa', 'dosas'], exclude: ['batter', 'mix', 'tawa', 'ready to cook'] },
  shawarma: { category: 'food', aliases: ['shawarma'], exclude: ['sauce', 'mayo'] },
  thali: { category: 'food', aliases: ['thali'], exclude: [] },
};

/** Words that mean "this is a medicine" — those go to the Medicines tab (pharmacy apps), not a grocery or food app. */
export const MEDICINE_WORDS = ['medicine', 'medicines', 'tablet', 'tablets', 'capsule', 'capsules', 'syrup', 'ointment', 'paracetamol', 'crocin', 'dolo', 'ibuprofen', 'antacid', 'cetirizine', 'azithromycin', 'amoxicillin', 'insulin', 'vitamin d', 'pharmacy', 'prescription'];
