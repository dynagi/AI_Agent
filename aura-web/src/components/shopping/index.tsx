import { Heart, ShoppingCart, Star, Minus, Plus, Trash2, ExternalLink, Package, X } from 'lucide-react';
import { NeonButton } from '../aura';
import type { Product } from '../../data/products';

export const money = (n: number, currency = 'INR') => {
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency, maximumFractionDigits: n % 1 ? 2 : 0 }).format(n);
  } catch {
    return `${currency} ${n}`;
  }
};

export function Stars({ value }: { value: number }) {
  return (
    <span className="stars" aria-label={`${value} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((i) => <Star key={i} size={11} fill={i <= Math.round(value) ? 'currentColor' : 'none'} />)}
    </span>
  );
}

function Thumb({ src, alt, size }: { src?: string; alt: string; size: number | string }) {
  return src
    ? <img src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" />
    : <span className="row" style={{ width: size, height: size, justifyContent: 'center' }} aria-hidden><Package size={26} className="t-mute" /></span>;
}

export function ProductCard({ p, lowest, liked, inCart, onLike, onAdd, onDismiss }: { p: Product; lowest?: boolean; liked: boolean; inCart: number; onLike: () => void; onAdd: () => void; onDismiss?: () => void }) {
  return (
    <article className="tile stack" style={{ gap: 7, padding: 10 }}>
      <div className="media" style={{ height: 118 }}>
        <Thumb src={p.image} alt={p.name} size="100%" />
        {lowest && <span className="media-badge" style={{ background: '#ff4f8b' }}>Lowest price</span>}
        <div className="row" style={{ position: 'absolute', top: 8, right: 8, gap: 6 }}>
          {onDismiss && (
            <button className="fav-btn" style={{ position: 'static' }} onClick={onDismiss} aria-label={`Not interested in ${p.name}`} title="Not interested">
              <X size={15} />
            </button>
          )}
          <button className={`fav-btn ${liked ? 'on' : ''}`} style={{ position: 'static' }} onClick={onLike} aria-pressed={liked} aria-label={liked ? `Remove ${p.name} from wishlist` : `Add ${p.name} to wishlist`}>
            <Heart size={17} fill={liked ? 'currentColor' : 'none'} />
          </button>
        </div>
      </div>
      <h4 className="t-title" style={{ fontSize: 14, minHeight: 38, margin: 0, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{p.name}</h4>
      <div className="t-sub ellipsis" style={{ fontSize: 12 }}>{p.provider}</div>
      {p.rating ? <div className="row t-sub" style={{ fontSize: 11.5, gap: 5 }}><Stars value={p.rating} /> {p.rating}{p.reviews ? ` (${p.reviews.toLocaleString('en-IN')})` : ''}</div> : <div style={{ height: 16 }} />}
      <b style={{ fontSize: 19 }}>{money(p.price, p.currency)}</b>
      <div className="row" style={{ gap: 6 }}>
        <NeonButton size="sm" variant="primary" icon={ShoppingCart} onClick={onAdd} style={{ flex: 1 }}>{inCart ? `In Cart (${inCart})` : 'Add'}</NeonButton>
        {p.link && <a className="icon-btn" href={p.link} target="_blank" rel="noopener noreferrer" aria-label={`View ${p.name} on ${p.provider}`} title={`Open on ${p.provider}`}><ExternalLink size={15} /></a>}
      </div>
    </article>
  );
}

export function CartLine({ p, qty, onDec, onInc, onRemove }: { p: Product; qty: number; onDec: () => void; onInc: () => void; onRemove: () => void }) {
  return (
    <div className="li">
      <span className="media" style={{ width: 46, height: 46, flexShrink: 0 }}><Thumb src={p.image} alt="" size={46} /></span>
      <div className="grow"><div className="t-title ellipsis" style={{ fontSize: 13 }}>{p.name}</div><div className="t-sub">{money(p.price, p.currency)} · {p.provider}</div></div>
      <div className="row" style={{ gap: 6 }}>
        <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={onDec} aria-label={`Decrease ${p.name}`}><Minus size={12} /></button>
        <span className="mono" aria-live="polite" style={{ minWidth: 14, textAlign: 'center' }}>{qty}</span>
        <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={onInc} aria-label={`Increase ${p.name}`}><Plus size={12} /></button>
        <button className="icon-btn bare" style={{ width: 24, height: 24 }} onClick={onRemove} aria-label={`Remove ${p.name}`}><Trash2 size={13} /></button>
      </div>
    </div>
  );
}
