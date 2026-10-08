import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, MoreHorizontal, X, type LucideIcon } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion, type HTMLMotionProps } from 'framer-motion';
import { Bar, toneHex, type Tone } from './primitives';
import { backdropFade, drawerSlide } from '../motion';

/* ---------- IconButton ---------- */
export function IconButton({ icon: Icon, label, size = 42, bare, className = '', ...rest }: {
  icon: LucideIcon; label: string; size?: number; bare?: boolean;
} & HTMLMotionProps<'button'>) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.button
      className={`icon-btn ${bare ? 'bare' : ''} ${className}`} aria-label={label} title={label} style={{ width: size, height: size }}
      {...(reduceMotion ? {} : { whileHover: { scale: 1.08 }, whileTap: { scale: 0.92 } })}
      {...rest}
    >
      <Icon size={Math.round(size * 0.42)} />
    </motion.button>
  );
}

/* ---------- ProgressBar (labelled) ---------- */
export function ProgressBar({ value, tone = 'cyan', label, right }: { value: number; tone?: Tone; label?: ReactNode; right?: ReactNode }) {
  return (
    <div className="stack" style={{ gap: 5 }}>
      {(label || right) && <div className="row between" style={{ fontSize: 13 }}><span>{label}</span><span className="t-sub mono">{right}</span></div>}
      <div role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}><Bar value={value} tone={tone} /></div>
    </div>
  );
}

/* ---------- CategoryBadge ---------- */
export function CategoryBadge({ label, tone = 'blue' }: { label: string; tone?: Tone }) {
  const c = toneHex[tone];
  return <span className="tag" style={{ color: c, borderColor: `${c}66`, background: `${c}18` }}>{label}</span>;
}

/* ---------- Tooltip (CSS-driven, accessible via aria-describedby) ---------- */
export function Tooltip({ text, children }: { text: string; children: ReactNode }) {
  const id = useId();
  return (
    <span className="tooltip-wrap" aria-describedby={id}>
      {children}
      <span role="tooltip" id={id} className="tooltip">{text}</span>
    </span>
  );
}

/* ---------- AvatarGroup ---------- */
export function AvatarGroup({ srcs, size = 30, max = 4 }: { srcs: string[]; size?: number; max?: number }) {
  return (
    <span className="row" style={{ gap: 0 }}>
      {srcs.slice(0, max).map((s, i) => (
        <img key={s + i} src={s} alt="" style={{ width: size, height: size, borderRadius: '50%', border: '2px solid var(--aura-bg)', marginLeft: i ? -size / 3 : 0, objectFit: 'cover' }} />
      ))}
      {srcs.length > max && <span className="avatar" style={{ width: size, height: size, fontSize: 11, marginLeft: -size / 3 }}>+{srcs.length - max}</span>}
    </span>
  );
}

/* ---------- Click-outside hook ---------- */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, close]);
  return ref;
}

/* ---------- FilterDropdown (single select) ---------- */
export function FilterDropdown<T extends string>({ label, value, options, onChange, icon: Icon, align = 'left' }: {
  label?: string; value: T; options: readonly T[]; onChange: (v: T) => void; icon?: LucideIcon; align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="chip" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)} style={{ padding: '10px 14px', fontSize: 13.5, color: '#fff' }}>
        {Icon && <Icon size={15} />} {label ? `${label}: ` : ''}{value} <ChevronDown size={14} />
      </button>
      {open && (
        <ul role="listbox" className="menu" style={{ [align]: 0 }}>
          {options.map((o) => (
            <li key={o}>
              <button role="option" aria-selected={o === value} onClick={() => { onChange(o); setOpen(false); }}>
                <span style={{ width: 14 }}>{o === value && <Check size={14} className="c-cyan" />}</span>{o}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---------- MoreMenu (row actions) ---------- */
export interface MenuItem { label: string; icon?: LucideIcon; danger?: boolean; onSelect: () => void }
export function MoreMenu({ items, label = 'More actions', vertical }: { items: MenuItem[]; label?: string; vertical?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="icon-btn bare" style={{ width: 28, height: 28 }} aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
        <MoreHorizontal size={17} style={vertical ? { transform: 'rotate(90deg)' } : undefined} />
      </button>
      {open && (
        <ul role="menu" className="menu" style={{ right: 0 }}>
          {items.map((it) => (
            <li key={it.label}>
              <button role="menuitem" className={it.danger ? 'c-red' : ''} onClick={(e) => { e.stopPropagation(); setOpen(false); it.onSelect(); }}>
                {it.icon && <it.icon size={14} />} {it.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---------- Drawer (right panel on desktop, bottom sheet on mobile) ---------- */
export function Drawer({ title, open, onClose, children, icon: Icon }: { title: string; open: boolean; onClose: () => void; children: ReactNode; icon?: LucideIcon }) {
  const reduceMotion = useReducedMotion();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="drawer-back" onClick={onClose} variants={backdropFade} initial={reduceMotion ? false : 'hidden'} animate="show" exit="hidden">
          <motion.aside
            className="drawer hud corners" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}
            variants={drawerSlide} initial={reduceMotion ? false : 'hidden'} animate="show" exit="hidden"
          >
            <div className="hud-head">
              <h3>{Icon && <Icon size={18} />}{title}</h3>
              <button className="icon-btn" style={{ marginLeft: 'auto', width: 34, height: 34 }} onClick={onClose} aria-label="Close"><X size={16} /></button>
            </div>
            <div className="drawer-body">{children}</div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ---------- DataTable (scrolls horizontally on small screens) ---------- */
export interface Column<T> { key: string; header: string; render: (row: T) => ReactNode; align?: 'left' | 'right' | 'center' }
export function DataTable<T>({ columns, rows, rowKey, caption }: { columns: Column<T>[]; rows: T[]; rowKey: (r: T) => string; caption?: string }) {
  return (
    <div className="table-scroll">
      <table className="data-table">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead><tr>{columns.map((c) => <th key={c.key} style={{ textAlign: c.align ?? 'left' }}>{c.header}</th>)}</tr></thead>
        <tbody>{rows.map((r) => <tr key={rowKey(r)}>{columns.map((c) => <td key={c.key} style={{ textAlign: c.align ?? 'left' }}>{c.render(r)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}
