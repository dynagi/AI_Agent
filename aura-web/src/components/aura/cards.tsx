import type { ReactNode } from 'react';
import { ChevronRight, MoreVertical, TrendingDown, TrendingUp, type LucideIcon } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import { Hud, IconBox, Bar, toneHex, type Tone } from '../ui';
import { StatusBadge, type StatusKind } from './controls';
import { liftable } from '../motion';
import type { Agent } from '../../data/agents';

/* Blue base art → tint per agent tone (hue-rotate from ~210°) */
export const hueFor: Record<Tone, number> = { blue: 0, cyan: -25, teal: -55, green: -55, violet: 55, magenta: 105, pink: 105, amber: 195, red: 150 };

export { Hud as HudPanel };

/* ---------- HudFrame: framed art ---------- */
export function HudFrame({ src, alt = '', width, height, children }: { src?: string; alt?: string; width?: number | string; height?: number | string; children?: ReactNode }) {
  return (
    <div className="hud-frame" style={{ width, height }}>
      {src && <img src={src} alt={alt} loading="lazy" />}
      {children}
    </div>
  );
}

/* ---------- AgentAvatar: robot head tinted to the agent colour ---------- */
export function AgentAvatar({ tone = 'blue', size = 52, ring = true }: { tone?: Tone; size?: number; ring?: boolean }) {
  return (
    <span style={{ width: size, height: size, borderRadius: '50%', overflow: 'hidden', flexShrink: 0, display: 'block', border: ring ? `1.5px solid ${toneHex[tone]}` : 0, boxShadow: ring ? `0 0 12px ${toneHex[tone]}88` : undefined }}>
      <img src="/aura/chat-face.jpg" alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: '50% 25%', filter: `hue-rotate(${hueFor[tone]}deg) saturate(1.2)` }} />
    </span>
  );
}

/* ---------- MetricCard ---------- */
export function MetricCard({ icon, tone = 'cyan', value, label, delta, down, extra, onClick }: {
  icon: LucideIcon; tone?: Tone; value: ReactNode; label: string; delta?: string; down?: boolean; extra?: ReactNode; onClick?: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const body = (
    <>
      <IconBox icon={icon} tone={tone} size="lg" round />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 24, fontWeight: 700, fontFamily: 'var(--font-head)', lineHeight: 1.1 }}>{value}</div>
        <div className="t-sub">{label}</div>
        {extra}
      </div>
      {delta && (
        <div className={down ? 'c-red' : 'c-green'} style={{ fontSize: 13, textAlign: 'right' }}>
          <span className="row" style={{ gap: 3, justifyContent: 'flex-end' }}>{down ? <TrendingDown size={13} /> : <TrendingUp size={13} />} {delta}</span>
          <span className="t-mute">vs. previous</span>
        </div>
      )}
    </>
  );
  return onClick ? (
    <motion.button className="hud row" style={{ textAlign: 'left', gap: 14 }} onClick={onClick} {...(reduceMotion ? {} : liftable)}>{body}</motion.button>
  ) : (
    <div className="hud row" style={{ gap: 14 }}>{body}</div>
  );
}

/* ---------- AgentCard ---------- */
export function AgentCard({ agent, compact, progress, onClick, selected }: { agent: Agent; compact?: boolean; progress?: number; onClick?: () => void; selected?: boolean }) {
  const status = agent.status as StatusKind;
  const reduceMotion = useReducedMotion();
  if (compact) {
    return (
      <motion.button className="li" onClick={onClick} style={{ background: 'none', border: 0, width: '100%', textAlign: 'left' }} {...(reduceMotion ? {} : liftable)}>
        <IconBox icon={agent.icon} tone={agent.tone} size="sm" />
        <div className="grow"><div className="t-title">{agent.name}</div><div className="t-sub ellipsis">{agent.task}</div></div>
        <StatusBadge status={status} label="" />
        <MoreVertical size={15} className="t-mute" />
      </motion.button>
    );
  }
  return (
    <motion.button className="tile row" onClick={onClick} style={{ textAlign: 'left', gap: 12, ['--bd' as string]: selected ? toneHex[agent.tone] : undefined, width: '100%' }} {...(reduceMotion ? {} : liftable)}>
      <IconBox icon={agent.icon} tone={agent.tone} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="t-title">{agent.name}</div>
        <StatusBadge status={status} />
        <div className="t-sub ellipsis">{agent.task}</div>
        {progress !== undefined && <div style={{ marginTop: 6 }}><Bar value={progress} tone={agent.tone} /></div>}
      </div>
      <AgentAvatar tone={agent.tone} size={46} />
    </motion.button>
  );
}

/* ---------- InsightCard ---------- */
export function InsightCard({ icon, tone = 'cyan', title, body, onClick }: { icon: LucideIcon; tone?: Tone; title: string; body: string; onClick?: () => void }) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.button className="tile row" onClick={onClick} style={{ textAlign: 'left', width: '100%', gap: 14, padding: 14, ['--bd' as string]: `${toneHex[tone]}88` }} {...(reduceMotion ? {} : liftable)}>
      <IconBox icon={icon} tone={tone} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="t-title">{title}</div>
        <div className="t-sub">{body}</div>
      </div>
      <span className="icon-btn" style={{ width: 30, height: 30 }} aria-hidden><ChevronRight size={16} /></span>
    </motion.button>
  );
}

/* ---------- ActionCard (quick action tile) ---------- */
export function ActionCard({ icon, label, tone = 'blue', onClick }: { icon: LucideIcon; label: string; tone?: Tone; onClick?: () => void }) {
  return (
    <button className="stack" onClick={onClick} style={{ background: 'none', border: 0, alignItems: 'center', gap: 7, textAlign: 'center', padding: 2 }}>
      <IconBox icon={icon} tone={tone} size="lg" />
      <span style={{ fontSize: 12, color: 'var(--aura-text)' }}>{label}</span>
    </button>
  );
}

/* ---------- ChatMessage ---------- */
const messageMotion = {
  initial: { opacity: 0, y: 14, scale: 0.985 },
  animate: { opacity: 1, y: 0, scale: 1 },
  transition: { type: 'spring' as const, stiffness: 380, damping: 32, mass: 0.7 },
};

export function ChatMessage({ role, time, children, wide }: { role: 'aura' | 'user'; time?: string; children: ReactNode; wide?: boolean }) {
  const reduceMotion = useReducedMotion();
  const motionProps = reduceMotion ? {} : messageMotion;
  if (role === 'user') {
    return (
      <motion.div className="row" style={{ justifyContent: 'flex-end', alignItems: 'flex-start' }} {...motionProps}>
        <div style={{ maxWidth: 560 }}>
          <div className="tile" style={{ padding: '14px 18px', fontSize: 15, ['--bd' as string]: 'var(--aura-primary-bright)', ['--fill' as string]: 'linear-gradient(90deg, rgba(0,90,200,0.55), rgba(0,120,230,0.35))', filter: 'drop-shadow(0 0 10px rgba(0,175,255,0.45))' }}>{children}</div>
          {time && <div className="t-mute" style={{ textAlign: 'right', marginTop: 4 }}>{time}</div>}
        </div>
        <div className="avatar hide-sm">S</div>
      </motion.div>
    );
  }
  return (
    <motion.div className="row" style={{ alignItems: 'flex-start', gap: 14 }} {...motionProps}>
      <div className="hud-frame chat-face hide-sm"><img src="/aura/chat-face.jpg" alt="" /></div>
      <div style={{ flex: 1, minWidth: 0, maxWidth: wide ? undefined : 780 }}>
        {children}
        {time && <div className="t-mute" style={{ marginTop: 5 }}>{time}</div>}
      </div>
    </motion.div>
  );
}

/* ---------- ChartCard ---------- */
export function ChartCard({ title, icon, action, children }: { title: string; icon?: LucideIcon; action?: ReactNode; children: ReactNode }) {
  return <Hud title={title} icon={icon} action={action}>{children}</Hud>;
}
