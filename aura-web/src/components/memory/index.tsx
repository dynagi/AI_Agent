import { Star, CalendarDays, Trash2, RotateCcw, Pencil, Copy, Lightbulb, Image, FileText, Plane, StickyNote, Link2, Video, Mic, File, type LucideIcon } from 'lucide-react';
import { CategoryBadge, IconBox, MoreMenu, type Tone } from '../ui';
import type { Memory, MemoryType } from '../../data/memories';
import { formatWhen } from '../../data/transactions';

export const memoryMeta: Record<MemoryType, { icon: LucideIcon; tone: Tone; tag: Tone }> = {
  Idea: { icon: Lightbulb, tone: 'violet', tag: 'green' }, Image: { icon: Image, tone: 'blue', tag: 'blue' }, Document: { icon: FileText, tone: 'red', tag: 'cyan' },
  Travel: { icon: Plane, tone: 'teal', tag: 'cyan' }, Note: { icon: StickyNote, tone: 'amber', tag: 'amber' }, Link: { icon: Link2, tone: 'violet', tag: 'violet' },
  Video: { icon: Video, tone: 'magenta', tag: 'magenta' }, Voice: { icon: Mic, tone: 'blue', tag: 'blue' }, File: { icon: File, tone: 'violet', tag: 'violet' },
};

export function MemoryCard({ m, onFavorite, onDelete, onRestore, onEdit, onCopy }: {
  m: Memory; onFavorite: () => void; onDelete: () => void; onRestore: () => void; onEdit: () => void; onCopy: () => void;
}) {
  const meta = memoryMeta[m.type];
  const items = m.deleted
    ? [{ label: 'Restore', icon: RotateCcw, onSelect: onRestore }, { label: 'Delete forever', icon: Trash2, danger: true, onSelect: onDelete }]
    : [{ label: 'Edit', icon: Pencil, onSelect: onEdit }, { label: 'Copy text', icon: Copy, onSelect: onCopy }, { label: 'Move to trash', icon: Trash2, danger: true, onSelect: onDelete }];
  return (
    <article className="tile stack" style={{ gap: 7, opacity: m.deleted ? 0.7 : 1 }}>
      <div className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
        {m.image
          ? <span className="media" style={{ width: 66, height: 70, flexShrink: 0 }}><img src={m.image} alt="" /></span>
          : <IconBox icon={meta.icon} tone={meta.tone} size="lg" />}
        <div style={{ minWidth: 0 }}>
          <h4 style={{ margin: 0, fontSize: 14, lineHeight: 1.3 }}>{m.title}</h4>
          {!m.checks && !m.bullets && <p className="t-sub" style={{ margin: '4px 0 0', fontSize: 12, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{m.body}</p>}
          {m.checks && <ul style={{ margin: '4px 0 0', padding: 0, listStyle: 'none', fontSize: 12 }}>{m.checks.map((c) => <li key={c} className="t-sub">✓ {c}</li>)}</ul>}
          {m.bullets && <ul style={{ margin: '4px 0 0', paddingLeft: 14, fontSize: 12 }} className="t-sub">{m.bullets.map((c) => <li key={c}>{c}</li>)}</ul>}
        </div>
      </div>
      <span style={{ alignSelf: 'flex-start' }}><CategoryBadge label={m.type} tone={meta.tag} /></span>
      <div className="row between t-mute" style={{ marginTop: 'auto' }}>
        <span className="row" style={{ gap: 5 }}><CalendarDays size={12} /> {formatWhen(m.ts)}</span>
        <span className="row" style={{ gap: 2 }}>
          {!m.deleted && (
            <button className="icon-btn bare" style={{ width: 26, height: 26, color: 'var(--aura-warning)' }} onClick={onFavorite} aria-pressed={m.favorite} aria-label={m.favorite ? 'Remove from favorites' : 'Add to favorites'}>
              <Star size={15} fill={m.favorite ? 'currentColor' : 'none'} />
            </button>
          )}
          <MoreMenu items={items} label={`Actions for ${m.title}`} />
        </span>
      </div>
    </article>
  );
}
