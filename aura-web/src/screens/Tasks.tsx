import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, CalendarDays, Flag, CalendarCheck, CalendarRange, CheckCircle2, List, LayoutGrid, ChevronDown, Sun, Sparkles, ClipboardList } from 'lucide-react';
import { Hud, IconBox, NeonButton, NeonTabs, PageHero, FilterDropdown, Donut, SyncStatus, toast } from '../components/aura';
import { AICommandPanel, confirmActions, domainAsk, type AIReply } from '../components/ai';
import { aura } from '../services/aura';
import { TaskCard, TaskEditor } from '../components/tasks';
import { allCategories, dayOf, type Priority, type TaskItem } from '../data/tasks';
import { tasksStore } from '../state/stores';
import { uid } from '../state/store';
import { usePageSearch, matches } from '../state/search';

const TABS = ['My Tasks', 'Today', 'Upcoming', 'Completed'] as const;
type Tab = (typeof TABS)[number];
const CATS = ['All Categories', ...allCategories] as const;
const PRIOS = ['All', 'High', 'Medium', 'Low'] as const;
const SORTS = ['Time', 'Priority', 'Title'] as const;

const isoIn = (days: number) => { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); };
const toMin = (t?: string) => { const m = t?.match(/(\d{1,2}):?(\d{2})?\s*(AM|PM)/i); if (!m) return 9999; let h = Number(m[1]) % 12; if (/pm/i.test(m[3])) h += 12; return h * 60 + Number(m[2] ?? 0); };
const prioRank: Record<Priority, number> = { High: 0, Medium: 1, Low: 2 };

/** Natural-language quick add: "Prepare presentation tomorrow 10 AM" */
export function parseTask(text: string, opts: { date?: string; flagged?: boolean } = {}): Omit<TaskItem, 'id'> {
  const t = text.toLowerCase();
  const tomorrow = /\btomorrow\b/.test(t);
  const evening = /\bevening\b/.test(t);
  const time = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  const start = time ? `${Number(time[1])}:${time[2] ?? '00'} ${time[3].toUpperCase()}` : evening ? '7:00 PM' : undefined;
  const categories = [
    /(meeting|standup|call|sync)/.test(t) && 'Meeting', /(presentation|report|review|work|client)/.test(t) && 'Work', /(gym|workout|run|yoga)/.test(t) && 'Health',
    /(read|paper|study|learn)/.test(t) && 'Learning', /(trip|flight|travel|book)/.test(t) && 'Travel', /(mom|dad|family|call)/.test(t) && 'Personal', /hackathon/.test(t) && 'Hackathon',
  ].filter(Boolean) as string[];
  const title = text.replace(/^(add a task to|remind me to|add)\s+/i, '').replace(/\b(tomorrow|today|in the evening|evening)\b/gi, '').replace(/\b\d{1,2}(:\d{2})?\s*(am|pm)\b/i, '').replace(/\s{2,}/g, ' ').trim();
  const date = opts.date ?? (tomorrow ? isoIn(1) : isoIn(0));
  const day: TaskItem['day'] = date === isoIn(0) ? 'today' : date === isoIn(1) ? 'tomorrow' : 'later';
  return { title: title.charAt(0).toUpperCase() + title.slice(1), categories: categories.length ? [...new Set(categories)] : ['Personal'], priority: opts.flagged ? 'High' : 'Medium', day, date, start, flagged: !!opts.flagged, done: false };
}

export default function Tasks() {
  const nav = useNavigate();
  const stored = tasksStore.use();
  const tasks = useMemo(() => stored.map((t) => ({ ...t, day: dayOf(t.date) })), [stored]);
  const q = usePageSearch();
  const [tab, setTab] = useState<Tab>('My Tasks');
  const [cat, setCat] = useState<(typeof CATS)[number]>('All Categories');
  const [prio, setPrio] = useState<(typeof PRIOS)[number]>('All');
  const [sort, setSort] = useState<(typeof SORTS)[number]>('Time');
  const [view, setView] = useState<'list' | 'grid'>('list');
  const [draft, setDraft] = useState('');
  const [draftDate, setDraftDate] = useState('');
  const [draftFlag, setDraftFlag] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<TaskItem | 'new' | null>(null);
  const [trigger, setTrigger] = useState<{ prompt: string; id: number } | null>(null);
  const dateRef = useRef<HTMLInputElement>(null);

  const update = (id: string, p: Partial<TaskItem>) => tasksStore.set((ts) => ts.map((t) => (t.id === id ? { ...t, ...p } : t)));
  const add = (t: Omit<TaskItem, 'id'>) => { tasksStore.set((ts) => [{ ...t, id: uid('tk') }, ...ts]); };

  const filtered = useMemo(() => tasks
    .filter((t) => (cat === 'All Categories' || t.categories.includes(cat)) && (prio === 'All' || t.priority === prio) && matches(q, t.title, ...t.categories))
    .filter((t) => tab === 'My Tasks' || (tab === 'Today' ? t.day === 'today' : tab === 'Upcoming' ? t.day !== 'today' && !t.done : t.done))
    .sort((a, b) => sort === 'Priority' ? prioRank[a.priority] - prioRank[b.priority] : sort === 'Title' ? a.title.localeCompare(b.title) : a.date.localeCompare(b.date) || toMin(a.start) - toMin(b.start)),
  [tasks, cat, prio, q, tab, sort]);

  const sections = ([['today', 'Today'], ['tomorrow', 'Tomorrow'], ['later', 'Upcoming']] as const)
    .map(([k, label]) => ({ k, label, items: filtered.filter((t) => t.day === k) }))
    .filter((s) => s.items.length);

  const summary = {
    done: tasks.filter((t) => t.done).length,
    progress: tasks.filter((t) => !t.done && t.day === 'today').length,
    pending: tasks.filter((t) => !t.done && t.day !== 'today').length,
  };
  const slices = [{ label: 'Completed', value: summary.done, color: '#00E5A8' }, { label: 'In Progress', value: summary.progress, color: '#00AFFF' }, { label: 'Pending', value: summary.pending, color: '#8B5CFF' }];

  const quickAdd = (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    const t = parseTask(draft, { date: draftDate || undefined, flagged: draftFlag });
    add(t);
    setDraft(''); setDraftDate(''); setDraftFlag(false);
    toast(`Task added: “${t.title}” · ${t.day === 'today' ? 'Today' : t.day === 'tomorrow' ? 'Tomorrow' : t.date}${t.start ? ` ${t.start}` : ''}`);
  };

  const chat = domainAsk('tasks', () => JSON.stringify({ today: isoIn(0), openTasks: tasks.filter((t) => !t.done).map((t) => ({ title: t.title, date: t.date, start: t.start, priority: t.priority, categories: t.categories })) }));
  const ai = async (p: string): Promise<AIReply> => {
    const text = p.trim();
    if (/^(break ?down|split|plan out)\b/i.test(text)) {
      const goal = text.replace(/^(break ?down|split|plan out)\s*(my|the|this)?\s*:?\s*/i, '') || text;
      const steps = await aura.plan(goal);
      if (!steps.length) return { text: 'I could not break that down into steps. Try describing the goal in more detail.' };
      return { text: `Here is a step-by-step breakdown of “${goal}”:`, preview: steps.map((x) => x.title),
        actions: confirmActions(`Create ${steps.length} tasks`, () => { steps.forEach((x, i) => add({ title: x.title, categories: ['Work'], priority: i === 0 ? 'High' : 'Medium', day: 'today', date: isoIn(0), start: undefined, flagged: i === 0, done: false })); return `${steps.length} tasks created.`; }) };
    }
    if (/^(add|remind|create|schedule|new task)\b/i.test(text)) {
      const parsed = parseTask(text);
      return { text: 'I can create this task for you:', preview: [`“${parsed.title}” · ${parsed.day === 'today' ? 'Today' : parsed.day === 'tomorrow' ? 'Tomorrow' : parsed.date}${parsed.start ? ` · ${parsed.start}` : ''} · ${parsed.categories.join(', ')}`],
        actions: confirmActions('Confirm', () => { add(parsed); return `Task created: “${parsed.title}”.`; }) };
    }
    return chat(text);
  };

  return (
    <>
      <PageHero title="Tasks" lead="Get more done with your AI co-pilot." image="/aura/hero-tasks.jpg" imageWidth="34%" quote="Small Steps Build a Smarter You."
        right={<NeonButton variant="ai" size="lg" icon={Plus} onClick={() => setEditing('new')} style={{ zIndex: 2 }}>Add Task</NeonButton>} />

      <div className="module">
        <div className="main">
          <div className="row between wrap">
            <NeonTabs tabs={TABS} value={tab} onChange={setTab} icons={{ 'My Tasks': CalendarCheck, Today: CalendarDays, Upcoming: CalendarRange, Completed: CheckCircle2 }} />
            <div className="row wrap">
              <FilterDropdown value={cat} options={CATS} onChange={setCat} />
              <FilterDropdown label="Priority" value={prio} options={PRIOS} onChange={setPrio} align="right" />
              <button className={`icon-btn ${view === 'list' ? 'c-cyan' : ''}`} aria-pressed={view === 'list'} aria-label="List view" onClick={() => setView('list')}><List size={18} /></button>
              <button className={`icon-btn ${view === 'grid' ? 'c-cyan' : ''}`} aria-pressed={view === 'grid'} aria-label="Grid view" onClick={() => setView('grid')}><LayoutGrid size={18} /></button>
            </div>
          </div>

          <form className="hud row" onSubmit={quickAdd} style={{ padding: '10px 12px' }}>
            <Plus size={20} className="c-cyan" />
            <input style={{ flex: 1, minWidth: 0, background: 'none', border: 0, outline: 0, fontSize: 15, color: '#fff' }} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder='Add a new task… (e.g., "Prepare presentation tomorrow 10 AM")' aria-label="New task" />
            {draftDate && <span className="tag blue">{draftDate}</span>}
            <button type="button" className="icon-btn bare" aria-label="Pick a date" onClick={() => dateRef.current?.showPicker?.() ?? dateRef.current?.focus()}><CalendarDays size={19} /></button>
            <input ref={dateRef} type="date" className="sr-only" value={draftDate} onChange={(e) => setDraftDate(e.target.value)} tabIndex={-1} aria-hidden />
            <button type="button" className="icon-btn bare" aria-pressed={draftFlag} aria-label="Mark high priority" onClick={() => setDraftFlag((f) => !f)}><Flag size={19} style={{ color: draftFlag ? 'var(--aura-danger)' : undefined }} fill={draftFlag ? 'currentColor' : 'none'} /></button>
            <NeonButton type="submit" variant="ai" disabled={!draft.trim()}>Add</NeonButton>
          </form>

          {sections.map((s) => (
            <Hud key={s.k} corners>
              <div className="row between" style={{ marginBottom: 6 }}>
                <button className="row" style={{ background: 'none', border: 0, padding: 0 }} onClick={() => setCollapsed((c) => ({ ...c, [s.k]: !c[s.k] }))} aria-expanded={!collapsed[s.k]}>
                  <h2 style={{ fontSize: 22 }}>{s.label}</h2><span className="tag violet" style={{ borderRadius: 12, padding: '2px 9px', background: s.k === 'today' ? 'rgba(0,140,255,0.4)' : 'rgba(139,92,255,0.5)', color: '#fff' }}>{s.items.length}</span>
                </button>
                {s.k === 'today'
                  ? <FilterDropdown label="Sort" value={sort} options={SORTS} onChange={setSort} align="right" />
                  : <button className="icon-btn bare" onClick={() => setCollapsed((c) => ({ ...c, [s.k]: !c[s.k] }))} aria-label={collapsed[s.k] ? 'Expand' : 'Collapse'}><ChevronDown size={18} style={{ transform: collapsed[s.k] ? 'rotate(-90deg)' : undefined, transition: 'transform var(--t-fast)' }} /></button>}
              </div>
              {!collapsed[s.k] && (view === 'list' ? (
                <div role="list">
                  {s.items.map((t) => (
                    <TaskCard key={t.id} task={t} onToggle={() => update(t.id, { done: !t.done })} onFlag={() => update(t.id, { flagged: !t.flagged })} onEdit={() => setEditing(t)}
                      onDelete={() => { tasksStore.set((ts) => ts.filter((x) => x.id !== t.id)); toast(`Deleted “${t.title}”.`); }}
                      onDuplicate={() => { add({ ...t, title: `${t.title} (copy)`, done: false }); toast('Task duplicated.'); }} />
                  ))}
                </div>
              ) : (
                <div className="grid g3">
                  {s.items.map((t) => (
                    <TaskCard key={t.id} grid task={t} onToggle={() => update(t.id, { done: !t.done })} onFlag={() => update(t.id, { flagged: !t.flagged })} onEdit={() => setEditing(t)}
                      onDelete={() => tasksStore.set((ts) => ts.filter((x) => x.id !== t.id))} onDuplicate={() => add({ ...t, title: `${t.title} (copy)`, done: false })} />
                  ))}
                </div>
              ))}
            </Hud>
          ))}
          {!sections.length && <Hud><div className="empty">No tasks match these filters{q ? ` or “${q}”` : ''}. Try another tab, or tell AURA what you need to do.</div></Hud>}
          <SyncStatus stores={[tasksStore]} />
        </div>

        <div className="rail">
          <AICommandPanel title="Let AURA Handle It" badge={null} description="Create, prioritize, and manage your tasks using natural language." promptStyle="boxes"
            prompts={['Add a task to prepare presentation tomorrow 10 AM', 'Remind me to call mom in the evening', 'Break down: prepare my hackathon presentation']}
            onAsk={ai} cta="Create with AI" ctaIcon={Sparkles} placeholder="Tell AURA what to do…" trigger={trigger} />
          <Hud corners title="Task Summary">
            <div className="row" style={{ gap: 20 }}>
              <Donut data={slices} size={126} stroke={14} center={tasks.length} sub="Total" />
              <div className="legend" style={{ flex: 1 }}>
                {slices.map((s) => <div key={s.label} className="legend-row"><span className="sw" style={{ background: s.color, borderRadius: '50%' }} /><span>{s.label}</span><span className="v" style={{ color: '#fff', fontSize: 14 }}>{s.value}</span></div>)}
              </div>
            </div>
          </Hud>
          <Hud corners title="Quick Actions">
            <div className="grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 8 }}>
              {[
                [Sun, 'Today', 'blue', () => setTab('Today')],
                [ClipboardList, 'This Week', 'amber', () => setTab('Upcoming')],
                [Flag, 'Priorities', 'red', () => { setPrio('High'); setTab('My Tasks'); }],
                [Sparkles, 'AI Plan', 'violet', () => setTrigger({ prompt: 'Plan my day', id: Date.now() })],
              ].map(([I, l, tone, fn]) => (
                <button key={l as string} className="stack" style={{ background: 'none', border: 0, alignItems: 'center', gap: 6 }} onClick={fn as () => void}>
                  <IconBox icon={I as typeof Sun} tone={tone as 'blue'} size="lg" /><span style={{ fontSize: 12 }}>{l as string}</span>
                </button>
              ))}
            </div>
            <button className="t-mute" style={{ background: 'none', border: 0, marginTop: 10 }} onClick={() => nav('/tasks/board')}>Open agent task board →</button>
          </Hud>
        </div>
      </div>

      {editing && (
        <TaskEditor task={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)}
          onSave={(d) => {
            if (editing === 'new') { add(d); toast(`Task added: “${d.title}”.`); } else { update(editing.id, d); toast('Task updated.'); }
            setEditing(null);
          }} />
      )}
    </>
  );
}
