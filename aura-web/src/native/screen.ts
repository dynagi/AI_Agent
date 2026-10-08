import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/** What "find this" saw on the user's screen, with live prices (cheapest first). */
export interface VisualMatch {
  /** When it was found (ms). The app ignores a result it has already shown. */
  at: number;
  summary: string;
  query: string | null;
  products: { name: string; brand: string | null; category: string | null; query: string; confidence: number }[];
  results: { title: string; price: number | null; currency: string; source: string; link: string; thumbnail?: string | null }[];
  note?: string | null;
}

export interface LearnedSummary {
  since: number;
  apps: { pkg: string; label: string; opens: number; minutes: number; peakHour: number }[];
  actions: { pkg: string; label: string; verb: string; count: number }[];
  contacts: { name: string; opens: number; messages: number; calls: number; peakHour: number }[];
  interests: string[];
  /** A short sentence about habits with no names of people in it; this is what the assistant is told. */
  habits: string;
}

export interface AuraScreenPlugin {
  /** The AURA server address and the user's session token, so the phone can use the screen assistant. */
  configure(options: { apiBase: string; token: string }): Promise<void>;
  status(): Promise<{ accessibility: boolean; screenshot: boolean; learning: boolean; autoSkipAds: boolean; androidSdk: number }>;
  setAutoSkipAds(options: { enabled: boolean }): Promise<void>;
  setLearning(options: { enabled: boolean }): Promise<void>;
  learned(): Promise<LearnedSummary>;
  forgetLearned(): Promise<void>;
  /** The product matches from the latest "find this", once. */
  takeVisual(): Promise<{ visual?: VisualMatch }>;
  addListener(eventName: 'visualSearch', listenerFunc: (data: VisualMatch) => void): Promise<PluginListenerHandle>;
}

/** Native counterpart: android/app/src/main/java/com/aura/app/AuraScreenPlugin.java. Rejects on web. */
export const AuraScreen = registerPlugin<AuraScreenPlugin>('AuraScreen');
