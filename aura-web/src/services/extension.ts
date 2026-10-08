import { Capacitor } from '@capacitor/core';
import { createStore, uid } from '../state/store';
import { AuraCartAssistant } from '../native/cartAssistant';
import { API_URL, accessToken, apiGet } from './api';
import { logShoppingEvents } from './shopping';
import { toast } from '../components/ui/primitives';

/** The three stores the browser extension has scripts for (web only; the phone app works on any store). */
export type QuickCartPlatform = 'blinkit' | 'zepto' | 'instamart';
export interface QuickCartItem { name: string; qty: number; /** e.g. "from restaurant Biryani Zest" */ hint?: string }

/** Stores AURA knows a direct search URL for. Any other store name works on the phone too. */
export const KNOWN_STORES = ['Blinkit', 'Zepto', 'Swiggy Instamart', 'BigBasket', 'JioMart', 'Amazon', 'Flipkart', 'Myntra',
  'AJIO', 'Nykaa', 'Meesho', 'Tata 1mg', 'PharmEasy', 'Croma', 'DMart Ready'];

export const PLATFORM_LABEL: Record<QuickCartPlatform, string> = {
  blinkit: 'Blinkit',
  zepto: 'Zepto',
  instamart: 'Swiggy Instamart',
};

export interface CartJob {
  store: string;
  items: QuickCartItem[];
  /** Where the agent starts; looked up from the backend when missing. */
  startUrl?: string;
  /** The store's Android app, when known (the phone also finds installed apps by name). */
  androidPackage?: string | null;
  appLabel?: string;
  /** Read the user's past orders in the store app first (first order there, then weekly). */
  syncHistory?: boolean;
  /** false: the server matches the items to the user's usual products before adding them. */
  resolved?: boolean;
  historyLimit?: number;
  /** The shopping agent already recorded this order server-side (don't log it twice). */
  logged?: boolean;
}

const isNative = Capacitor.isNativePlatform();

/**
 * Whether hands-free cart filling is available. On native (Android) it always is — the AI cart agent
 * is compiled into the app and works on any store. On web it depends on the AURA Cart Assistant browser
 * extension (Blinkit/Zepto/Instamart only) having announced itself (see browser-extension/).
 */
export const extensionStore = createStore<{ installed: boolean }>({ installed: isNative });
export const cartAgentAnyStore = isNative;

export interface QuickCartState {
  /** needs_setup: the store's app is installed but AURA's accessibility access is off (one-time step). */
  status: 'idle' | 'running' | 'needs_you' | 'needs_setup' | 'done' | 'error';
  store?: string;
  /** Where the agent is working: the store's app or its website. */
  mode?: 'app' | 'web';
  index: number;
  total: number;
  message: string;
}
export const quickCartStore = createStore<QuickCartState>({ status: 'idle', index: 0, total: 0, message: '' });

let activeRequestId: string | null = null;
let jobFinished: (() => void) | null = null;

/** Shopping apps on this phone that AURA knows (store name), checked one by one. */
async function installedStores(): Promise<string[]> {
  const found: string[] = [];
  for (const store of KNOWN_STORES) {
    try {
      const info = (await apiGet<{ data: { androidPackage: string | null; appLabel: string } }>('/shopping/agent/store', { name: store })).data;
      const s = await AuraCartAssistant.cartAgentStatus({ store, androidPackage: info.androidPackage, appLabel: info.appLabel });
      if (s.appInstalled && !found.includes(s.appPackage ?? store)) found.push(store);
    } catch { /* skip stores we can't check */ }
  }
  return found;
}

/**
 * "Learn from all my stores": reads the order history in every installed shopping app (Zepto, Blinkit, Swiggy,
 * Amazon, Flipkart...), one after another, up to 30 orders each, stopping early at orders read before. This gives
 * the next-purchase model real data and AURA the user's usual products.
 */
export async function syncAllStoreHistories(): Promise<void> {
  if (!isNative) return;
  quickCartStore.set({ status: 'running', index: 0, total: 0, message: 'Checking which shopping apps you have…' });
  const stores = await installedStores();
  if (!stores.length) {
    quickCartStore.set((s) => ({ ...s, status: 'error', message: 'No supported shopping apps found on this phone.' }));
    return;
  }
  for (const [i, store] of stores.entries()) {
    const done = new Promise<void>((resolve) => { jobFinished = resolve; });
    await startQuickCart({ store, items: [], syncHistory: true, historyLimit: 30 });
    const state = quickCartStore.get();
    if (state.status === 'needs_setup' || state.status === 'error') return; // accessibility off, or failed to start
    quickCartStore.set((s) => ({ ...s, message: `Reading your ${store} orders (${i + 1}/${stores.length})…` }));
    await done;
  }
  jobFinished = null;
  quickCartStore.set((s) => ({ ...s, status: 'done', message: `Learnt from your orders in ${stores.join(', ')}.` }));
  toast(`AURA learnt from your past orders in ${stores.join(', ')}.`);
}
/** A job waiting for the one-time accessibility setup (re-run with retryPendingCart). */
let pendingJob: CartJob | null = null;

/** Opens Android's Accessibility settings, where the user turns on "AURA shopping agent" once. */
export function openAccessibilitySettings(): void {
  if (isNative) void AuraCartAssistant.openAccessibilitySettings();
}

/** Re-runs the job that was waiting for setup: in the app (default) or on the store's website. */
export function retryPendingCart(mode: 'auto' | 'web' = 'auto'): void {
  const job = pendingJob;
  pendingJob = null;
  if (job) void startQuickCart(job, mode);
}

// Back from Accessibility settings: if access is now on, run the waiting order without being asked again.
if (isNative && typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    const job = pendingJob;
    if (document.visibilityState !== 'visible' || !job) return;
    void AuraCartAssistant.cartAgentStatus({ store: job.store, androidPackage: job.androidPackage, appLabel: job.appLabel })
      .then((s) => { if (s.accessibilityEnabled && pendingJob === job) retryPendingCart('auto'); })
      .catch(() => undefined);
  });
}
let activeJob: CartJob | null = null;

function extensionPlatform(store: string): QuickCartPlatform | null {
  const s = store.toLowerCase();
  if (s.includes('instamart') || s === 'swiggy') return 'instamart';
  if (s.includes('zepto')) return 'zepto';
  if (s.includes('blinkit')) return 'blinkit';
  return null;
}

/** A cart the user commanded counts as an order for the next-purchase model (unless the agent logged it). */
function logFilledCart(items: QuickCartItem[]) {
  const job = activeJob;
  activeJob = null;
  if (!job || job.logged || !items.length) return;
  logShoppingEvents(items.map((i) => ({ action: 'order', name: i.name, qty: i.qty, app: job.store, source: 'cart_agent' })));
}

if (isNative) {
  void AuraCartAssistant.addListener('quickCartProgress', ({ index, total, ok, note }) => {
    quickCartStore.set((s) => ({ ...s, status: 'running', index, total, message: ok ? `Added ${note}` : `Couldn't add ${note}` }));
  });
  void AuraCartAssistant.addListener('quickCartNeedUser', ({ message }) => {
    quickCartStore.set((s) => ({ ...s, status: 'needs_you', message }));
  });
  void AuraCartAssistant.addListener('quickCartDone', ({ added, total, message, items }) => {
    jobFinished?.();
    quickCartStore.set((s) => ({ ...s, status: 'done', index: added, total, message: `Cart ready on ${s.store}: ${added}/${total} items added. ${message} Payment is up to you.` }));
    toast(`Cart ready: ${added}/${total} items added. Payment is up to you.`);
    logFilledCart(items.filter((i) => i.status === 'added'));
  });
} else if (typeof window !== 'undefined') {
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data as { source?: string; type?: string; requestId?: string; ok?: boolean; error?: string; index?: number; total?: number; note?: string };
    if (!msg || msg.source !== 'aura-extension') return;

    if (msg.type === 'AURA_EXTENSION_READY') {
      extensionStore.set({ installed: true });
      return;
    }
    if (!msg.requestId || msg.requestId !== activeRequestId) return;

    if (msg.type === 'AURA_QUICK_CART_ACK' && !msg.ok) {
      quickCartStore.set((s) => ({ ...s, status: 'error', message: msg.error ?? 'Could not start the cart assistant.' }));
      activeRequestId = null;
    } else if (msg.type === 'QUICK_CART_PROGRESS') {
      const index = msg.index ?? 0;
      const total = msg.total ?? 0;
      quickCartStore.set((s) => ({
        ...s,
        status: 'running',
        index,
        total,
        message: msg.ok ? `Added ${index + 1}/${total} items…` : `Item ${index + 1}/${total} needs a manual add: ${msg.note ?? 'not found'}`,
      }));
    } else if (msg.type === 'QUICK_CART_DONE') {
      quickCartStore.set((s) => ({ ...s, status: 'done', message: 'Done — open your cart to review and pay. AURA never pays for you.' }));
      logFilledCart(activeJob?.items ?? []);
      activeRequestId = null;
    }
  });
}

export function isExtensionInstalled(): boolean {
  return extensionStore.get().installed;
}

/**
 * Fills the cart on the given store, hands-free. On the phone, the AI cart agent opens the store's real
 * website and works through the items on any store; on web, the browser extension does it for
 * Blinkit/Zepto/Instamart. Either way it stops at the cart — payment is not automated.
 */
export async function startQuickCart(job: CartJob, mode: 'auto' | 'app' | 'web' = 'auto'): Promise<void> {
  const items = job.items.filter((i) => i.name.trim());
  if (!items.length && !job.syncHistory) return;
  activeJob = { ...job, items };
  quickCartStore.set({ status: 'running', store: job.store, index: 0, total: items.length, message: `Opening ${job.store}…` });

  if (isNative) {
    try {
      let { startUrl, androidPackage, appLabel } = job;
      if (!startUrl) {
        const store = (await apiGet<{ data: { startUrl: string; androidPackage: string | null; appLabel: string } }>(
          '/shopping/agent/store', { name: job.store })).data;
        ({ startUrl } = store);
        androidPackage ??= store.androidPackage;
        appLabel ??= store.appLabel;
      }
      const res = await AuraCartAssistant.startQuickCart({
        store: job.store, startUrl, items, apiBase: API_URL, token: await accessToken(), androidPackage, appLabel, mode,
        syncHistory: job.syncHistory, resolved: job.resolved, historyLimit: job.historyLimit,
      });
      if (res.needsAccessibility) {
        // One-time setup, from wherever the command was given (chat, voice, Shopping): take the user straight
        // to the switch, and continue this same order by itself once they come back with it turned on.
        pendingJob = { ...job, items, startUrl, androidPackage, appLabel };
        const message = `Turn on "AURA shopping agent" (one time) so AURA can use the ${job.store} app. Come back and it continues by itself.`;
        quickCartStore.set((s) => ({ ...s, status: 'needs_setup', mode: 'app', message }));
        toast(message);
        void AuraCartAssistant.openAccessibilitySettings();
      } else {
        const what = job.syncHistory && res.mode === 'app' ? `Reading your past ${job.store} orders first…` : res.mode === 'app' ? `Working in the ${job.store} app…` : `Working on the ${job.store} website…`;
        quickCartStore.set((s) => ({ ...s, mode: res.mode, message: what }));
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Could not start the cart agent.';
      quickCartStore.set((s) => ({ ...s, status: 'error', message }));
      toast(message);
    }
    return;
  }

  const platform = extensionPlatform(job.store);
  if (!platform) {
    quickCartStore.set((s) => ({ ...s, status: 'error', message: `Hands-free cart filling on ${job.store} runs in the AURA phone app. On the web it works on Blinkit, Zepto and Instamart with the browser extension.` }));
    return;
  }
  if (!extensionStore.get().installed) {
    quickCartStore.set((s) => ({ ...s, status: 'error', message: 'Install the AURA Cart Assistant browser extension first (see browser-extension/README.md), or use the AURA phone app.' }));
    return;
  }
  const requestId = uid('qc');
  activeRequestId = requestId;
  window.postMessage({ source: 'aura-web', type: 'AURA_QUICK_CART_START', requestId, platform, items }, '*');
}

/**
 * Parses a free-text shopping list into items, e.g. "milk x2, eggs, 3x bread"
 * -> [{name:'milk',qty:2},{name:'eggs',qty:1},{name:'bread',qty:3}].
 */
export function parseShoppingList(text: string): QuickCartItem[] {
  return text
    .split(/,|\band\b|\n/i)
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const trailing = raw.match(/^(.*?)\s*[x×]\s*(\d+)$/i);
      const leading = raw.match(/^(\d+)\s*[x×]\s*(.*)$/i);
      if (trailing) return { name: trailing[1].trim(), qty: Math.max(1, parseInt(trailing[2], 10)) };
      if (leading) return { name: leading[2].trim(), qty: Math.max(1, parseInt(leading[1], 10)) };
      return { name: raw, qty: 1 };
    })
    .filter((item) => item.name.length > 0);
}
