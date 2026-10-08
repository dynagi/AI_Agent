import { CATALOG, MEDICINE_WORDS, type Choice, type Option, type OrderCategory, type Spec } from '../data/orderCatalog';

export type OrderPlatform = 'blinkit' | 'zepto' | 'instamart' | 'swiggy' | 'zomato';
export type ItemCategory = OrderCategory | 'medicine' | 'other';

export const PLATFORM_NAMES: Record<OrderPlatform, string> = { blinkit: 'Blinkit', zepto: 'Zepto', instamart: 'Swiggy Instamart', swiggy: 'Swiggy', zomato: 'Zomato' };
export const PLATFORMS_FOR: Record<OrderCategory, OrderPlatform[]> = { grocery: ['blinkit', 'zepto', 'instamart'], food: ['swiggy', 'zomato'] };

/** What the user wants, after parsing. `choices` are the decisions made so far (dimension → choice key). */
export interface ParsedItem {
  raw: string;
  qty: number;
  category: ItemCategory;
  headKey?: string;
  choices: Record<string, string>;
  size?: string;
  brand?: string;
  /** Words the user typed that the catalog didn't recognise ("chocolate", "powder", "organic") — they narrow the search. */
  extra: string[];
}
export interface OrderRequest { items: ParsedItem[]; platform?: OrderPlatform; category: ItemCategory }

/** What goes to the store page: a search text plus the rules for picking the right product from the results. */
export interface OrderLine {
  name: string;
  qty: number;
  /** Any of these words must appear in the product name. */
  head?: string[];
  /** Each group (any word in it) must appear — e.g. [["toned","taaza"]]. */
  must?: string[][];
  /** Words that mean a different variant. */
  avoid?: string[];
  /** Words that mean it is not this item at all. */
  exclude?: string[];
  size?: string;
  brand?: string;
}

/** Remembered answers, so asking twice isn't needed. */
export interface OrderPrefs {
  id: string;
  platform?: Partial<Record<OrderCategory, OrderPlatform>>;
  picks?: Record<string, { choices: Record<string, string>; size?: string }>;
}
export const DEFAULT_ORDER_PREFS: OrderPrefs = { id: 'prefs' };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const has = (text: string, term: string) => new RegExp(`(?<![a-z0-9])${esc(term)}(?![a-z0-9])`, 'i').test(text);
const SIZE_RE = /(\d+(?:\.\d+)?)\s*(ml|ltrs?|litres?|liters?|l|kgs?|kg|gms?|grams?|g|pcs?|pieces?|dozen)\b/i;
const STOP = new Set(['the', 'some', 'for', 'and', 'with', 'fresh', 'good', 'best', 'any', 'one', 'pack', 'packet', 'packets', 'bottle', 'litre', 'liter']);
const NUM_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, half: 0.5 };

const PLATFORM_RE = /\b(?:(?:from|on|via|using|in|at|through|with)\s+)?(blinkit|blink\s?it|zepto|swiggy\s+instamart|instamart|swiggy|zomato)\b/i;
const VERB_RE = /^(?:(?:hey\s+)?aura[,\s]+|please\s+|pls\s+)*(?:(?:can|could|will|would)\s+you\s+)?(?:please\s+)?(order|auto[- ]?order|get me|get|buy|add|bring me|send me|i want|i need|i'd like|i would like|want|need)\s+(?:some\s+)?(.+)$/i;

function normalizeSize(n: string, unit: string): string {
  const u = unit.toLowerCase();
  if (/^(l|ltrs?|litres?|liters?)$/.test(u)) return `${Number(n)} l`;
  if (/^(kg|kgs)$/.test(u)) return `${Number(n)} kg`;
  if (/^(g|gm|gms|gram|grams)$/.test(u)) return `${Number(n)} g`;
  if (/^(pc|pcs|piece|pieces)$/.test(u)) return `${Number(n)}`;
  if (u === 'dozen') return `${Number(n) * 12}`;
  return `${Number(n)} ${u}`;
}

function parseItem(rawIn: string): ParsedItem {
  let text = rawIn.toLowerCase().replace(/[^a-z0-9.\s×]/g, ' ').replace(/\s+/g, ' ').trim();
  let qty = 1;
  let size: string | undefined;

  const sz = text.match(SIZE_RE);
  if (sz) {
    size = normalizeSize(sz[1], sz[2]);
    text = text.replace(sz[0], ' ');
    const times = text.match(/(\d+)\s*[x×]\s*$|^\s*(\d+)\s*[x×]/);
    if (times) { qty = Number(times[1] ?? times[2]); text = text.replace(times[0], ' '); }
  }
  const lead = text.match(/^(\d+)\s*[x×]?\s+(?:packets?|packs?|pkts?|bottles?|cartons?|boxes|plates?|portions?|pieces?)?\s*(?:of\s+)?/);
  if (lead && lead[1]) { qty = Math.max(1, Number(lead[1])); text = text.slice(lead[0].length); }
  const trail = text.match(/\s[x×]\s*(\d+)$/);
  if (trail) { qty = Math.max(1, Number(trail[1])); text = text.replace(trail[0], ''); }
  const word = text.match(/^(a|an|one|two|three|four|five|six)\s+(?:packets?|packs?|bottles?|cartons?|plates?|portions?)?\s*(?:of\s+)?/);
  if (word && NUM_WORDS[word[1]] >= 1 && word[0].trim().length) {
    // "a milk" is just "milk"; only treat counting words as quantity when a unit word followed or it is two+.
    if (NUM_WORDS[word[1]] > 1 || /packet|pack|bottle|carton|plate|portion/.test(word[0])) qty = NUM_WORDS[word[1]];
    text = text.slice(word[0].length);
  }
  text = text.replace(/\s+/g, ' ').trim();

  // Head: the item is the *last* catalog word ("paneer momos" is momos, "toned milk" is milk).
  let headKey: string | undefined;
  let headAlias = '';
  let headAt = -1;
  for (const [key, spec] of Object.entries(CATALOG)) {
    for (const a of spec.aliases) {
      const at = text.search(new RegExp(`(?<![a-z0-9])${esc(a)}(?![a-z0-9])`, 'i'));
      if (at >= 0 && (at > headAt || (at === headAt && a.length > headAlias.length))) { headKey = key; headAlias = a; headAt = at; }
    }
  }
  const spec = headKey ? CATALOG[headKey] : undefined;

  const choices: Record<string, string> = {};
  let rest = headAlias ? text.replace(new RegExp(`(?<![a-z0-9])${esc(headAlias)}(?![a-z0-9])`, 'i'), ' ') : text;
  if (spec?.dims) {
    for (const [d, list] of Object.entries(spec.dims)) {
      const terms = list.flatMap((c) => c.terms.map((t) => ({ t, key: c.key }))).sort((a, b) => b.t.length - a.t.length);
      for (const { t, key } of terms) if (has(rest, t)) { choices[d] = key; rest = rest.replace(new RegExp(`(?<![a-z0-9])${esc(t)}(?![a-z0-9])`, 'i'), ' '); break; }
    }
  }
  const brand = spec?.brands?.slice().sort((a, b) => b.length - a.length).find((b) => has(text, b));
  if (brand) rest = rest.replace(new RegExp(`(?<![a-z0-9])${esc(brand)}(?![a-z0-9])`, 'i'), ' ');
  // Egg packs come in 6 / 12 / 30: "12 eggs" means the pack of 12, not twelve packs.
  if (spec?.packCount && !size && spec.sizes?.includes(String(qty))) { size = String(qty); qty = 1; }
  const extra = spec ? rest.split(' ').filter((w) => w.length > 2 && !STOP.has(w) && !/^\d/.test(w)) : [];

  const category: ItemCategory = spec ? spec.category : MEDICINE_WORDS.some((w) => has(text, w)) ? 'medicine' : 'other';
  return { raw: text, qty, category, headKey, choices, size, brand, extra };
}

/** Parses "order 2 toned milk and eggs from zepto". Returns null when it isn't an order we can act on (the caller then falls back to chat/price comparison). */
export function parseOrderRequest(input: string): OrderRequest | null {
  const verb = input.trim().match(VERB_RE);
  if (!verb) return null;
  let body = verb[2].replace(/\b(?:for me|please|pls|right now|now|to my cart|in my cart|into my cart)\b/gi, ' ');

  let platform: OrderPlatform | undefined;
  const pm = body.match(PLATFORM_RE);
  if (pm) {
    const p = pm[1].toLowerCase().replace(/\s+/g, ' ');
    platform = p.includes('instamart') ? 'instamart' : (p.replace(' ', '') as OrderPlatform);
    body = body.replace(pm[0], ' ');
  }
  const items = body.split(/,|\band\b|&|\+|\n/i).map((s) => s.trim()).filter(Boolean).map(parseItem).filter((i) => i.raw.length > 0);
  if (!items.length) return null;

  const known = items.find((i) => i.category !== 'other');
  // "buy a laptop" etc. is a price-comparison question, not a cart-fill — unless the user named a store.
  if (!known && !platform) return null;
  const category = known?.category ?? 'other';
  return { items, platform, category };
}

/** Dimensions the user still has to decide for this item. */
export function missingDims(item: ParsedItem): string[] {
  const spec = item.headKey ? CATALOG[item.headKey] : undefined;
  // The user named something the catalog normally excludes ("chocolate milk"): it is a different product, so don't ask which plain milk.
  if (spec?.exclude?.some((e) => e.split(' ').every((w) => has(item.raw, w)))) return [];
  return (spec?.required ?? []).filter((d) => !item.choices[d]);
}

export const optionsFor = (item: ParsedItem): Option[] => (item.headKey ? CATALOG[item.headKey].options ?? [] : []);
export const questionFor = (item: ParsedItem): string => (item.headKey ? CATALOG[item.headKey].question : undefined) ?? 'Which one?';

export function applyOption(item: ParsedItem, opt: Option): ParsedItem {
  return { ...item, choices: { ...item.choices, ...opt.choices }, size: item.size ?? opt.size };
}

/** Fills in what the user picked last time for this kind of item. */
export function applyMemory(item: ParsedItem, prefs: OrderPrefs): ParsedItem {
  const pick = item.headKey ? prefs.picks?.[item.headKey] : undefined;
  if (!pick || missingDims(item).length === 0) return item;
  return { ...item, choices: { ...pick.choices, ...item.choices }, size: item.size ?? pick.size };
}

export const rememberPick = (prefs: OrderPrefs, item: ParsedItem): OrderPrefs =>
  item.headKey ? { ...prefs, picks: { ...prefs.picks, [item.headKey]: { choices: item.choices, size: item.size } } } : prefs;

const choiceOf = (spec: Spec, d: string, key: string): Choice | undefined => spec.dims?.[d]?.find((c) => c.key === key);

/** Human-readable, e.g. "Amul toned milk 500 ml". */
export function labelFor(item: ParsedItem): string {
  const spec = item.headKey ? CATALOG[item.headKey] : undefined;
  const dimsText = [...Object.values(item.choices), ...item.extra];
  const head = spec ? spec.aliases[0] : item.raw;
  const parts = [item.brand ? item.brand[0].toUpperCase() + item.brand.slice(1) : '', ...dimsText, head, item.size ?? ''].filter(Boolean);
  const label = parts.join(' ');
  return item.brand ? label : label.charAt(0).toUpperCase() + label.slice(1);
}

export function toLine(item: ParsedItem): OrderLine {
  const spec = item.headKey ? CATALOG[item.headKey] : undefined;
  if (!spec) return { name: item.raw, qty: item.qty };
  const typed = new Set(item.raw.split(' '));
  const must: string[][] = [];
  const avoid = new Set<string>();
  for (const [d, key] of Object.entries(item.choices)) {
    const c = choiceOf(spec, d, key);
    if (!c) continue;
    must.push(c.terms);
    c.avoid?.forEach((a) => avoid.add(a));
  }
  // A word the user typed is never an exclusion ("chocolate milk", "milk powder").
  const exclude = (spec.exclude ?? []).filter((e) => !e.split(' ').some((w) => typed.has(w)));
  // A typed word the catalog treats as "a different product" (chocolate, powder) must appear in the product name.
  const excludeWords = new Set((spec.exclude ?? []).flatMap((e) => e.split(' ')));
  for (const w of item.extra) if (excludeWords.has(w)) must.push([w]);
  const name = [item.brand ?? '', ...Object.values(item.choices), ...item.extra, spec.aliases[0], item.size ?? ''].filter(Boolean).join(' ');
  return { name, qty: item.qty, head: spec.aliases, must, avoid: [...avoid], exclude, size: item.size, brand: item.brand };
}

export const defaultPlatform = (category: OrderCategory, prefs: OrderPrefs): OrderPlatform | undefined => prefs.platform?.[category];
