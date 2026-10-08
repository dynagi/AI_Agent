import { useEffect, useState } from 'react';
import { ShieldCheck, ExternalLink } from 'lucide-react';
import { FuturisticModal, NeonButton, toast } from '../aura';
import { money } from '../shopping';
import { aura } from '../../services/aura';
import { buildProposal, type SupplyItem } from '../../state/periodSupplies';
import { cartStore } from '../../state/stores';
import type { CartLine } from '../../data/products';
import type { PeriodPrefs } from '../../data/wellness';

/** Shows the cheapest live offers for pads and cravings and asks for approval before anything is added to the cart. */
export default function SuppliesModal({ prefs, intro, onDone }: { prefs: PeriodPrefs; intro: string; onDone: (approved: boolean) => void }) {
  const [items, setItems] = useState<SupplyItem[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    buildProposal(prefs).then((p) => live && setItems(p)).catch((e) => live && setError(e instanceof Error && /bearer|401/i.test(e.message) ? 'Sign in to look up prices.' : 'Could not look up prices right now.'));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chosen = (items ?? []).filter((i) => i.checked && i.product);
  const currency = chosen[0]?.product?.currency ?? 'INR';
  const total = chosen.reduce((s, i) => s + (i.product?.price ?? 0) * i.qty, 0);

  const approve = async () => {
    setBusy(true);
    cartStore.set((cs) => {
      const next = [...cs];
      for (const i of chosen) {
        const p = i.product!;
        const at = next.findIndex((c) => c.id === p.id);
        if (at >= 0) next[at] = { ...next[at], qty: next[at].qty + i.qty };
        else next.push({ ...p, qty: i.qty } as CartLine);
      }
      return next;
    });
    try {
      await aura.approve('Add period essentials to cart', { items: chosen.map((i) => ({ name: i.product?.name, qty: i.qty, price: i.product?.price, store: i.product?.provider })) });
    } catch { /* the cart is already updated; the approval log is best-effort */ }
    toast(`${chosen.length} item${chosen.length === 1 ? '' : 's'} added to your Smart Cart. Nothing is ordered until you check out with the store.`);
    setBusy(false);
    onDone(true);
  };

  return (
    <FuturisticModal title="Period essentials — your approval" icon={ShieldCheck} tone="amber" onClose={() => !busy && onDone(false)}>
      <p className="t-sub" style={{ marginBottom: 12 }}>{intro}</p>
      {!items && !error && <div className="empty"><span className="spinner" /> Finding the lowest prices…</div>}
      {error && <div className="tag red" role="alert" style={{ padding: 8, whiteSpace: 'normal' }}>{error}</div>}
      <div className="list">
        {(items ?? []).map((i, idx) => (
          <label key={i.key} className="li" style={{ cursor: i.product ? 'pointer' : 'default', opacity: i.product ? 1 : 0.6 }}>
            <input type="checkbox" className="check" checked={i.checked} disabled={!i.product} onChange={(e) => setItems((its) => its!.map((x, j) => (j === idx ? { ...x, checked: e.target.checked } : x)))} aria-label={`Include ${i.label}`} />
            <div className="grow">
              <div className="t-title ellipsis">{i.product ? i.product.name : i.label}</div>
              <div className="t-sub">{i.kind === 'craving' ? 'Craving' : 'Essential'} · {i.product ? `${i.product.provider} · ${money(i.product.price, i.product.currency)}${i.qty > 1 ? ` × ${i.qty}` : ''}` : 'No offers found'}</div>
            </div>
            {i.product?.link && <a className="icon-btn bare" style={{ width: 26, height: 26 }} href={i.product.link} target="_blank" rel="noopener noreferrer" aria-label="View offer"><ExternalLink size={14} /></a>}
          </label>
        ))}
      </div>
      {items && <div className="row between" style={{ margin: '12px 0' }}><b>Total ({chosen.length} selected)</b><b className="c-cyan" style={{ fontSize: 20 }}>{money(total, currency)}</b></div>}
      <p className="t-mute" style={{ marginBottom: 14 }}>Approving adds the selected items to your Smart Cart only. AURA never places an order or takes payment — you finish checkout with the store.</p>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <NeonButton onClick={() => onDone(false)} disabled={busy}>Not now</NeonButton>
        <NeonButton variant="primary" onClick={() => void approve()} disabled={busy || !chosen.length}>{busy ? <span className="spinner" /> : 'Approve & add to cart'}</NeonButton>
      </div>
    </FuturisticModal>
  );
}
