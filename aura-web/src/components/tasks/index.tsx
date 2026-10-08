import { useState, type FormEvent } from 'react';
import { CalendarDays, Flag, Pencil, Trash2, Copy, CalendarPlus, SquarePen } from 'lucide-react';
import { CategoryBadge, MoreMenu } from '../ui';
import { FuturisticModal, NeonButton, HudInput } from '../aura';
import { allCategories, categoryTone, priorityTone, type Priority, type TaskItem } from '../../data/tasks';

export function formatTaskWhen(t: TaskItem) {
  return t.start ? (t.end ? `${t.start} – ${t.end}` : t.start) : 'Anytime';
}

/** TaskCard — list row (ref 19). `grid` renders a compact card instead. */
export function TaskCard({ task, grid, onToggle, onFlag, onEdit, onDelete, onDuplicate }: {
  task: TaskItem; grid?: boolean; onToggle: () => void; onFlag: () => void; onEdit: () => void; onDelete: () => void; onDuplicate: () => void;
}) {
  const menu = [
    { label: 'Edit task', icon: Pencil, onSelect: onEdit },
    { label: 'Duplicate', icon: Copy, onSelect: onDuplicate },
    { label: 'Delete', icon: Trash2, danger: true, onSelect: onDelete },
  ];
  const tags = (
    <span className="row wrap t-cats" style={{ gap: 6 }}>
      {task.categories.map((c) => <CategoryBadge key={c} label={c} tone={categoryTone[c] ?? 'blue'} />)}
      {task.priority !== 'Low' && task.categories.length < 2 && <CategoryBadge label={task.priority} tone={priorityTone[task.priority]} />}
    </span>
  );
  const flag = (
    <button className="icon-btn bare" style={{ width: 28, height: 28 }} onClick={onFlag} aria-pressed={task.flagged} aria-label={task.flagged ? 'Unflag task' : 'Flag task'}>
      <Flag size={17} style={{ color: task.flagged ? 'var(--aura-danger)' : task.priority === 'Low' && task.day === 'tomorrow' ? 'var(--aura-warning)' : 'var(--aura-text-2)' }} fill={task.flagged ? 'currentColor' : 'none'} />
    </button>
  );
  if (grid) {
    return (
      <div className="tile trow-card">
        <div className="row"><input type="checkbox" className="check" checked={task.done} onChange={onToggle} aria-label={`Complete ${task.title}`} /><span className={`t-title ${task.done ? 'done' : ''}`} style={{ flex: 1 }}>{task.title}</span><MoreMenu items={menu} /></div>
        {tags}
        <div className="row between"><span className="row t-sub"><CalendarDays size={14} /> {formatTaskWhen(task)}</span>{flag}</div>
      </div>
    );
  }
  return (
    <div className="trow" role="listitem">
      <input type="checkbox" className="check" checked={task.done} onChange={onToggle} aria-label={`Complete ${task.title}`} />
      <button onClick={onEdit} style={{ background: 'none', border: 0, padding: 0, textAlign: 'left', minWidth: 0 }}><span className={`t-title ellipsis ${task.done ? 'done' : ''}`} style={{ display: 'block' }}>{task.title}</span></button>
      {tags}
      <span className="row t-sub t-when" style={{ fontSize: 13.5 }}><CalendarDays size={16} /> {formatTaskWhen(task)}</span>
      {flag}
      <MoreMenu items={menu} label={`Actions for ${task.title}`} />
    </div>
  );
}

/** Add / edit task modal */
export function TaskEditor({ task, onSave, onClose }: { task?: TaskItem; onSave: (t: Omit<TaskItem, 'id'>) => void; onClose: () => void }) {
  const [f, setF] = useState<Omit<TaskItem, 'id'>>(task ?? {
    title: '', categories: ['Work'], priority: 'Medium', day: 'today', date: new Date().toISOString().slice(0, 10), start: '', end: '', flagged: false, done: false,
  });
  const [err, setErr] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!f.title.trim()) return setErr('Give the task a title.');
    onSave(f);
  };
  const toggleCat = (c: string) => setF((s) => ({ ...s, categories: s.categories.includes(c) ? s.categories.filter((x) => x !== c) : [...s.categories, c] }));
  return (
    <FuturisticModal title={task ? 'Edit Task' : 'New Task'} icon={task ? SquarePen : CalendarPlus} onClose={onClose}>
      <form onSubmit={submit} className="stack" style={{ gap: 12 }}>
        <HudInput label="Title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="What needs doing?" autoFocus />
        <div className="form-grid">
          <HudInput label="Date" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          <div className="field"><label htmlFor="tk-day">Section</label>
            <select id="tk-day" className="select" style={{ height: 48 }} value={f.day} onChange={(e) => setF({ ...f, day: e.target.value as TaskItem['day'] })}><option value="today">Today</option><option value="tomorrow">Tomorrow</option><option value="later">Upcoming</option></select>
          </div>
          <HudInput label="Start" value={f.start ?? ''} onChange={(e) => setF({ ...f, start: e.target.value })} placeholder="e.g. 10:00 AM" />
          <HudInput label="End" value={f.end ?? ''} onChange={(e) => setF({ ...f, end: e.target.value })} placeholder="optional" />
        </div>
        <div className="field"><label>Priority</label>
          <div className="seg">{(['High', 'Medium', 'Low'] as Priority[]).map((p) => <button type="button" key={p} className={`chip ${f.priority === p ? 'active' : ''}`} onClick={() => setF({ ...f, priority: p })}>{p}</button>)}</div>
        </div>
        <div className="field"><label>Categories</label>
          <div className="seg">{allCategories.map((c) => <button type="button" key={c} className={`chip ${f.categories.includes(c) ? 'active' : ''}`} aria-pressed={f.categories.includes(c)} onClick={() => toggleCat(c)}>{c}</button>)}</div>
        </div>
        <label className="row t-sub" style={{ cursor: 'pointer' }}><input type="checkbox" className="check" checked={f.flagged} onChange={(e) => setF({ ...f, flagged: e.target.checked })} /> Flag as important</label>
        {err && <div className="tag red" role="alert" style={{ padding: 8 }}>{err}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <NeonButton type="button" onClick={onClose}>Cancel</NeonButton>
          <NeonButton type="submit" variant="primary">{task ? 'Save changes' : 'Add task'}</NeonButton>
        </div>
      </form>
    </FuturisticModal>
  );
}
