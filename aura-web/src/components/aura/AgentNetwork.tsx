import type { Agent } from '../../data/agents';
import { IconBox, toneHex } from '../ui';
import { AgentAvatar } from './cards';
import './agent-network.css';

/**
 * AURA CORE in the centre, agents on an orbit, glowing links and data packets.
 * HTML node cards over an SVG link layer; collapses to a grid on narrow screens.
 */
export default function AgentNetwork({ agents, selected, onSelect, coreLabel = 'Coordinates agents in real-time' }: {
  agents: Agent[];
  selected?: string;
  onSelect?: (id: string) => void;
  coreLabel?: string;
}) {
  const nodes = agents.map((a, i) => {
    const ang = (i / agents.length) * Math.PI * 2 - Math.PI / 2;
    return { a, x: 50 + Math.cos(ang) * 37, y: 50 + Math.sin(ang) * 39 };
  });

  return (
    <div className="agent-net">
      <div className="net-stage">
        <svg className="net-links" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
          {[26, 36, 46].map((r) => (
            <ellipse key={r} cx="50" cy="50" rx={r} ry={r * 1.05} fill="none" stroke="rgba(0,175,255,0.14)" strokeDasharray="0.6 1.4" vectorEffect="non-scaling-stroke" />
          ))}
          {nodes.map((n, i) => {
            const m = nodes[(i + 3) % nodes.length];
            return <line key={`m${i}`} x1={n.x} y1={n.y} x2={m.x} y2={m.y} stroke="rgba(139,92,255,0.16)" vectorEffect="non-scaling-stroke" />;
          })}
          {nodes.map((n, i) => {
            const c = toneHex[n.a.tone];
            const d = `M50,50 L${n.x},${n.y}`;
            const live = n.a.status === 'active' || n.a.status === 'analyzing' || n.a.status === 'learning';
            return (
              <g key={n.a.id}>
                <path d={d} stroke={c} strokeOpacity={selected === n.a.id ? 1 : 0.55} strokeWidth={selected === n.a.id ? 2.4 : 1.3} fill="none" vectorEffect="non-scaling-stroke" className="net-link" />
                {live && (
                  <circle r="0.7" fill={c} className="net-packet">
                    <animateMotion dur={`${2.2 + (i % 4) * 0.45}s`} repeatCount="indefinite" path={i % 2 ? d : `M${n.x},${n.y} L50,50`} />
                  </circle>
                )}
              </g>
            );
          })}
        </svg>

        <div className="net-core" aria-label="AURA Core">
          <span className="core-ring r1" /><span className="core-ring r2" /><span className="core-ring r3" />
          <div className="core-orb">
            <svg viewBox="0 0 40 30" width="38%" aria-hidden><path d="M4 27 L20 3 L36 27" fill="none" stroke="#fff" strokeWidth="5" strokeLinejoin="round" /></svg>
            <b>AURA CORE</b>
            <small>{coreLabel}</small>
          </div>
        </div>

        {nodes.map((n) => {
          const c = toneHex[n.a.tone];
          return (
            <button
              key={n.a.id}
              className={`net-node ${selected === n.a.id ? 'sel' : ''}`}
              style={{ left: `${n.x}%`, top: `${n.y}%`, ['--tone' as string]: c }}
              onClick={() => onSelect?.(n.a.id)}
              aria-pressed={selected === n.a.id}
            >
              <IconBox icon={n.a.icon} tone={n.a.tone} size="sm" />
              <span className="net-text">
                <b>{n.a.name}</b>
                <span className="net-status"><i style={{ background: c }} /> {n.a.status}</span>
                <span className="net-desc">{n.a.task}</span>
              </span>
              <AgentAvatar tone={n.a.tone} size={40} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
