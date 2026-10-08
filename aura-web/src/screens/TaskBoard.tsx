import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus, CalendarDays, Flag, Sparkles, ListChecks, Activity, CheckCircle2, AlertCircle, List, LayoutGrid, X, MoreHorizontal,
  Plane, ShoppingCart, FileText, Filter, Clock, AlignLeft, CircleDot, Link2, BookOpen, Wand2, type LucideIcon,
} from 'lucide-react';
import { Hud, IconBox, Bar, NeonButton, NeonTabs, AppLogo, SyncStatus, toast, toneHex, type Tone } from '../components/aura';
import { agentById } from '../data/agents';
import { createRecordStore, uid } from '../state/store';

type Bucket = 'today' | 'upcoming' | 'overdue';
/** Persisted task assigned to an agent. `on` is an ISO date (yyyy-mm-dd); the section is derived from it. */
interface Task {
  id: string; title: string; time: string; on: string; agent: string; done: boolean; priority: 'High' | 'Medium' | 'Low';
  description?: string; apps?: string[]; subtasks?: { t: string; done: boolean }[];
}
type TaskView = Task & { icon: LucideIcon; tone: Tone; bucket: Bucket; date?: string };

const agentTasksStore = createRecordStore<Task>('agent_tasks');
const isoDay = (offset: number) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toISOString().slice(0, 10); };
const toView = (t: Task): TaskView => {
  const a = agentById(t.agent);
  const today = isoDay(0);
  const d = new Date(`${t.on}T00:00:00`);
  return {
    ...t, icon: a?.icon ?? CircleDot, tone: a?.tone ?? 'blue',
    bucket: t.on < today ? 'overdue' : t.on === today ? 'today' : 'upcoming',
    date: t.on === today ? undefined : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}|${d.toLocaleDateString('en-US', { weekday: 'short' })}`,
  };
};

const examples: [LucideIcon, string, string][] = [[Plane, 'Plan my trip to Goa', 'travel'], [FileText, 'Prepare for interview', 'research'], [ShoppingCart, 'Order groceries', 'shopping'], [BookOpen, 'Create study plan', 'productivity']];

const tabs = ['All Tasks', 'Today', 'Upcoming', 'Completed', 'Overdue'] as const;
type TabT = (typeof tabs)[number];


export default function Tasks() {
  const nav = useNavigate();
  const stored = agentTasksStore.use();
  const tasks = useMemo(() => stored.map(toView), [stored]);
  const [tab, setTab] = useState<TabT>('All Tasks');
  const [view, setView] = useState<'List' | 'Board'>('List');
  const [draft, setDraft] = useState('');
  const [selId, setSelId] = useState<string | null>(null);
  const [newSub, setNewSub] = useState('');
  const sel = tasks.find((t) => t.id === selId) ?? null;

  const counts = useMemo<Record<TabT, number>>(() => ({
    'All Tasks': tasks.length,
    Today: tasks.filter((t) => t.bucket === 'today').length,
    Upcoming: tasks.filter((t) => t.bucket === 'upcoming').length,
    Completed: tasks.filter((t) => t.done).length,
    Overdue: tasks.filter((t) => t.bucket === 'overdue' && !t.done).length,
  }), [tasks]);

  const inTab = (t: TaskView) => tab === 'All Tasks' || (tab === 'Completed' ? t.done : tab === 'Today' ? t.bucket === 'today' : tab === 'Upcoming' ? t.bucket === 'upcoming' : t.bucket === 'overdue' && !t.done);
  const today = tasks.filter((t) => t.bucket === 'today' && inTab(t));
  const later = tasks.filter((t) => t.bucket !== 'today' && inTab(t));
  const todayAll = tasks.filter((t) => t.bucket === 'today');
  const todayDone = todayAll.filter((t) => t.done).length;

  const update = (id: string, p: Partial<Task>) => agentTasksStore.set((ts) => ts.map((t) => (t.id === id ? { ...t, ...p } : t)));

  const add = (title: string, agent = 'productivity') => {
    const time = title.match(/\b(\d{1,2}(:\d{2})?\s?(am|pm))\b/i)?.[1]?.toUpperCase() ?? 'Anytime';
    const tomorrow = /tomorrow/i.test(title);
    const t: Task = { id: uid('at'), title: title.replace(/\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i, '').replace(/\btomorrow\b/i, '').trim() || title, time, on: isoDay(tomorrow ? 1 : 0), agent, done: false, priority: 'Medium' };
    agentTasksStore.set((ts) => [t, ...ts]);
    setSelId(t.id);
    toast(`Task created — ${agentById(agent)?.name} assigned.`);
  };
  const submit = (e: FormEvent) => { e.preventDefault(); if (draft.trim()) { add(draft); setDraft(''); } };

  const renderRow = (t: TaskView) => {
    const a = agentById(t.agent)!;
    return (
      <div key={t.id} className={`task-row ${selId === t.id ? 'sel' : ''}`} role="row">
        <input type="checkbox" className="check" checked={t.done} onChange={() => update(t.id, { done: !t.done })} aria-label={`Complete ${t.title}`} />
        {t.date ? <span className="mono t-sub" style={{ fontSize: 11, lineHeight: 1.2 }}>{t.date.split('|')[0]}<br />{t.date.split('|')[1]}</span> : <IconBox icon={t.icon} tone={t.tone} size="sm" />}
        <button onClick={() => setSelId(t.id)} style={{ background: 'none', border: 0, textAlign: 'left', padding: 0, minWidth: 0 }} className="row">
          {t.date && <IconBox icon={t.icon} tone={t.tone} size="sm" />}
          <span className="t-title ellipsis" style={{ textDecoration: t.done ? 'line-through' : undefined, opacity: t.done ? 0.6 : 1 }}>{t.title}</span>
        </button>
        <span className="t-sub t-time" style={{ fontSize: 12.5 }}>{t.time}</span>
        <span className="t-agent"><span className="tag" style={{ color: toneHex[a.tone], borderColor: `${toneHex[a.tone]}66`, background: `${toneHex[a.tone]}14` }}><a.icon size={12} /> {a.name}</span></span>
        <Flag size={16} className="t-flag" style={{ color: t.priority === 'High' ? 'var(--aura-danger)' : t.priority === 'Medium' ? 'var(--aura-warning)' : 'var(--aura-muted)' }} fill={t.priority === 'High' ? 'currentColor' : 'none'} aria-label={`${t.priority} priority`} />
        <button className="icon-btn bare" style={{ width: 26, height: 26 }} aria-label={`Details for ${t.title}`} onClick={() => setSelId(t.id)}><MoreHorizontal size={16} /></button>
      </div>
    );
  };

  return (
    <>
      <div className="hero" style={{ minHeight: 170, flexWrap: 'wrap' }}>
        <img className="hero-bg" src="/aura/tasks-android.jpg" alt="" style={{ width: '24%' }} />
        <div style={{ minWidth: 260 }}>
          <h1 style={{ fontSize: 44 }}>Tasks</h1>
          <p style={{ fontSize: 19, marginTop: 2 }}>Let AURA handle the details.</p>
          <p className="t-sub" style={{ maxWidth: 440, marginTop: 6, fontSize: 13.5 }}>Create, track, and automate your tasks. AURA can plan, prioritize, and execute steps across your apps and agents.</p>
        </div>
        <div className="row wrap" style={{ gap: 10 }}>
          {[[List, counts['All Tasks'], 'Total Tasks', 'blue'], [Activity, todayAll.filter((t) => !t.done).length, 'In Progress', 'cyan'], [CheckCircle2, counts.Completed, 'Completed', 'green'], [AlertCircle, counts.Overdue, 'Overdue', 'red']].map(([I, v, l, t]) => {
            const Ic = I as typeof List;
            return <div className="tile row" key={l as string} style={{ padding: '12px 16px', ['--bd' as string]: t === 'red' ? 'rgba(255,79,109,0.6)' : undefined }}><Ic size={30} style={{ color: toneHex[t as Tone], filter: `drop-shadow(0 0 6px ${toneHex[t as Tone]})` }} /><div><b style={{ fontSize: 24 }}>{v as number}</b><div className="t-sub">{l as string}</div></div></div>;
          })}
        </div>
        <div className="stack" style={{ marginLeft: 'auto', alignItems: 'flex-end', gap: 12 }}>
          <div className="hero-quote hide-sm" style={{ fontSize: 16, marginRight: '22%' }}>“Thoughts into Action.<br />Automatically.”</div>
          <NeonButton variant="primary" size="lg" icon={Plus} onClick={() => document.getElementById('quick-add')?.focus()}>New Task</NeonButton>
        </div>
      </div>

      <div className="row between wrap">
        <NeonTabs tabs={tabs} value={tab} onChange={setTab} counts={counts} />
        <div className="row">
          <NeonTabs tabs={['List', 'Board', 'Calendar'] as const} value={view} onChange={(v) => (v === 'Calendar' ? nav('/calendar') : setView(v))} icons={{ List, Board: LayoutGrid, Calendar: CalendarDays }} />
          <NeonButton icon={Filter} onClick={() => setTab(tab === 'Overdue' ? 'All Tasks' : 'Overdue')}>Filter</NeonButton>
        </div>
      </div>

      <div className="tasks-layout">
        <div className="stack">
          <Hud corners title="Quick Add Task" icon={Wand2}>
            <form className="input" onSubmit={submit} style={{ height: 52 }}>
              <input id="quick-add" placeholder="Tell AURA what you want to do..." value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Quick add task" />
              <button aria-label="Create task"><Sparkles size={20} className="c-cyan" /></button>
            </form>
            <div className="t-sub" style={{ margin: '12px 0 8px' }}>Examples:</div>
            <div className="row wrap" style={{ gap: 8 }}>
              {examples.map(([Ic, t, ag]) => (
                <button key={t} className="chip" onClick={() => add(t, ag)}><Ic size={13} /> {t}</button>
              ))}
            </div>
          </Hud>
        </div>

        <div className="stack">
          {view === 'List' ? (
            <>
              <Hud corners>
                <div className="hud-head">
                  <h3><CalendarDays size={18} /> Today's Tasks <span className="t-sub" style={{ fontWeight: 400 }}>{new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</span></h3>
                  <div className="row hide-sm" style={{ marginLeft: 'auto', width: 220 }}><div style={{ flex: 1 }}><Bar value={(todayDone / Math.max(1, todayAll.length)) * 100} tone="green" /></div><span className="t-sub">{todayDone}/{todayAll.length} completed</span></div>
                </div>
                <div className="list" role="table" aria-label="Today's tasks">{today.map((t) => renderRow(t))}</div>
                {today.length === 0 && <div className="empty">Nothing here for this filter.</div>}
              </Hud>
              <Hud corners title={tab === 'Overdue' ? 'Overdue Tasks' : 'Upcoming Tasks'} icon={ListChecks} action="View All" onAction={() => setTab('Upcoming')}>
                <div className="list" role="table" aria-label="Upcoming tasks">{later.map((t) => renderRow(t))}</div>
                {later.length === 0 && <div className="empty">Nothing upcoming for this filter.</div>}
              </Hud>
            </>
          ) : (
            <div className="grid g3">
              {(['today', 'upcoming', 'overdue'] as const).map((b) => (
                <Hud corners key={b} title={b[0].toUpperCase() + b.slice(1)}>
                  <div className="stack" style={{ gap: 8 }}>
                    {tasks.filter((t) => t.bucket === b && inTab(t)).map((t) => (
                      <button key={t.id} className="tile" onClick={() => setSelId(t.id)} style={{ textAlign: 'left', ['--bd' as string]: selId === t.id ? 'var(--aura-primary-bright)' : undefined }}>
                        <div className="row"><IconBox icon={t.icon} tone={t.tone} size="sm" /><span className="t-title" style={{ textDecoration: t.done ? 'line-through' : undefined }}>{t.title}</span></div>
                        <div className="t-sub" style={{ marginTop: 6 }}>{t.time}</div>
                      </button>
                    ))}
                  </div>
                </Hud>
              ))}
            </div>
          )}
        </div>

        <div className="stack">
          {sel ? (
            <Hud corners title="Task Details" action={<X size={15} aria-label="Close details" />} onAction={() => setSelId(null)}>
              <div className="row" style={{ marginBottom: 14 }}><input type="checkbox" className="check" checked={sel.done} onChange={() => update(sel.id, { done: !sel.done })} aria-label="Mark complete" /><b style={{ fontSize: 17 }}>{sel.title}</b></div>
              <div className="list">
                <div className="li" style={{ alignItems: 'flex-start' }}><span className="row t-sub" style={{ width: 110 }}><Clock size={15} /> Time</span><span style={{ fontSize: 13 }}>{sel.date ? sel.date.replace('|', ', ') : 'Today'}<br />{sel.time}</span></div>
                <div className="li" style={{ alignItems: 'flex-start' }}><span className="row t-sub" style={{ width: 110, flexShrink: 0 }}><AlignLeft size={15} /> Description</span><span style={{ fontSize: 13 }}>{sel.description ?? 'No description yet — ask AURA to draft one.'}</span></div>
                <div className="li"><span className="row t-sub" style={{ width: 110 }}><Sparkles size={15} /> Agent</span>
                  <select className="select" style={{ flex: 1 }} value={sel.agent} onChange={(e) => update(sel.id, { agent: e.target.value })} aria-label="Assigned agent">
                    {['travel', 'productivity', 'communication', 'research', 'finance', 'shopping', 'wellness'].map((id) => <option key={id} value={id}>{agentById(id)?.name}</option>)}
                  </select>
                </div>
                <div className="li"><span className="row t-sub" style={{ width: 110 }}><Flag size={15} /> Priority</span>
                  <select className="select" style={{ flex: 1 }} value={sel.priority} onChange={(e) => update(sel.id, { priority: e.target.value as Task['priority'] })} aria-label="Priority"><option>High</option><option>Medium</option><option>Low</option></select>
                </div>
                <div className="li"><span className="row t-sub" style={{ width: 110 }}><CircleDot size={15} /> Status</span>
                  <select className="select" style={{ flex: 1 }} value={sel.done ? 'Completed' : 'Pending'} onChange={(e) => update(sel.id, { done: e.target.value === 'Completed' })} aria-label="Status"><option>Pending</option><option>Completed</option></select>
                </div>
                <div className="li" style={{ alignItems: 'flex-start' }}><span className="row t-sub" style={{ width: 110 }}><Link2 size={15} /> Related Apps</span>
                  <div className="row wrap" style={{ gap: 10 }}>{(sel.apps ?? ['Google Calendar']).map((a) => <div key={a} className="stack" style={{ alignItems: 'center', gap: 3 }}><AppLogo name={a} size={32} /><span style={{ fontSize: 10 }}>{a}</span></div>)}</div>
                </div>
              </div>
              <NeonButton variant="primary" block icon={Sparkles} style={{ margin: '14px 0' }} onClick={() => nav(`/chat?q=${encodeURIComponent('Handle this task: ' + sel.title)}`)}>Ask AURA to Handle This Task</NeonButton>
              <div className="t-title" style={{ marginBottom: 6 }}>Subtasks ({sel.subtasks?.length ?? 0})</div>
              {(sel.subtasks ?? []).map((s, i) => (
                <label key={s.t} className="row" style={{ fontSize: 13.5, padding: '5px 0', cursor: 'pointer' }}>
                  <input type="checkbox" className="check" checked={s.done} onChange={() => update(sel.id, { subtasks: sel.subtasks!.map((x, j) => (j === i ? { ...x, done: !x.done } : x)) })} />
                  <span style={{ textDecoration: s.done ? 'line-through' : undefined }}>{s.t}</span>
                </label>
              ))}
              <form className="row" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); if (!newSub.trim()) return; update(sel.id, { subtasks: [...(sel.subtasks ?? []), { t: newSub, done: false }] }); setNewSub(''); }}>
                <div className="input" style={{ flex: 1, height: 40 }}><input placeholder="Add a subtask" value={newSub} onChange={(e) => setNewSub(e.target.value)} aria-label="New subtask" /></div>
                <NeonButton size="sm" icon={Plus} type="submit" aria-label="Add subtask">Add</NeonButton>
              </form>
            </Hud>
          ) : (
            <Hud corners title="Task Details"><div className="empty">Select a task to see details.</div></Hud>
          )}
          <SyncStatus stores={[agentTasksStore]} />
        </div>
      </div>
    </>
  );
}
