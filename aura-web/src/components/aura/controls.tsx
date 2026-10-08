import { useId, type InputHTMLAttributes, type ReactNode, type FormEvent } from 'react';
import { ChevronsRight, Mic, Send, X, type LucideIcon } from 'lucide-react';
import { motion, useReducedMotion, type HTMLMotionProps } from 'framer-motion';
import { Wave } from '../ui';
import { pressable, modalPop, backdropFade } from '../motion';

/* ---------- NeonButton ---------- */

type Variant = 'default' | 'primary' | 'ai' | 'ghost' | 'danger' | 'success';

export function NeonButton({ variant = 'default', size, hex, display, chevron, block, icon: Icon, children, className = '', ...rest }: {
  variant?: Variant; size?: 'sm' | 'lg'; hex?: boolean; display?: boolean; chevron?: boolean; block?: boolean; icon?: LucideIcon; children?: ReactNode;
} & HTMLMotionProps<'button'>) {
  const cls = ['btn', variant !== 'default' && variant, size, hex && 'hex', display && 'display', block && 'block', className].filter(Boolean).join(' ');
  const reduceMotion = useReducedMotion();
  return (
    <motion.button className={cls} {...(reduceMotion ? {} : pressable)} {...rest}>
      {Icon && <Icon size={size === 'sm' ? 14 : 17} />}
      {children}
      {chevron && <ChevronsRight size={20} className="chev" />}
    </motion.button>
  );
}

/* ---------- HudInput ---------- */

export function HudInput({ label, icon: Icon, trailing, className = '', ...rest }: {
  label?: string; icon?: LucideIcon; trailing?: ReactNode;
} & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <div className={`field ${className}`}>
      {label && <label htmlFor={id}>{Icon && <Icon size={14} />} {label}</label>}
      <div className="input">
        {Icon && <Icon size={19} />}
        {Icon && <span className="sep" />}
        <input id={id} {...rest} />
        {trailing}
      </div>
    </div>
  );
}

/* ---------- CommandInput (ask AURA) ---------- */

export function CommandInput({ value, onChange, onSubmit, placeholder = 'Ask AURA anything...', onVoice, busy }: {
  value: string; onChange: (v: string) => void; onSubmit: (v: string) => void; placeholder?: string; onVoice?: () => void; busy?: boolean;
}) {
  const submit = (e: FormEvent) => { e.preventDefault(); if (value.trim()) onSubmit(value); };
  return (
    <form className="input" onSubmit={submit} style={{ height: 52 }}>
      <input placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} aria-label={placeholder} />
      {onVoice && <button type="button" onClick={onVoice} aria-label="Voice input"><Mic size={18} /></button>}
      <button aria-label="Send" disabled={busy}>{busy ? <span className="spinner" /> : <Send size={18} className="c-cyan" />}</button>
    </form>
  );
}

/* ---------- NeonTabs ---------- */

export function NeonTabs<T extends string>({ tabs, value, onChange, stretch, wrap, counts, icons }: {
  tabs: readonly T[]; value: T; onChange: (t: T) => void; stretch?: boolean; /** Wrap onto several lines instead of scrolling sideways, so no tab is ever hidden. */ wrap?: boolean; counts?: Partial<Record<T, number>>; icons?: Partial<Record<T, LucideIcon>>;
}) {
  return (
    <div className={`tabs ${wrap ? "wrap" : ""}`} role="tablist">
      {tabs.map((t) => {
        const I = icons?.[t] as LucideIcon | undefined;
        return (
          <button key={t} role="tab" aria-selected={value === t} className={`chip ${value === t ? 'active' : ''}`} style={stretch ? { flex: 1, justifyContent: 'center' } : undefined} onClick={() => onChange(t)}>
            {I && <I size={15} />} {t}
            {counts?.[t] !== undefined && <span className="tag blue" style={{ marginLeft: 4 }}>{counts[t]}</span>}
          </button>
        );
      })}
    </div>
  );
}

/* ---------- Status ---------- */

export type StatusKind = 'online' | 'active' | 'processing' | 'analyzing' | 'completed' | 'warning' | 'error' | 'offline' | 'idle' | 'standby' | 'learning';

const dotFor: Record<StatusKind, string> = {
  online: '', active: '', completed: '', processing: 'cyan', analyzing: 'amber', warning: 'amber', standby: 'amber',
  error: 'red', offline: 'off', idle: 'off', learning: 'violet',
};

export function StatusBadge({ status, label, pulse }: { status: StatusKind; label?: string; pulse?: boolean }) {
  const live = pulse ?? (status === 'processing' || status === 'analyzing' || status === 'active' || status === 'online');
  return (
    <span className={`status-badge ${status}`} role="status">
      <span className={`dot ${dotFor[status]} ${live ? 'pulse' : ''}`} aria-hidden />
      {label ?? status}
    </span>
  );
}

/* ---------- Misc ---------- */

export function GlowDivider() {
  return <hr className="glow-divider" />;
}

export function SectionHeader({ title, sub, icon: Icon, action, onAction }: { title: ReactNode; sub?: ReactNode; icon?: LucideIcon; action?: ReactNode; onAction?: () => void }) {
  return (
    <div className="hud-head">
      <div style={{ minWidth: 0 }}>
        <h3>{Icon && <Icon size={18} />}{title}</h3>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {action && <button className="link" onClick={onAction}>{action} ›</button>}
    </div>
  );
}

export function FuturisticModal({ title, icon: Icon, onClose, children, tone }: { title: string; icon?: LucideIcon; onClose: () => void; children: ReactNode; tone?: 'amber' | 'violet' }) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div className="modal-back" onClick={onClose} variants={backdropFade} initial={reduceMotion ? false : 'hidden'} animate="show">
      <motion.div
        className={`hud corners modal ${tone ? `glow-${tone}` : ''}`}
        role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}
        variants={modalPop} initial={reduceMotion ? false : 'hidden'} animate="show"
      >
        <div className="hud-head">
          <h3>{Icon && <Icon size={18} />}{title}</h3>
          <button className="icon-btn" style={{ marginLeft: 'auto', width: 34, height: 34 }} onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        {children}
      </motion.div>
    </motion.div>
  );
}

export function VoiceVisualizer({ active, size = 170, label }: { active: boolean; size?: number; label?: string }) {
  const reduceMotion = useReducedMotion();
  return (
    <div className="stack" style={{ alignItems: 'center', gap: 10 }}>
      <motion.div
        style={{ width: size, height: size, borderRadius: '50%', display: 'grid', placeItems: 'center', border: '2px solid var(--aura-border-hi)', boxShadow: '0 0 24px rgba(0,175,255,0.45), inset 0 0 30px rgba(0,175,255,0.25)', background: 'radial-gradient(circle, rgba(0,140,255,0.2), transparent 70%)' }}
        animate={active && !reduceMotion ? { scale: [1, 1.035, 1], boxShadow: ['0 0 24px rgba(0,175,255,0.45), inset 0 0 30px rgba(0,175,255,0.25)', '0 0 40px rgba(0,217,255,0.7), inset 0 0 40px rgba(0,217,255,0.4)', '0 0 24px rgba(0,175,255,0.45), inset 0 0 30px rgba(0,175,255,0.25)'] } : { scale: 1 }}
        transition={{ duration: 1.8, repeat: active && !reduceMotion ? Infinity : 0, ease: 'easeInOut' }}
      >
        <div style={{ width: size - 26, height: size - 26, borderRadius: '50%', border: '1px dashed rgba(25,230,255,0.45)', display: 'grid', placeItems: 'center' }}>
          <Wave bars={20} idle={!active} />
        </div>
      </motion.div>
      {label && <span className="c-cyan" style={{ fontSize: 17 }}>{label}</span>}
    </div>
  );
}
