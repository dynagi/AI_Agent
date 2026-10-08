import { Capacitor } from '@capacitor/core';
import type { AIAction, AIReply } from '../components/ai';
import { orderPrefsStore } from '../state/stores';
import { AuraMedicine } from '../native/medicine';
import { startQuickCart, type CartJob } from './extension';
import {
  DEFAULT_ORDER_PREFS, PLATFORMS_FOR, PLATFORM_NAMES, applyMemory, applyOption, defaultPlatform, labelFor, missingDims, optionsFor,
  parseOrderRequest, questionFor, rememberPick, toLine, type OrderPlatform, type OrderPrefs, type OrderRequest, type ParsedItem,
} from './orderIntent';

const cancel: AIAction = { label: 'Cancel', run: () => 'Okay — nothing was ordered.' };
const getPrefs = (): OrderPrefs => orderPrefsStore.get()[0] ?? DEFAULT_ORDER_PREFS;
const savePrefs = (p: OrderPrefs) => orderPrefsStore.set([{ ...p, id: 'prefs' }]);

/** Store names as the cart agent knows them. */
const STORE_NAME: Record<OrderPlatform, string> = { blinkit: 'Blinkit', zepto: 'Zepto', instamart: 'Swiggy Instamart', swiggy: 'Swiggy', zomato: 'Zomato' };
const ZOMATO = { pkg: 'com.application.zomato', url: 'https://www.zomato.com/' };

/** Where a request goes if the caller should leave the current screen (Chat/Voice). null = not an order, carry on as usual. */
export function orderDestination(text: string): '/shopping' | '/wellness?tab=Medicines' | null {
  const req = parseOrderRequest(text);
  if (!req) return null;
  return req.category === 'medicine' ? '/wellness?tab=Medicines' : '/shopping';
}

/**
 * Turns "order milk" into a cart fill: asks which milk only if it has to (and remembers the answer), picks the right kind of
 * store for the item (groceries → Blinkit/Zepto/Instamart, food → Swiggy/Zomato — never a general marketplace), then starts the fill.
 * Returns null when the text isn't an order, so callers can fall back to chat / price comparison.
 */
export function startOrder(text: string, goTo: (path: string) => void): AIReply | null {
  const req = parseOrderRequest(text);
  if (!req) return null;

  if (req.category === 'medicine') {
    return {
      text: 'Medicines are ordered through a pharmacy app (Tata 1mg, PharmEasy, Apollo, Netmeds). I can open your Medicines tab to order from there and keep track of your doses.',
      actions: [{ label: 'Open Medicines', variant: 'primary', run: () => { goTo('/wellness?tab=Medicines'); return 'Opened Medicines.'; } }, cancel],
    };
  }
  // Things the catalog doesn't know (earbuds, a specific brand of shampoo…) are the shopping agent's job, not ours.
  if (req.category === 'other') return null;
  const prefs = getPrefs();
  return step(req, req.items.map((i) => applyMemory(i, prefs)), req.platform, false);
}

function step(req: OrderRequest, items: ParsedItem[], platform: OrderPlatform | undefined, askedPlatform: boolean): AIReply {
  // 1. Anything vague? Ask once, with one-tap answers.
  const at = items.findIndex((i) => missingDims(i).length > 0);
  if (at >= 0) {
    const item = items[at];
    const options = optionsFor(item).slice(0, 6);
    if (options.length) {
      return {
        text: `${questionFor(item)} Pick one and I'll remember it for next time.`,
        actions: [
          ...options.map<AIAction>((o) => ({ label: o.label, variant: 'primary', run: () => step(req, items.map((x, i) => (i === at ? applyOption(x, o) : x)), platform, askedPlatform) })),
          cancel,
        ],
      };
    }
  }

  // 2. Which store? Remembered default, else ask.
  const category = req.category === 'food' ? 'food' : 'grocery';
  const chosen = platform ?? defaultPlatform(category, getPrefs());
  if (!chosen) {
    return {
      text: category === 'food' ? 'Which app should I order this from?' : 'Which app do you want to order from?',
      actions: [
        ...PLATFORMS_FOR[category].map<AIAction>((p) => ({ label: PLATFORM_NAMES[p], variant: 'primary', run: () => step(req, items, p, true) })),
        cancel,
      ],
    };
  }

  return execute(chosen, items, category, askedPlatform);
}

function execute(platform: OrderPlatform, items: ParsedItem[], category: 'grocery' | 'food', askedPlatform: boolean): AIReply {
  // Remember what the user chose so the next "order milk" needs no questions.
  let prefs = getPrefs();
  for (const it of items) if (Object.keys(it.choices).length) prefs = rememberPick(prefs, it);
  if (askedPlatform) prefs = { ...prefs, platform: { ...prefs.platform, [category]: platform } };
  savePrefs(prefs);

  const names = items.map((i) => `${labelFor(i)}${i.qty > 1 ? ` ×${i.qty}` : ''}`).join(', ');
  const tip = askedPlatform ? ` I'll use ${PLATFORM_NAMES[platform]} by default — say "from ${platform === 'zepto' ? 'Blinkit' : 'Zepto'}" any time to switch.` : '';

  if (platform === 'zomato') {
    const list = items.map(labelFor).join(', ');
    if (Capacitor.isNativePlatform()) void AuraMedicine.openApp({ pkg: ZOMATO.pkg, url: ZOMATO.url, copy: list }).catch(() => undefined);
    else { window.open(ZOMATO.url, '_blank', 'noopener'); void navigator.clipboard?.writeText(list).catch(() => undefined); }
    return { text: `Opened Zomato. Search for “${list}” there (it's copied) — Zomato can't be filled in automatically, so you choose the restaurant and pay in its app.${tip}` };
  }

  // Hand the clarified order to the cart agent (GitHub's AI agent: opens the store and fills the cart, stops before payment).
  const lines = items.map((i) => ({ name: toLine(i).name, qty: i.qty }));
  // Explicit variant/brand/size => add exactly that. Otherwise let the server pick the user's usual product.
  const explicit = items.every((i) => Object.keys(i.choices).length > 0 || !!i.brand);
  const job: CartJob = { store: STORE_NAME[platform], items: lines, resolved: explicit };
  if (platform === 'swiggy') {
    // Swiggy food: open the dish search on the website; the agent has to switch from Restaurants to Dishes there.
    job.startUrl = `https://www.swiggy.com/search?query=${encodeURIComponent(lines[0].name)}`;
    void startQuickCart(job, 'web');
  } else {
    void startQuickCart(job);
  }
  return {
    text: `Opening ${PLATFORM_NAMES[platform]} and adding ${names}. I stop at the cart — you review it and pay yourself.${tip}`,
  };
}
