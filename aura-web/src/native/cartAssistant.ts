import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/** `name` is the search text; the rest tell the on-page matcher which product to pick (see assets/aura-cart/match.js). */
export interface QuickCartNativeItem {
  name: string; qty: number;
  head?: string[]; must?: string[][]; avoid?: string[]; exclude?: string[]; size?: string; brand?: string;
  /** extra targeting from the user's history, e.g. "from restaurant Biryani Zest" */
  hint?: string;
}

export interface QuickCartProgressEvent { index: number; total: number; ok: boolean; note: string }
export interface QuickCartNeedUserEvent { message: string }
export interface QuickCartDoneEvent {
  added: number;
  total: number;
  message: string;
  items: (QuickCartNativeItem & { status: 'added' | 'failed' | 'pending'; note?: string })[];
}

export interface QuickCartStartResult {
  started: boolean;
  /** "app": driving the store's installed app; "web": its website in a WebView. */
  mode: 'app' | 'web';
  appInstalled: boolean;
  accessibilityEnabled: boolean;
  /** The store app is installed but AURA's accessibility access is off; nothing started. */
  needsAccessibility?: boolean;
}

export interface AuraCartAssistantPlugin {
  startQuickCart(options: {
    store: string;
    startUrl?: string;
    items: QuickCartNativeItem[];
    /** AURA backend base URL; the native agent posts screen snapshots to {apiBase}/shopping/agent/step */
    apiBase: string;
    token?: string;
    androidPackage?: string | null;
    appLabel?: string;
    /** auto (default): the store's app when installed (needs accessibility access), else its website */
    mode?: 'auto' | 'app' | 'web';
    /** First read the user's past orders in the store app (products, sizes, dates) into their history. */
    syncHistory?: boolean;
    /** false: match the items to the user's usual products (after reading history) before adding. */
    resolved?: boolean;
    /** How many past orders to read (default 8; a full sync reads up to 30, stopping at ones read before). */
    historyLimit?: number;
  }): Promise<QuickCartStartResult>;
  cartAgentStatus(options: { store: string; androidPackage?: string | null; appLabel?: string }): Promise<{
    appInstalled: boolean; appPackage: string | null; accessibilityEnabled: boolean;
  }>;
  openAccessibilitySettings(): Promise<void>;
  addListener(eventName: 'quickCartProgress', listenerFunc: (data: QuickCartProgressEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'quickCartNeedUser', listenerFunc: (data: QuickCartNeedUserEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'quickCartDone', listenerFunc: (data: QuickCartDoneEvent) => void): Promise<PluginListenerHandle>;
}

/**
 * Native (Android) cart agent — see android/app/src/main/java/com/aura/app/. It drives the store's real app
 * (AuraAccessibilityService, after the user turns on AURA under Settings > Accessibility once) or, when the
 * app isn't installed, the store's website (CartAssistantActivity). An AI reads each screen to search, pick
 * and add the items, on any store, and stops at the cart. On web this resolves to Capacitor's web stub,
 * which rejects every call; callers check Capacitor.isNativePlatform() first.
 */
export const AuraCartAssistant = registerPlugin<AuraCartAssistantPlugin>('AuraCartAssistant');
