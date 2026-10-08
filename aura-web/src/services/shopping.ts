import { apiGet, apiSend } from './api';
import type { Product } from '../data/products';

interface ApiProduct { title: string; price: number | null; currency: string; source: string; link: string; thumbnail?: string | null; rating?: number | null; reviews?: number | null }

const productId = (p: ApiProduct) => `${p.source}|${p.title}`.slice(0, 120);
const toProduct = (p: ApiProduct): Product => ({
  id: productId(p), name: p.title, image: p.thumbnail ?? '', rating: p.rating ?? undefined, reviews: p.reviews ?? undefined,
  price: p.price ?? 0, currency: p.currency, provider: p.source, link: p.link,
});

/** Live price comparison. The backend returns listings from many retailers already sorted lowest price first. */
export async function searchProducts(q: string): Promise<Product[]> {
  const res = await apiGet<{ data: ApiProduct[] }>('/shopping/search', { q });
  return res.data.filter((p) => p.price !== null && p.price > 0).map(toProduct);
}

/**
 * Re-orders results by predicted interest, using the model AURA retrains
 * daily from the user's like/not-interested feedback. Ranking is a
 * nice-to-have on top of live price search, so any failure (AI service
 * down, no model trained yet) just keeps the original price-sorted order.
 */
export async function rankSuggestions(products: Product[], category?: string): Promise<Product[]> {
  if (!products.length) return products;
  try {
    const res = await apiSend<{ data: (Product & { interestScore: number })[] }>('POST', '/shopping/suggestions', {
      products: products.map((p) => ({ ...p, category })),
    });
    return res.data;
  } catch {
    return products;
  }
}

export interface ShoppingEvent {
  action: 'search' | 'view' | 'wishlist' | 'add_to_cart' | 'order' | 'cancel' | 'not_interested';
  name: string;
  app?: string;
  qty?: number;
  price?: number;
  category?: string;
  source?: 'app' | 'agent_command' | 'cart_agent';
}

/**
 * Records what the user does (searches, cart adds, wishlists, dismissals, orders) so their next-purchase
 * predictions update immediately and the shopping model retrains on it. Fire-and-forget: failures
 * never get in the way of shopping.
 */
export function logShoppingEvents(events: ShoppingEvent[]): void {
  const clean = events
    .filter((e) => e.name.trim())
    .map((e) => ({ ...e, name: e.name.trim().slice(0, 120), price: e.price && e.price > 0 ? e.price : undefined }));
  if (clean.length) void apiSend('POST', '/shopping/events', { events: clean }).catch(() => undefined);
}

export interface PredictedItem {
  item: string;
  name: string;
  category: string;
  probability: number;
  dueInDays: number | null;
  lastOrderedDaysAgo: number | null;
  usualGapDays: number | null;
  usualQty: number;
  store: string | null;
  estimatedPriceInr: number | null;
  why: string;
}
export interface ShoppingForecast {
  status: 'ok' | 'cold_start';
  nextPurchases: PredictedItem[];
  suggestedBaskets?: { store: string | null; items: { name: string; qty: number }[]; estimatedAmountInr: number }[];
  nextOrderInDays?: number | null;
  model: { model: string; status: string; trainedAt?: string };
}

/** What the user will likely need in the next 7 days, from the shopping model. */
export async function getShoppingForecast(demoUser?: string): Promise<ShoppingForecast> {
  const res = await apiGet<{ data: ShoppingForecast }>('/shopping/predictions', { demoUser });
  return res.data;
}

/* ---------- Shopping assistant (server decision engine) ---------- */

export interface AssistOption {
  provider: string; label: string; final_cost: number | null; eta_minutes: number | null;
  /** Where the numbers came from: live_app | your_last_order | not_checked */
  source: string; observed: string | null; kind: string;
}
export interface AssistReply {
  /** false: not an order or an answer to a shopping question; use normal chat */
  handled: boolean;
  say?: string;
  pending?: boolean;
  question?: 'choose_provider' | 'confirm' | null;
  options?: AssistOption[];
  quickReplies?: string[];
  level?: number;
  reasons?: string[];
  cartOrder?: { store: string; startUrl?: string; androidPackage?: string | null; appLabel?: string;
    items: { name: string; qty: number; hint?: string }[]; syncHistory?: boolean; resolved?: boolean } | null;
}

/** One turn with the shopping assistant. It asks before a new purchase and only returns a cart job once decided. */
export const shopAssist = (message: string) => apiSend<AssistReply>('POST', '/shopping/assist', { message });

export interface AutoOrderRule { item: string; provider?: string | null; max_price?: number | null; max_qty: number }
export interface ShoppingPolicy {
  require_confirmation_for_new_product: boolean;
  require_confirmation_above: number;
  max_price_deviation_percent: number;
  allow_auto_repeat_orders: boolean;
  auto_order_rules: AutoOrderRule[];
  min_provider_confidence: number;
}
export const getShoppingPolicy = async () => (await apiGet<{ data: ShoppingPolicy }>('/shopping/policy')).data;
export const saveShoppingPolicy = async (p: ShoppingPolicy) => (await apiSend<{ data: ShoppingPolicy }>('PUT', '/shopping/policy', p)).data;

export interface ItemPreference {
  item: string; product: string; usual_qty: number; provider: string | null; provider_confidence: number;
  times_ordered: number; typical_gap_days: number | null; typical_price: number | null; known: boolean;
}
export interface ShoppingMemory {
  items: ItemPreference[]; price_weight: number; speed_weight: number; weights_confidence: number; decisions: number;
}
export const getShoppingMemory = async () => (await apiGet<{ data: ShoppingMemory }>('/shopping/preferences')).data;
