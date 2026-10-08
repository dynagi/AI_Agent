import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { CheckCircle2, ArrowRight, ChevronRight, ChevronLeft, ShoppingCart, Mic, Store, ShieldCheck, ExternalLink, Search, BarChart3, CalendarDays, Zap, Sparkles } from 'lucide-react';
import { Hud, PageHero, NeonButton, Toggle, FuturisticModal, SyncStatus, toast, toneHex } from '../components/aura';
import { AICommandPanel, confirmActions, type AIAction, type AIReply } from '../components/ai';
import { ProductCard, CartLine, money } from '../components/shopping';
import { categories, categoryQuery, type Product, type CartLine as CartItem, type ProductCategory, type Subscription } from '../data/products';
import { cartStore, wishlistStore, subscriptionsStore, shoppingFeedbackStore, orderPrefsStore } from '../state/stores';
import { uid } from '../state/store';
import {
  searchProducts, rankSuggestions, logShoppingEvents, getShoppingForecast, shopAssist, getShoppingPolicy, saveShoppingPolicy,
  type ShoppingForecast, type AssistReply, type ShoppingPolicy,
} from '../services/shopping';
import { extensionStore, quickCartStore, startQuickCart, parseShoppingList, cartAgentAnyStore, KNOWN_STORES, openAccessibilitySettings, retryPendingCart, syncAllStoreHistories } from '../services/extension';
import { aura } from '../services/aura';
import { orderDestination, startOrder } from '../services/orderFlow';

const FREQUENCIES = [['Every month', 1], ['Every 2 months', 2], ['Every 3 months', 3]] as const;
const nextOn = (months: number) => { const d = new Date(); d.setMonth(d.getMonth() + months); return d.toISOString().slice(0, 10); };

export default function Shopping() {
  const cart = cartStore.use();
  const wish = wishlistStore.use();
  const subs = subscriptionsStore.use();
  orderPrefsStore.use(); // loads the remembered store/variant choices used by "order milk"
  const nav = useNavigate();
  const loc = useLocation();
  // Chat / Voice hand an order request here so it runs in the shopping assistant.
  const [trigger] = useState(() => { const ask = (loc.state as { ask?: string } | null)?.ask; return ask ? { prompt: ask, id: 1 } : null; });
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [cat, setCat] = useState<'All' | ProductCategory>('All');
  const [results, setResults] = useState<Product[]>([]);
  const [state, setState] = useState<{ status: 'idle' | 'loading' | 'error'; error: string }>({ status: 'idle', error: '' });
  const [all, setAll] = useState(false);
  const [catStart, setCatStart] = useState(0);
  const [checkout, setCheckout] = useState(false);
  const [reorder, setReorder] = useState({ productId: '', every: 1 });
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const seq = useRef(0);

  const run = async (q: string) => {
    const term = q.trim();
    if (!term) return [];
    const mine = ++seq.current;
    setQuery(term);
    setState({ status: 'loading', error: '' });
    setAll(false);
    logShoppingEvents([{ action: 'search', name: term }]);
    try {
      const found = await searchProducts(term);
      if (mine === seq.current) { setResults(found); setState({ status: 'idle', error: '' }); }
      // Re-rank by predicted interest once the AI service responds; falls back
      // silently (keeps price order) if it's unavailable or has no model yet.
      void rankSuggestions(found, cat !== 'All' ? cat : undefined).then((ranked) => {
        if (mine === seq.current) setResults(ranked);
      });
      return found;
    } catch (e) {
      if (mine === seq.current) { setResults([]); setState({ status: 'error', error: e instanceof Error ? e.message : 'Search failed' }); }
      return [];
    }
  };

  useEffect(() => { if (cat !== 'All') void run(categoryQuery[cat]); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [cat]);

  // "Hey Aura, find this" (a product seen on the phone's screen) opens here with the search it worked out
  const handedSearch = (loc.state as { search?: string } | null)?.search;
  useEffect(() => { if (handedSearch) { setDraft(handedSearch); void run(handedSearch); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [handedSearch]);

  const submit = (e: FormEvent) => { e.preventDefault(); setCat('All'); void run(draft); };

  /** Snapshots an interested/not-interested reaction for the daily interest model. */
  const recordFeedback = (p: Product, interested: boolean) => {
    shoppingFeedbackStore.set((fb) => [
      ...fb,
      {
        id: uid('fb'), productId: p.id, interested, name: p.name, price: p.price, currency: p.currency,
        provider: p.provider, rating: p.rating, reviews: p.reviews, category: cat !== 'All' ? cat : undefined,
        createdAt: new Date().toISOString(),
      },
    ]);
  };

  const visible = results.filter((p) => !dismissed.has(p.id));
  const shown = all ? visible : visible.slice(0, 10);
  const lowest = visible[0];
  const byStore = useMemo(() => {
    const best = new Map<string, Product>();
    for (const p of results) if (!best.has(p.provider)) best.set(p.provider, p);
    return [...best.values()].slice(0, 6);
  }, [results]);

  const lines = cart.filter((c) => c.qty > 0);
  const currency = lines[0]?.currency ?? 'INR';
  const total = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const count = lines.reduce((s, l) => s + l.qty, 0);
  const cartQty = (id: string) => cart.find((c) => c.id === id)?.qty ?? 0;
  const setQty = (id: string, d: number) => cartStore.set((cs) => cs.map((c) => (c.id === id ? { ...c, qty: Math.max(0, c.qty + d) } : c)).filter((c) => c.qty > 0));
  const addToCart = (p: Product) => {
    logShoppingEvents([{ action: 'add_to_cart', name: p.name, app: p.provider, price: p.price, qty: 1 }]);
    cartStore.set((cs) => (cs.some((c) => c.id === p.id) ? cs.map((c) => (c.id === p.id ? { ...c, qty: c.qty + 1 } : c)) : [...cs, { ...p, qty: 1 } as CartItem]));
  };
  const byProvider = lines.reduce<Record<string, CartItem[]>>((acc, l) => ({ ...acc, [l.provider]: [...(acc[l.provider] ?? []), l] }), {});

  const known = [...cart, ...wish].filter((p, i, a) => a.findIndex((x) => x.id === p.id) === i);
  const addReorder = () => {
    const p = known.find((k) => k.id === reorder.productId);
    if (!p) { toast('Pick a saved or carted product first.'); return; }
    const f = FREQUENCIES.find(([, m]) => m === reorder.every) ?? FREQUENCIES[0];
    subscriptionsStore.set((ss) => [...ss, { id: uid('sub'), name: p.name, image: p.image, every: f[0], next: nextOn(f[1]), active: true, link: p.link } as Subscription]);
    toast(`Reminder set: ${p.name} — ${f[0].toLowerCase()}. AURA reminds you; it never orders on its own.`);
  };

  const context = () => JSON.stringify({
    query, currency: results[0]?.currency ?? 'INR',
    cheapestOffers: results.slice(0, 10).map((r) => ({ name: r.name, price: r.price, store: r.provider })),
    cart: lines.map((l) => ({ name: l.name, qty: l.qty, price: l.price, store: l.provider })),
  });
  /** A turn with the shopping assistant as a panel reply: its question, with the options as one-tap answers. */
  const assistReply = (r: AssistReply): AIReply => {
    if (r.cartOrder?.items?.length) void startQuickCart({ ...r.cartOrder });
    return {
      text: r.say ?? '',
      actions: r.pending ? (r.quickReplies ?? []).map<AIAction>((label) => ({
        label, variant: /^no$/i.test(label) ? 'default' : 'primary',
        run: async () => assistReply(await shopAssist(label)),
      })) : undefined,
    };
  };
  const ai = async (p: string): Promise<AIReply> => {
    // Medicines go to the pharmacy flow.
    if (orderDestination(p) === '/wellness?tab=Medicines') {
      const med = startOrder(p, (path) => nav(path));
      if (med) return med;
    }
    // Price comparison stays on this page.
    const m = p.match(/^(?:find|search(?: for)?|compare|show me)\s+(.+)/i);
    if (!m) {
      // Orders, and answers to what the assistant just asked ("Zepto", "the cheaper one", "yes"): the server's
      // decision engine understands the request against your history, shows the real options, and asks before
      // a new purchase. If it can't be reached, fall back to the simple on-device flow.
      try {
        const r = await shopAssist(p);
        if (r.handled) return assistReply(r);
      } catch {
        const local = startOrder(p, (path) => nav(path));
        if (local) return local;
      }
      const reply = await aura.chat(`[shopping] ${p}`, context());
      return { text: reply.text };
    }
    const term = m[1].replace(/\bunder\s*[\d,.]+\s*k?\b/i, '').trim() || m[1];
    const found = await run(term);
    if (!found.length) return { text: `I couldn't find live offers for “${term}”. Try different wording.` };
    const top = found.slice(0, 3);
    return {
      text: `I compared ${found.length} live offers across ${new Set(found.map((f) => f.provider)).size} stores. The lowest price is ${money(top[0].price, top[0].currency)} at ${top[0].provider}.`,
      preview: top.map((t) => `${t.name.slice(0, 60)} · ${money(t.price, t.currency)} · ${t.provider}`),
      actions: confirmActions('Add lowest to cart', () => { addToCart(top[0]); return `${top[0].name.slice(0, 50)} added to your Smart Cart. Nothing is ordered until you check out with the store.`; }),
    };
  };

  const visibleCats = categories.slice(catStart, catStart + 10);

  return (
    <div className="module">
      <div className="main">
        <PageHero title={<>Shop <span className="grad-cyan">Smarter</span><br />with <span className="grad">AURA</span></>}
          lead="Search once. AURA compares live prices across stores and shows you the lowest — you check out with the store."
          image="/aura/hero-shopping.jpg" imageWidth="40%" quote="Compare everywhere. Pay the lowest price.">
          <div className="row wrap" style={{ gap: 18, marginTop: 18 }}>
            {['Live price comparison', 'Lowest price first', 'Save for later', 'Hand-off to the store'].map((f) => <span key={f} className="row" style={{ gap: 7, fontSize: 14 }}><CheckCircle2 size={20} className="c-blue" /> {f}</span>)}
          </div>
        </PageHero>

        <form className="hud row" onSubmit={submit} style={{ padding: '10px 12px' }}>
          <Search size={20} className="c-cyan" />
          <input style={{ flex: 1, minWidth: 0, background: 'none', border: 0, outline: 0, fontSize: 15, color: '#fff' }} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Search any product, e.g. “whey protein 1kg” or “laptop under 60000”" aria-label="Search products" />
          <NeonButton variant="ai" type="submit" disabled={!draft.trim() || state.status === 'loading'}>{state.status === 'loading' ? <span className="spinner" /> : 'Compare prices'}</NeonButton>
        </form>

        <div className="row" style={{ gap: 8 }}>
          {catStart > 0 && <button className="icon-btn" aria-label="Previous categories" onClick={() => setCatStart((s) => Math.max(0, s - 3))}><ChevronLeft size={18} /></button>}
          <div className="tabs" style={{ flex: 1 }} role="tablist" aria-label="Product categories">
            {visibleCats.map((c) => (
              <button key={c.label} role="tab" aria-selected={cat === c.label} className={`chip ${cat === c.label ? 'active' : ''}`} onClick={() => { if (c.label === 'All') { setCat('All'); setResults([]); setQuery(''); } else setCat(c.label); }} style={{ flexDirection: 'column', minWidth: 92, flex: 1, padding: '10px 6px', gap: 6 }}>
                <c.icon size={22} style={{ color: toneHex[c.tone] }} /> <span style={{ fontSize: 12 }}>{c.label}</span>
              </button>
            ))}
          </div>
          <button className="icon-btn" aria-label="More categories" onClick={() => setCatStart((s) => (s + 10 >= categories.length ? 0 : s + 3))}><ChevronRight size={18} /></button>
        </div>

        <Hud corners>
          <div className="row between" style={{ marginBottom: 14 }}>
            <h2 className="section-title">{query ? <>Lowest prices for <span className="grad-cyan">“{query}”</span></> : 'Search to compare prices'}{results.length > 0 && <span className="t-sub" style={{ fontSize: 14 }}> · {results.length} offers</span>}</h2>
            {results.length > 10 && <button className="link c-blue row" style={{ background: 'none', border: 0 }} onClick={() => setAll((a) => !a)}>{all ? 'Show less' : 'See All'} <ArrowRight size={15} /></button>}
          </div>
          {state.status === 'loading' && <div className="empty"><span className="spinner" /> Comparing live prices…</div>}
          {state.status === 'error' && <div className="tag red" role="alert" style={{ padding: 10, whiteSpace: 'normal' }}>{/bearer|401/i.test(state.error) ? 'Sign in to search live prices.' : state.error}</div>}
          {state.status === 'idle' && !results.length && <div className="empty">{query ? `No offers found for “${query}”.` : 'Type a product above, or pick a category. Results come live from many stores, cheapest first.'}</div>}
          <div className="grid g5" style={{ gap: 12 }}>
            {shown.map((p) => (
              <ProductCard key={p.id} p={p} lowest={p.id === lowest?.id} liked={wish.some((w) => w.id === p.id)} inCart={cartQty(p.id)}
                onLike={() => {
                  const on = wish.some((w) => w.id === p.id);
                  wishlistStore.set((w) => (on ? w.filter((x) => x.id !== p.id) : [...w, p]));
                  if (!on) {
                    recordFeedback(p, true);
                    logShoppingEvents([{ action: 'wishlist', name: p.name, app: p.provider, price: p.price }]);
                  }
                  toast(on ? 'Removed from wishlist.' : 'Saved to wishlist.');
                }}
                onAdd={() => { addToCart(p); toast('Added to Smart Cart.'); }}
                onDismiss={() => { setDismissed((d) => new Set(d).add(p.id)); recordFeedback(p, false); logShoppingEvents([{ action: 'not_interested', name: p.name, app: p.provider }]); toast('Got it — fewer like this.'); }} />
            ))}
          </div>
        </Hud>

        {wish.length > 0 && (
          <Hud corners title={<span className="section-title">Saved for later</span>}>
            <div className="grid g5" style={{ gap: 12 }}>
              {wish.map((p) => <ProductCard key={p.id} p={p} liked inCart={cartQty(p.id)} onLike={() => wishlistStore.set((w) => w.filter((x) => x.id !== p.id))} onAdd={() => { addToCart(p); toast('Added to Smart Cart.'); }} />)}
            </div>
          </Hud>
        )}

        <Hud corners>
          <div className="row between" style={{ marginBottom: 14 }}>
            <h2 className="section-title">Reorder Reminders</h2>
            <span className="t-sub">{subs.filter((s) => s.active).length} active</span>
          </div>
          <div className="row wrap" style={{ gap: 8, marginBottom: 12 }}>
            <select className="select" style={{ minWidth: 220, flex: 1 }} value={reorder.productId} onChange={(e) => setReorder({ ...reorder, productId: e.target.value })} aria-label="Product to remind about">
              <option value="">{known.length ? 'Choose a saved or carted product…' : 'Save or add a product first'}</option>
              {known.map((k) => <option key={k.id} value={k.id}>{k.name.slice(0, 60)}</option>)}
            </select>
            <select className="select" value={reorder.every} onChange={(e) => setReorder({ ...reorder, every: Number(e.target.value) })} aria-label="How often">
              {FREQUENCIES.map(([l, m]) => <option key={l} value={m}>{l}</option>)}
            </select>
            <NeonButton onClick={addReorder} disabled={!known.length}>Add reminder</NeonButton>
          </div>
          <div className="grid g4" style={{ gap: 12 }}>
            {subs.map((s) => (
              <div key={s.id} className="tile row" style={{ gap: 12, alignItems: 'flex-start' }}>
                {s.image && <span className="media" style={{ width: 58, height: 58, flexShrink: 0 }}><img src={s.image} alt="" referrerPolicy="no-referrer" /></span>}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row between"><b className="ellipsis" style={{ fontSize: 14 }}>{s.name}</b><Toggle on={s.active} onChange={(v) => { subscriptionsStore.set((xs) => xs.map((x) => (x.id === s.id ? { ...x, active: v } : x))); toast(`${s.name} reminder ${v ? 'resumed' : 'paused'}.`); }} label={`Reorder reminder for ${s.name}`} /></div>
                  <div className="t-sub">{s.every}</div>
                  <div className="row t-sub" style={{ fontSize: 12, marginTop: 4, gap: 5 }}><CalendarDays size={13} /> {s.active ? `Next: ${new Date(`${s.next}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : 'Paused'}</div>
                </div>
              </div>
            ))}
          </div>
          {!subs.length && <div className="empty">No reminders yet.</div>}
          <div style={{ marginTop: 10 }}><SyncStatus stores={[cartStore, wishlistStore, subscriptionsStore, shoppingFeedbackStore]} /></div>
        </Hud>
      </div>

      <div className="rail">
        <AICommandPanel title="Need something?" badge={null} icon={Store} header={<p className="t-sub" style={{ marginTop: -6, marginBottom: 10 }}>Just tell me…</p>}
          prompts={['Order milk and eggs from Zepto', 'Get my usual groceries', 'What am I running out of?', 'Compare wireless earbuds']} promptStyle="bullets"
          onAsk={ai} trigger={trigger} cta="Tell AURA to shop" ctaIcon={Mic} placeholder="What do you need?" />

        <QuickCartPanel />

        <ForecastPanel />

        <RulesPanel />

        {byStore.length > 1 && (
          <Hud corners title={<span className="row" style={{ gap: 8 }}><BarChart3 size={18} className="c-cyan" /> Cheapest by store</span>}>
            <div className="list">
              {byStore.map((p, i) => (
                <a key={p.provider} className="li" href={p.link} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none', color: 'inherit' }}>
                  <div className="grow"><div className="t-title" style={{ fontSize: 13 }}>{p.provider}</div><div className="t-sub ellipsis" style={{ fontSize: 11.5 }}>{p.name}</div></div>
                  <b className={i === 0 ? 'c-green' : ''}>{money(p.price, p.currency)}</b>
                </a>
              ))}
            </div>
          </Hud>
        )}

        <Hud corners>
          <div className="row between" style={{ marginBottom: 6 }}>
            <h3 className="row" style={{ fontSize: 17 }}><ShoppingCart size={18} className="c-cyan" /> Smart Cart <span className="tag blue" style={{ borderRadius: 12 }}>{count}</span></h3>
            {lines.length > 0 && <button className="link c-blue" style={{ background: 'none', border: 0, fontSize: 12.5 }} onClick={() => { cartStore.set([]); toast('Cart cleared.'); }}>Clear</button>}
          </div>
          <div className="list">
            {lines.map((p) => <CartLine key={p.id} p={p} qty={p.qty} onDec={() => setQty(p.id, -1)} onInc={() => setQty(p.id, 1)} onRemove={() => cartStore.set((cs) => cs.filter((c) => c.id !== p.id))} />)}
            {!lines.length && <div className="empty">Your cart is empty.</div>}
          </div>
          <div className="row between" style={{ margin: '12px 0' }}><span>Total ({count} items)</span><b style={{ fontSize: 22 }}>{money(total, currency)}</b></div>
          <NeonButton variant="ai" block disabled={!lines.length} onClick={() => setCheckout(true)}>Review &amp; buy at stores <ArrowRight size={16} /></NeonButton>
        </Hud>
      </div>

      {checkout && (
        <FuturisticModal title="Review & hand off" icon={ShieldCheck} tone="amber" onClose={() => setCheckout(false)}>
          <p className="t-sub" style={{ marginBottom: 12 }}>AURA doesn't sell products or take payment. Open each store below to complete your purchase there.</p>
          {Object.entries(byProvider).map(([prov, ls]) => (
            <div key={prov} className="tile" style={{ marginBottom: 8 }}>
              <div className="row between"><b>{prov}</b><span className="mono">{money(ls.reduce((s, l) => s + l.price * l.qty, 0), ls[0].currency)}</span></div>
              {ls.map((l) => (
                <div key={l.id} className="row between t-sub" style={{ fontSize: 13 }}>
                  <span className="ellipsis">{l.qty} × {l.name}</span>
                  {l.link && <a className="c-blue row" style={{ gap: 4, flexShrink: 0 }} href={l.link} target="_blank" rel="noopener noreferrer">Open <ExternalLink size={12} /></a>}
                </div>
              ))}
            </div>
          ))}
          <div className="row between" style={{ margin: '10px 0 16px' }}><b>Total</b><b className="c-cyan" style={{ fontSize: 20 }}>{money(total, currency)}</b></div>
          <div className="row" style={{ justifyContent: 'flex-end' }}><NeonButton onClick={() => setCheckout(false)}>Close</NeonButton></div>
        </FuturisticModal>
      )}
    </div>
  );
}

/**
 * Hands a shopping list to the cart agent, which adds each item to your cart on the chosen store by
 * itself and stops at the cart (payment isn't automated). In the phone app it works on any store; on
 * the web it needs the browser extension and covers Blinkit/Zepto/Instamart.
 */
function QuickCartPanel() {
  const { installed } = extensionStore.use();
  const progress = quickCartStore.use();
  const [store, setStore] = useState('Blinkit');
  const [list, setList] = useState('');

  const submit = () => {
    const items = parseShoppingList(list);
    if (!items.length) { toast('Add at least one item, e.g. "milk x2, eggs, bread".'); return; }
    if (!store.trim()) { toast('Which store? e.g. Zepto, Amazon, BigBasket.'); return; }
    void startQuickCart({ store: store.trim(), items });
  };

  return (
    <Hud corners title={<span className="row" style={{ gap: 8 }}><Zap size={18} className="c-cyan" /> Quick Cart</span>}>
      <p className="t-sub" style={{ fontSize: 12.5, marginTop: -6, marginBottom: 10 }}>
        AURA opens the store and adds these to your cart by itself, then stops at the cart. Payment isn't automated yet.
      </p>
      {!cartAgentAnyStore && !installed && (
        <div className="tag amber" style={{ padding: 8, whiteSpace: 'normal', fontSize: 12, marginBottom: 10 }}>
          On the web this needs the AURA Cart Assistant extension (see <code>browser-extension/README.md</code>) and works on Blinkit, Zepto and Instamart. The phone app works on any store.
        </div>
      )}
      <textarea className="hud-textarea" rows={2} placeholder="milk x2, eggs, bread" value={list} onChange={(e) => setList(e.target.value)} style={{ marginBottom: 8 }} aria-label="Shopping list" />
      <div className="row wrap" style={{ gap: 8 }}>
        <input className="select" list="aura-stores" value={store} onChange={(e) => setStore(e.target.value)} aria-label="Store" placeholder="Any store" style={{ flex: 1, minWidth: 140 }} />
        <datalist id="aura-stores">{KNOWN_STORES.map((s) => <option key={s} value={s} />)}</datalist>
        <NeonButton variant="primary" onClick={submit} disabled={!list.trim() || progress.status === 'running'}>Fill my cart</NeonButton>
      </div>
      {cartAgentAnyStore && (
        <button className="link c-blue" style={{ background: 'none', border: 0, fontSize: 12.5, marginTop: 8, padding: 0 }}
          disabled={!store.trim() || progress.status === 'running'}
          onClick={() => void startQuickCart({ store: store.trim(), items: [], syncHistory: true })}>
          Learn from my past {store.trim() || 'store'} orders
        </button>
      )}
      {cartAgentAnyStore && (
        <button className="link c-blue" style={{ background: 'none', border: 0, fontSize: 12.5, marginTop: 6, padding: 0, display: 'block' }}
          disabled={progress.status === 'running'} onClick={() => void syncAllStoreHistories()}>
          Learn from all my stores (reads past orders in every shopping app on this phone)
        </button>
      )}
      <QuickCartStatus />
    </Hud>
  );
}

function QuickCartStatus() {
  const progress = quickCartStore.use();
  if (progress.status === 'idle') return null;
  return (
    <div className="t-sub" style={{ fontSize: 12.5, marginTop: 10 }}>
      {progress.status === 'running' && <span className="row" style={{ gap: 6 }}><span className="spinner" /> {progress.message}</span>}
      {progress.status === 'needs_you' && <span className="c-amber">{progress.message} (then tap Continue on the AURA bar)</span>}
      {progress.status === 'needs_setup' && (
        <div>
          <span className="c-amber">{progress.message}</span>
          <div className="row wrap" style={{ gap: 8, marginTop: 8 }}>
            <NeonButton onClick={openAccessibilitySettings}>Open Accessibility settings</NeonButton>
            <NeonButton variant="primary" onClick={() => retryPendingCart('auto')}>Fill in app</NeonButton>
            <NeonButton onClick={() => retryPendingCart('web')}>Use website instead</NeonButton>
          </div>
        </div>
      )}
      {progress.status === 'done' && <span className="c-green">{progress.message}</span>}
      {progress.status === 'error' && <span className="c-red">{progress.message}</span>}
    </div>
  );
}

/** What the next-purchase model expects the user to need this week, with one-tap cart filling per store. */
function ForecastPanel() {
  const [forecast, setForecast] = useState<ShoppingForecast | null>(null);
  const [error, setError] = useState('');
  const progress = quickCartStore.use();

  useEffect(() => {
    let live = true;
    getShoppingForecast()
      .then((f) => { if (live) { setForecast(f); setError(''); } })
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : 'Unavailable'); });
    return () => { live = false; };
  }, [progress.status === 'done']);

  const items = forecast?.nextPurchases ?? [];
  return (
    <Hud corners title={<span className="row" style={{ gap: 8 }}><Sparkles size={18} className="c-cyan" /> You'll likely need</span>}>
      {error && <div className="empty">{/bearer|401/i.test(error) ? 'Sign in to see predictions.' : error}</div>}
      {!error && forecast?.status === 'cold_start' && <div className="empty">Order a few times and AURA will learn what you run out of.</div>}
      {!error && !forecast && <div className="empty"><span className="spinner" /> Predicting…</div>}
      <div className="list">
        {items.slice(0, 6).map((i) => (
          <div key={i.item} className="li" title={i.why}>
            <div className="grow">
              <div className="t-title" style={{ fontSize: 13, textTransform: 'capitalize' }}>{i.item}{i.usualQty > 1 ? ` ×${i.usualQty}` : ''}</div>
              <div className="t-sub ellipsis" style={{ fontSize: 11.5 }}>
                {i.dueInDays !== null ? (i.dueInDays < 1 ? 'due now' : `due in ~${Math.round(i.dueInDays)}d`) : i.why}{i.store ? ` · ${i.store}` : ''}
              </div>
            </div>
            <b className={i.probability >= 0.7 ? 'c-green' : ''}>{Math.round(i.probability * 100)}%</b>
          </div>
        ))}
      </div>
      {(forecast?.suggestedBaskets ?? []).filter((b) => b.store).slice(0, 2).map((b) => (
        <NeonButton key={b.store} block style={{ marginTop: 8 }} disabled={progress.status === 'running'}
          onClick={() => void startQuickCart({ store: b.store!, items: b.items })}>
          Fill {b.store} cart ({b.items.length}) · ~{money(b.estimatedAmountInr, 'INR')}
        </NeonButton>
      ))}
    </Hud>
  );
}

/**
 * The user's purchase rules: what AURA must ask about and what it may add to a cart by itself. AURA never acts
 * outside these (and never pays).
 */
function RulesPanel() {
  const [policy, setPolicy] = useState<ShoppingPolicy | null>(null);
  const [error, setError] = useState('');
  const [rule, setRule] = useState({ item: '', provider: '', max_price: '', max_qty: '2' });

  useEffect(() => {
    let live = true;
    getShoppingPolicy().then((p) => { if (live) setPolicy(p); }).catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : 'Unavailable'); });
    return () => { live = false; };
  }, []);

  const save = (next: ShoppingPolicy) => {
    setPolicy(next);
    saveShoppingPolicy(next).then(setPolicy).catch(() => toast('Could not save your shopping rules.'));
  };
  const addRule = () => {
    if (!policy || !rule.item.trim()) { toast('Name the item, e.g. milk.'); return; }
    save({ ...policy, auto_order_rules: [...policy.auto_order_rules, {
      item: rule.item.trim().toLowerCase(), provider: rule.provider.trim() || null,
      max_price: rule.max_price ? Number(rule.max_price) : null, max_qty: Math.max(1, Number(rule.max_qty) || 1),
    }] });
    setRule({ item: '', provider: '', max_price: '', max_qty: '2' });
  };

  return (
    <Hud corners title={<span className="row" style={{ gap: 8 }}><ShieldCheck size={18} className="c-cyan" /> Shopping rules</span>}>
      {error && <div className="empty">{/bearer|401/i.test(error) ? 'Sign in to set your rules.' : error}</div>}
      {!error && !policy && <div className="empty"><span className="spinner" /> Loading…</div>}
      {policy && (
        <div className="list" style={{ fontSize: 13 }}>
          <div className="li"><span className="grow">Ask before a product I haven't bought before</span>
            <Toggle on={policy.require_confirmation_for_new_product} label="Confirm new products" onChange={(v) => save({ ...policy, require_confirmation_for_new_product: v })} /></div>
          <div className="li"><span className="grow">Always ask above (₹)</span>
            <input className="select" type="number" min={0} style={{ width: 90 }} aria-label="Confirm above amount" defaultValue={policy.require_confirmation_above}
              onBlur={(e) => save({ ...policy, require_confirmation_above: Math.max(0, Number(e.target.value) || 0) })} /></div>
          <div className="li"><span className="grow">Ask if the price is this % above my usual</span>
            <input className="select" type="number" min={0} style={{ width: 90 }} aria-label="Price jump percent" defaultValue={policy.max_price_deviation_percent}
              onBlur={(e) => save({ ...policy, max_price_deviation_percent: Math.max(0, Number(e.target.value) || 0) })} /></div>
          <div className="li"><span className="grow">Allow automatic repeat orders (only the rules below)</span>
            <Toggle on={policy.allow_auto_repeat_orders} label="Automatic repeat orders" onChange={(v) => save({ ...policy, allow_auto_repeat_orders: v })} /></div>
          {policy.auto_order_rules.map((r, i) => (
            <div key={`${r.item}-${i}`} className="li t-sub" style={{ fontSize: 12.5 }}>
              <span className="grow">{r.item}{r.provider ? ` from ${r.provider}` : ''}{r.max_price ? ` up to ₹${r.max_price}` : ''}, max ×{r.max_qty}</span>
              <button className="link c-blue" style={{ background: 'none', border: 0 }} onClick={() => save({ ...policy, auto_order_rules: policy.auto_order_rules.filter((_, j) => j !== i) })}>Remove</button>
            </div>
          ))}
          {policy.allow_auto_repeat_orders && (
            <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
              <input className="select" style={{ flex: 2, minWidth: 80 }} placeholder="item (milk)" value={rule.item} onChange={(e) => setRule({ ...rule, item: e.target.value })} aria-label="Item" />
              <input className="select" style={{ flex: 2, minWidth: 80 }} list="aura-stores" placeholder="store" value={rule.provider} onChange={(e) => setRule({ ...rule, provider: e.target.value })} aria-label="Store" />
              <input className="select" style={{ flex: 1, minWidth: 60 }} type="number" placeholder="max ₹" value={rule.max_price} onChange={(e) => setRule({ ...rule, max_price: e.target.value })} aria-label="Max price" />
              <input className="select" style={{ flex: 1, minWidth: 50 }} type="number" min={1} placeholder="qty" value={rule.max_qty} onChange={(e) => setRule({ ...rule, max_qty: e.target.value })} aria-label="Max quantity" />
              <NeonButton onClick={addRule}>Add rule</NeonButton>
            </div>
          )}
          <p className="t-sub" style={{ fontSize: 11.5, marginTop: 8 }}>AURA fills the cart and stops. It never pays, and never orders outside these rules.</p>
        </div>
      )}
    </Hud>
  );
}
