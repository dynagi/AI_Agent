import { searchProducts } from '../services/shopping';
import type { Product } from '../data/products';
import type { PeriodPrefs } from '../data/wellness';

export interface SupplyItem { key: string; label: string; kind: 'essential' | 'craving'; qty: number; product?: Product; checked: boolean }

/** Finds the cheapest live offer for the user's usual supplies and each craving. Never places an order. */
export async function buildProposal(prefs: PeriodPrefs): Promise<SupplyItem[]> {
  const wanted = [
    { key: 'pads', label: prefs.padQuery.trim() || 'sanitary pads', kind: 'essential' as const, qty: Math.max(1, prefs.padQty) },
    ...prefs.cravings.map((c, i) => ({ key: `craving-${i}`, label: c, kind: 'craving' as const, qty: 1 })),
  ];
  const results = await Promise.allSettled(wanted.map((w) => searchProducts(w.label)));
  return wanted.map((w, i) => {
    const r = results[i];
    const product = r.status === 'fulfilled' ? r.value[0] : undefined;
    return { ...w, product, checked: !!product };
  });
}
