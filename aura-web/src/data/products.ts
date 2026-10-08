import { ShoppingBag, ShoppingCart, Laptop, Shirt, Sparkle, HeartPulse, Home, BookOpen, Gift, Dumbbell, type LucideIcon } from 'lucide-react';
import type { Tone } from '../components/ui';

export type ProductCategory = 'Groceries' | 'Electronics' | 'Fashion' | 'Beauty' | 'Health' | 'Home & Living' | 'Books' | 'Gifts' | 'Sports';

export interface Product {
  id: string;
  name: string;
  image: string;
  rating?: number;
  reviews?: number;
  price: number;
  currency: string;
  provider: string;
  link: string;
}

/** A product placed in the smart cart (snapshot of the live listing + quantity). */
export interface CartLine extends Product { qty: number }

/**
 * One interested/not-interested signal on a product, snapshotted at the
 * time the user reacted. AURA's ai-service retrains a daily interest model
 * from these to rank future suggestions.
 */
export interface ProductFeedback {
  id: string;
  productId: string;
  interested: boolean;
  name: string;
  price: number;
  currency: string;
  provider: string;
  rating?: number;
  reviews?: number;
  category?: string;
  createdAt: string;
}

export const categories: { label: 'All' | ProductCategory; icon: LucideIcon; tone: Tone }[] = [
  { label: 'All', icon: ShoppingBag, tone: 'blue' },
  { label: 'Groceries', icon: ShoppingCart, tone: 'green' },
  { label: 'Electronics', icon: Laptop, tone: 'blue' },
  { label: 'Fashion', icon: Shirt, tone: 'pink' },
  { label: 'Beauty', icon: Sparkle, tone: 'magenta' },
  { label: 'Health', icon: HeartPulse, tone: 'green' },
  { label: 'Home & Living', icon: Home, tone: 'violet' },
  { label: 'Books', icon: BookOpen, tone: 'violet' },
  { label: 'Gifts', icon: Gift, tone: 'magenta' },
  { label: 'Sports', icon: Dumbbell, tone: 'violet' },
];

/** Search terms per category chip — results always come from the live shopping API. */
export const categoryQuery: Record<Exclude<ProductCategory, never>, string> = {
  Groceries: 'groceries', Electronics: 'electronics', Fashion: 'fashion', Beauty: 'beauty products', Health: 'health supplements',
  'Home & Living': 'home decor', Books: 'books', Gifts: 'gift ideas', Sports: 'sports equipment',
};

/** A recurring reorder the user set up for a product they saved. */
export interface Subscription { id: string; name: string; image: string; every: string; next: string; active: boolean; link?: string }
