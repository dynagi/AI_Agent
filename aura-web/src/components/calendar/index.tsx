import { useMemo, useState, type FormEvent } from 'react';
import { CalendarPlus, Pencil, Trash2, CalendarDays, Clock } from 'lucide-react';
import { toneHex } from '../ui';
import { FuturisticModal, NeonButton, HudInput } from '../aura';
import { kindMeta, titleIcon, todayISO, type CalendarEvent, type EventKind } from '../../data/events';

export const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const toISO = (y: number, m: number, d: number) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

export interface Cell { y: number; m: number; d: number; iso: string; cur: boolean }
export function monthCells(y: number, m: number): Cell[] {
  const first = new Date(y, m, 1).getDay();
  const out: Cell[] = [];
  for (let i = -first; out.length < 42; i++) {
    const dt = new Date(y, m, 1 + i);
    out.push({ y: dt.getFullYear(), m: dt.getMonth(), d: dt.getDate(), iso: toISO(dt.getFullYear(), dt.getMonth(), dt.getDate()), cur: dt.getMonth() === m });
  }
  // trim trailing week if entirely outside month
  return out.slice(35).every((c) => !c.cur) ? out.slice(0, 35) : out;
}

export function EventChip({ ev, onClick }: { ev: CalendarEvent; onClick: () => void }) {
  const meta = kindMeta[ev.kind];
  const Icon = titleIcon[ev.title] ?? meta.icon;
  const c = toneHex[meta.tone];
  return (
    <button className="cal-evt" onClick={(e) => { e.stopPropagation(); onClick(); }} style={{ borderColor: `${c}88`, background: `linear-gradient(90deg, ${c}40, ${c}18)` }} aria-label={`${ev.title}, ${ev.start}`}>
      <Icon size={18} style={{ color: c, flexShrink: 0 }} />
      <span style={{ minWidth: 0 }}><b className="ellipsis">{ev.title}</b><small>{ev.start}</small></span>
    </button>
  );
}

/** Month grid (ref 18). Click a day to add, click an event to open it. */
export function CalendarGrid({ y, m, events, selected, today, onSelectDay, onOpenEvent }: {
  y: number; m: number; events: CalendarEvent[]; selected: string; today: string; onSelectDay: (iso: string) => void; onOpenEvent: (e: CalendarEvent) => void;
}) {
  const cells = useMemo(() => monthCells(y, m), [y, m]);
  return (
    <div className="hud" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="cal-grid" role="grid" aria-label="Month view">
        {DOW.map((d) => <div key={d} className="dow" role="columnheader">{d}</div>)}
        {cells.map((c) => {
          const evs = events.filter((e) => e.date === c.iso);
          return (
            <div key={c.iso} role="gridcell" tabIndex={0} aria-selected={c.iso === selected}
              className={`cal-cell ${c.cur ? '' : 'out'} ${c.iso === today ? 'today' : ''}`}
              style={c.iso === selected && c.iso !== today ? { background: 'rgba(0,175,255,0.08)' } : undefined}
              onClick={() => onSelectDay(c.iso)} onKeyDown={(e) => e.key === 'Enter' && onSelectDay(c.iso)}>
              <span className="num">{c.d}</span>
              {evs.slice(0, 2).map((e) => <EventChip key={e.id} ev={e} onClick={() => onOpenEvent(e)} />)}
              {evs.length > 2 && <span className="t-mute" style={{ fontSize: 11 }}>+{evs.length - 2} more</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function MiniCalendar({ y, m, selected, events, onSelect, onPrev, onNext }: {
  y: number; m: number; selected: string; events: CalendarEvent[]; onSelect: (iso: string) => void; onPrev: () => void; onNext: () => void;
}) {
  const cells = useMemo(() => monthCells(y, m), [y, m]);
  const label = new Date(y, m, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  return (
    <section className="hud corners" aria-label="Mini calendar">
      <div className="row between" style={{ marginBottom: 12 }}>
        <b style={{ fontSize: 20, fontFamily: 'var(--font-head)' }}>{label}</b>
        <div className="row" style={{ gap: 4 }}>
          <button className="icon-btn bare" style={{ width: 28, height: 28 }} onClick={onPrev} aria-label="Previous month">‹</button>
          <button className="icon-btn bare" style={{ width: 28, height: 28 }} onClick={onNext} aria-label="Next month">›</button>
        </div>
      </div>
      <div className="mini-cal">
        {DOW.map((d) => <span key={d} className="t-sub">{d.slice(0, 2)}</span>)}
        {cells.map((c) => (
          <button key={c.iso} className={`${c.cur ? '' : 'out'} ${c.iso === selected ? 'sel' : ''} ${events.some((e) => e.date === c.iso) ? 'has' : ''}`} onClick={() => onSelect(c.iso)} aria-label={c.iso} aria-pressed={c.iso === selected}>{c.d}</button>
        ))}
      </div>
    </section>
  );
}

/** Event detail / add / edit modal */
export function EventModal({ event, date, preset, onSave, onDelete, onClose }: {
  event?: CalendarEvent; date?: string; preset?: Partial<CalendarEvent>; onSave: (e: Omit<CalendarEvent, 'id'>) => void; onDelete?: () => void; onClose: () => void;
}) {
  const [editing, setEditing] = useState(!event);
  const [f, setF] = useState<Omit<CalendarEvent, 'id'>>(event ?? { title: '', date: date ?? todayISO(), start: '10:00 AM', end: '11:00 AM', kind: 'meeting', ...preset });
  const [err, setErr] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!f.title.trim()) return setErr('Add a title.');
    onSave(f);
  };
  if (event && !editing) {
    const meta = kindMeta[event.kind];
    const Icon = titleIcon[event.title] ?? meta.icon;
    return (
      <FuturisticModal title={event.title} icon={Icon} onClose={onClose}>
        <div className="list">
          <div className="li"><CalendarDays size={16} className="c-cyan" /> {new Date(event.date + 'T00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</div>
          <div className="li"><Clock size={16} className="c-cyan" /> {event.start}{event.end ? ` – ${event.end}` : ''}</div>
          <div className="li"><span className="dot" style={{ background: toneHex[meta.tone], color: toneHex[meta.tone] }} /> {meta.label}</div>
          {event.notes && <div className="li t-sub">{event.notes}</div>}
          {event.source === 'google' && <div className="li t-sub">Synced from Google Calendar (read-only here).</div>}
        </div>
        {event.source !== 'google' && (
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
            <NeonButton variant="danger" icon={Trash2} onClick={onDelete}>Delete</NeonButton>
            <NeonButton variant="primary" icon={Pencil} onClick={() => setEditing(true)}>Edit</NeonButton>
          </div>
        )}
      </FuturisticModal>
    );
  }
  return (
    <FuturisticModal title={event ? 'Edit Event' : 'Add Event'} icon={CalendarPlus} onClose={onClose}>
      <form onSubmit={submit} className="stack" style={{ gap: 12 }}>
        <HudInput label="Title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Event title" autoFocus />
        <div className="form-grid">
          <HudInput label="Date" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          <div className="field"><label htmlFor="ev-kind">Type</label>
            <select id="ev-kind" className="select" style={{ height: 48 }} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as EventKind })}>
              {Object.entries(kindMeta).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </div>
          <HudInput label="Start" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} placeholder="10:00 AM or All Day" />
          <HudInput label="End" value={f.end ?? ''} onChange={(e) => setF({ ...f, end: e.target.value })} placeholder="11:00 AM" />
          <div className="field full"><label htmlFor="ev-notes">Notes</label><textarea id="ev-notes" className="hud-textarea" rows={2} value={f.notes ?? ''} onChange={(e) => setF({ ...f, notes: e.target.value })} /></div>
        </div>
        {err && <div className="tag red" role="alert" style={{ padding: 8 }}>{err}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <NeonButton type="button" onClick={onClose}>Cancel</NeonButton>
          <NeonButton type="submit" variant="primary">{event ? 'Save' : 'Add Event'}</NeonButton>
        </div>
      </form>
    </FuturisticModal>
  );
}
