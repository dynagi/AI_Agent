import { useEffect, useState, type ReactNode, type CSSProperties } from 'react';
import type { LucideIcon } from 'lucide-react';
import { ChevronRight } from 'lucide-react';
import { motion, useReducedMotion, AnimatePresence } from 'framer-motion';
import { revealUp, staggerContainer, staggerItem, toastMotion } from '../motion';

export type Tone = 'cyan' | 'blue' | 'violet' | 'magenta' | 'teal' | 'green' | 'amber' | 'red' | 'pink';

export const toneHex: Record<Tone, string> = {
  cyan: '#19E6FF',
  blue: '#00AFFF',
  violet: '#8B5CFF',
  magenta: '#FF4FD8',
  teal: '#00E5A8',
  green: '#00E5A8',
  amber: '#FFC857',
  red: '#FF4F6D',
  pink: '#FF4FD8',
};

/* ---------- Layout primitives ---------- */

interface HudProps {
  title?: ReactNode;
  sub?: ReactNode;
  icon?: LucideIcon;
  action?: ReactNode;
  onAction?: () => void;
  corners?: boolean;
  glow?: 'cyan' | 'violet' | 'amber';
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

export function Hud({ title, sub, icon: Icon, action, onAction, corners, glow, className = '', style, children }: HudProps) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.section
      className={`hud ${corners ? 'corners' : ''} ${glow ? `glow-${glow}` : ''} ${className}`}
      style={style}
      variants={revealUp}
      initial={reduceMotion ? false : 'hidden'}
      whileInView="show"
      viewport={{ once: true, margin: '-60px' }}
    >
      {(title || action) && (
        <div className="hud-head">
          <div style={{ minWidth: 0 }}>
            {title && (
              <h3>
                {Icon && <Icon size={18} />}
                {title}
              </h3>
            )}
            {sub && <div className="sub">{sub}</div>}
          </div>
          {action && (
            <button className="link" onClick={onAction}>
              {action} <ChevronRight size={14} />
            </button>
          )}
        </div>
      )}
      {children}
    </motion.section>
  );
}

export function IconBox({ icon: Icon, tone = 'cyan', size = 'md', round }: { icon: LucideIcon; tone?: Tone; size?: 'sm' | 'md' | 'lg'; round?: boolean }) {
  const px = size === 'sm' ? 16 : size === 'lg' ? 26 : 20;
  return (
    <span className={`icon-box ${size !== 'md' ? size : ''} ${round ? 'round' : ''} c-${tone}`}>
      <Icon size={px} />
    </span>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`toggle ${on ? 'on' : ''}`} onClick={() => onChange(!on)} />;
}

export function Bar({ value, tone = 'cyan', gradient }: { value: number; tone?: Tone; gradient?: string }) {
  return (
    <div className="bar">
      <i style={{ width: `${Math.min(100, Math.max(0, value))}%`, background: gradient ?? toneHex[tone], color: toneHex[tone] }} />
    </div>
  );
}

export function Dot({ tone = 'green', pulse }: { tone?: 'green' | 'amber' | 'cyan' | 'violet' | 'off'; pulse?: boolean }) {
  return <span className={`dot ${tone !== 'green' ? tone : ''} ${pulse ? 'pulse' : ''}`} />;
}

export function Wave({ bars = 28, idle, color }: { bars?: number; idle?: boolean; color?: string }) {
  return (
    <div className={`wave ${idle ? 'idle' : ''}`} aria-hidden>
      {Array.from({ length: bars }, (_, i) => {
        const h = 20 + Math.abs(Math.sin(i * 0.9)) * 80;
        return <i key={i} style={{ height: `${h}%`, animationDelay: `${(i % 7) * 0.09}s`, background: color, boxShadow: color ? `0 0 6px ${color}` : undefined }} />;
      })}
    </div>
  );
}

/* ---------- Charts (inline SVG, no deps) ---------- */

export function Ring({ value, size = 110, stroke = 10, label, sub, tone = 'cyan' }: { value: number; size?: number; stroke?: number; label?: ReactNode; sub?: ReactNode; tone?: Tone }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(148,163,184,0.15)" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={toneHex[tone]} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - value / 100)}
          style={{ filter: `drop-shadow(0 0 6px ${toneHex[tone]})`, transition: 'stroke-dashoffset 0.8s' }}
        />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center' }}>
        <div>
          <div style={{ fontSize: size * 0.2, fontWeight: 700 }}>{label ?? `${value}%`}</div>
          {sub && <div className="t-sub" style={{ fontSize: 11 }}>{sub}</div>}
        </div>
      </div>
    </div>
  );
}

export interface Slice { label: string; value: number; color: string }

export function Donut({ data, size = 160, stroke = 22, center, sub }: { data: Slice[]; size?: number; stroke?: number; center?: ReactNode; sub?: ReactNode }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  let acc = 0;
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        {data.map((d) => {
          const len = (d.value / total) * c;
          const el = (
            <circle
              key={d.label} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={d.color} strokeWidth={stroke}
              strokeDasharray={`${Math.max(0, len - 2)} ${c}`} strokeDashoffset={-acc}
              style={{ filter: `drop-shadow(0 0 4px ${d.color}88)` }}
            />
          );
          acc += len;
          return el;
        })}
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center' }}>
        <div>
          <div style={{ fontSize: size * 0.14, fontWeight: 700 }}>{center}</div>
          {sub && <div className="t-sub">{sub}</div>}
        </div>
      </div>
    </div>
  );
}

export function Legend({ data, unit = '%' }: { data: Slice[]; unit?: string }) {
  return (
    <div className="legend" style={{ flex: 1, minWidth: 0 }}>
      {data.map((d) => (
        <div className="legend-row" key={d.label}>
          <span className="sw" style={{ background: d.color, boxShadow: `0 0 6px ${d.color}` }} />
          <span className="ellipsis">{d.label}</span>
          <span className="v">{d.value}{unit}</span>
        </div>
      ))}
    </div>
  );
}

export function BarChart({ values, labels, height = 180, colors, max, showValues, prefix = '' }: { values: number[]; labels: string[]; height?: number; colors?: string[]; max?: number; showValues?: boolean; prefix?: string }) {
  const W = 520;
  const top = showValues ? 18 : 6;
  const bottom = 22;
  const m = max ?? Math.max(...values) * 1.1;
  const slot = W / values.length;
  const bw = Math.min(34, slot * 0.55);
  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="chart-svg" role="img">
      <defs>
        <linearGradient id="bargrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8B5CF6" />
          <stop offset="1" stopColor="#3B82FF" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <line key={f} x1="0" x2={W} y1={top + (height - top - bottom) * (1 - f)} y2={top + (height - top - bottom) * (1 - f)} stroke="rgba(0,229,255,0.07)" />
      ))}
      {values.map((v, i) => {
        const h = ((height - top - bottom) * v) / m;
        const x = slot * i + (slot - bw) / 2;
        const y = height - bottom - h;
        const fill = colors?.[i % colors.length] ?? 'url(#bargrad)';
        return (
          <g key={i}>
            <rect x={x} y={y} width={bw} height={h} rx="4" fill={fill} style={{ filter: 'drop-shadow(0 0 5px rgba(59,130,255,0.5))' }} />
            {showValues && <text x={x + bw / 2} y={y - 5} textAnchor="middle" style={{ fill: '#fff' }}>{prefix}{v}</text>}
            <text x={x + bw / 2} y={height - 5} textAnchor="middle">{labels[i]}</text>
          </g>
        );
      })}
    </svg>
  );
}

export function LineChart({ values, labels, height = 180 }: { values: number[]; labels: string[]; height?: number }) {
  const W = 520;
  const pad = { l: 24, r: 8, t: 10, b: 22 };
  const m = Math.max(...values) * 1.1;
  const pts = values.map((v, i) => [pad.l + ((W - pad.l - pad.r) * i) / (values.length - 1), pad.t + (height - pad.t - pad.b) * (1 - v / m)] as const);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${d} L${pts[pts.length - 1][0]},${height - pad.b} L${pts[0][0]},${height - pad.b} Z`;
  const step = Math.ceil(values.length / labels.length);
  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="chart-svg" role="img">
      <defs>
        <linearGradient id="linefill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3B82FF" stopOpacity="0.45" />
          <stop offset="1" stopColor="#3B82FF" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <line key={f} x1={pad.l} x2={W} y1={pad.t + (height - pad.t - pad.b) * (1 - f)} y2={pad.t + (height - pad.t - pad.b) * (1 - f)} stroke="rgba(0,229,255,0.07)" />
      ))}
      <path d={area} fill="url(#linefill)" />
      <path d={d} fill="none" stroke="#3B82FF" strokeWidth="2.5" style={{ filter: 'drop-shadow(0 0 6px #3B82FF)' }} />
      {pts.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r="3" fill="#7dd3fc" />)}
      {labels.map((l, i) => (
        <text key={l} x={pts[Math.min(i * step, pts.length - 1)][0]} y={height - 5} textAnchor={i === labels.length - 1 ? 'end' : i === 0 ? 'start' : 'middle'}>{l}</text>
      ))}
    </svg>
  );
}

/* ---------- AI avatar (reference art + orbital HUD rings) ---------- */

export type AuraState = 'idle' | 'listening' | 'thinking' | 'analyzing' | 'speaking' | 'executing' | 'success' | 'warning' | 'error' | 'offline';

export type AvatarArt = 'android' | 'core' | 'voice' | 'onboard' | 'signup' | 'login' | 'decision' | 'travel' | 'tasks' | 'integrations' | 'analytics' | 'face';

export const artSrc: Record<AvatarArt, string> = {
  android: '/aura/dash-android.jpg',
  core: '/aura/core-helmet.jpg',
  voice: '/aura/voice-android.jpg',
  onboard: '/aura/onboard-android.jpg',
  signup: '/aura/signup-android.jpg',
  login: '/aura/login-android.jpg',
  decision: '/aura/decision-android.jpg',
  travel: '/aura/travel-android.jpg',
  tasks: '/aura/tasks-android.jpg',
  integrations: '/aura/integrations-android.jpg',
  analytics: '/aura/analytics-android.jpg',
  face: '/aura/chat-face.jpg',
};

const stateColor: Record<AuraState, string> = {
  idle: '#19E6FF', listening: '#19E6FF', thinking: '#8B5CFF', analyzing: '#00AFFF', speaking: '#00E5A8',
  executing: '#00AFFF', success: '#00E5A8', warning: '#FFC857', error: '#FF4F6D', offline: '#6683A3',
};

/** Reusable AURA entity. `art` picks the reference render; `rings` adds the orbital HUD. */
export function AuraAvatar({ size = 220, state = 'idle', float = true, art = 'android', rings = true, square = false, height }: {
  size?: number; state?: AuraState; float?: boolean; art?: AvatarArt; rings?: boolean; square?: boolean; height?: number;
}) {
  const c = stateColor[state];
  return (
    <div className={`ai-avatar state-${state} ${float ? 'float' : ''} ${square ? 'square' : ''}`} style={{ width: size, height: height ?? size }} role="img" aria-label={`AURA is ${state}`}>
      <img src={artSrc[art]} alt="" loading="lazy" draggable={false} />
      {rings && (
        <svg className="orbit" viewBox="0 0 200 200" aria-hidden>
          <circle className="spin" cx="100" cy="100" r="97" fill="none" stroke={c} strokeOpacity="0.75" strokeWidth="1.2" strokeDasharray="46 12 6 12 90 20" />
          <circle className="spin rev" cx="100" cy="100" r="91" fill="none" stroke={c} strokeOpacity="0.35" strokeWidth="2.5" strokeDasharray="1.5 6" />
          <circle cx="100" cy="100" r="99.5" fill="none" stroke={c} strokeOpacity="0.15" strokeWidth="1" />
        </svg>
      )}
    </div>
  );
}

/* ---------- Page hero ---------- */

export interface HeroFeat { icon: LucideIcon; title: string; sub: string; tone?: Tone }

/**
 * Module banner used across AURA pages. `title` can be a string (with optional gradient `accent`)
 * or a node for two-line titles; `image` is the right-hand artwork (faded into the panel).
 */
export function PageHero({ title, accent, lead, quote, feats, art = 'integrations', image, right, imageWidth = '42%', children }: {
  title: ReactNode;
  accent?: string;
  lead?: ReactNode;
  quote?: ReactNode;
  feats?: HeroFeat[];
  art?: AvatarArt | false;
  image?: string;
  right?: ReactNode;
  imageWidth?: string;
  children?: ReactNode;
}) {
  const src = image ?? (art ? artSrc[art] : undefined);
  const reduceMotion = useReducedMotion();
  return (
    <motion.section
      className="hero"
      aria-label={typeof title === 'string' ? title : undefined}
      variants={staggerContainer}
      initial={reduceMotion ? false : 'hidden'}
      animate="show"
    >
      {src && (
        <motion.img
          className="hero-bg"
          src={src}
          alt=""
          loading="lazy"
          style={{ width: imageWidth }}
          initial={reduceMotion ? false : { opacity: 0, scale: 1.08 }}
          animate={reduceMotion ? undefined : { opacity: 1, scale: [1.08, 1, 1.035, 1] }}
          transition={reduceMotion ? undefined : { opacity: { duration: 0.6 }, scale: { duration: 14, ease: 'easeInOut', repeat: Infinity, repeatType: 'mirror' } }}
        />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <motion.h1 variants={staggerItem}>
          {title} {accent && <span className="grad">{accent}</span>}
        </motion.h1>
        {lead && <motion.p className="lead" variants={staggerItem}>{lead}</motion.p>}
        {feats && (
          <motion.div className="hero-feats" variants={staggerItem}>
            {feats.map((f) => (
              <div className="hero-feat" key={f.title}>
                <IconBox icon={f.icon} tone={f.tone ?? 'blue'} size="sm" round />
                <div>
                  {f.title}
                  <small>{f.sub}</small>
                </div>
              </div>
            ))}
          </motion.div>
        )}
        {children && <motion.div variants={staggerItem}>{children}</motion.div>}
      </div>
      {quote && (
        <motion.div className="hero-quote hide-sm" variants={staggerItem} style={{ maxWidth: 250, marginRight: src ? `calc(${imageWidth} - 8%)` : 0 }}>
          “{quote}”<small>— AURA</small>
        </motion.div>
      )}
      {right}
    </motion.section>
  );
}

/* ---------- Toast ---------- */

let pushToast: ((msg: string) => void) | null = null;
export const toast = (msg: string) => pushToast?.(msg);

export function ToastHost() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    pushToast = (m) => setMsg(m);
    return () => { pushToast = null; };
  }, []);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 2800);
    return () => clearTimeout(t);
  }, [msg]);
  return (
    <AnimatePresence>
      {msg && (
        <motion.div className="toast" role="status" variants={toastMotion} initial="hidden" animate="show" exit="exit">
          <Dot tone="cyan" pulse /> {msg}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ---------- States ---------- */

export function EmptyState({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}
