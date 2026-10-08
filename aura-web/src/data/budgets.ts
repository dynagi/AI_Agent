import { Utensils, ShoppingBag, Plane, Zap, Repeat, Target, type LucideIcon } from 'lucide-react';
import type { Tone } from '../components/ui';
import type { TxCategory } from './transactions';

/** A monthly spending limit. `spent` is derived from transactions, never stored. */
export interface Budget { id: string; category: TxCategory; limit: number }

export const budgetMeta: Record<TxCategory, { icon: LucideIcon; tone: Tone }> = {
  'Food & Dining': { icon: Utensils, tone: 'pink' },
  Shopping: { icon: ShoppingBag, tone: 'blue' },
  Travel: { icon: Plane, tone: 'teal' },
  'Bills & Utilities': { icon: Zap, tone: 'amber' },
  Subscriptions: { icon: Repeat, tone: 'magenta' },
  Others: { icon: Target, tone: 'violet' },
  Income: { icon: Target, tone: 'green' },
};
