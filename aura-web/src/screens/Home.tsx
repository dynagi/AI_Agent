import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Users, Clock, CalendarDays, IndianRupee, Mic, CalendarCheck, Tag, Plane, SquarePlus, Bell, AlertTriangle, CheckCircle2, MoreVertical, MapPin,
  Droplets, Wind, Search, Scale, BookOpen, LayoutGrid, Sparkles, CloudSun, Wallet, Target,
} from 'lucide-react';
import {
  AuraAvatar, Hud, Bar, Wave, SyncStatus, MetricCard, InsightCard, AgentCard, ActionCard, CommandInput, IconBox, StatusBadge, type Tone,
} from '../components/aura';
import { useAgents, activityStore } from '../state/agentActivity';
import { useUser } from '../state/user';
import { tasksStore, eventsStore, transactionsStore, budgetsStore } from '../state/stores';
import { googleEventsStore } from '../services/googleCalendar';
import { kindMeta, todayISO, type CalendarEvent } from '../data/events';
import { dayOf } from '../data/tasks';
import { aura } from '../services/aura';
import { agentById } from '../data/agents';

const toMin = (t?: string) => { const m = t?.match(/(\d{1,2}):?(\d{2})?\s*(AM|PM)/i); if (!m) return -1; let h = Number(m[1]) % 12; if (/pm/i.test(m[3])) h += 12; return h * 60 + Number(m[2] ?? 0); };
const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

/** Pairs of timed events on the same day whose time ranges overlap. */
function conflicts(events: CalendarEvent[]): [CalendarEvent, CalendarEvent][] {
  const timed = events.filter((e) => toMin(e.start) >= 0).map((e) => ({ e, s: toMin(e.start), f: toMin(e.end) >= 0 ? toMin(e.end) : toMin(e.start) + 60 }));
  const out: [CalendarEvent, CalendarEvent][] = [];
  for (let i = 0; i < timed.length; i++) for (let j = i + 1; j < timed.length; j++) if (timed[i].s < timed[j].f && timed[j].s < timed[i].f) out.push([timed[i].e, timed[j].e]);
  return out;
}

const WEATHER: Record<number, string> = { 0: 'Clear sky', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 80: 'Rain showers', 81: 'Rain showers', 82: 'Violent showers', 95: 'Thunderstorm', 96: 'Thunderstorm', 99: 'Thunderstorm' };
interface Weather { temp: number; feels: number; humidity: number; wind: number; label: string }

function WeatherCard() {
  const [state, setState] = useState<{ status: 'idle' | 'loading' | 'error'; msg: string; w?: Weather }>({ status: 'idle', msg: '' });
  const load = () => {
    if (!navigator.geolocation) { setState({ status: 'error', msg: 'Location is not supported in this browser.' }); return; }
    setState({ status: 'loading', msg: '' });
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        const { latitude, longitude } = pos.coords;
        const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code`);
        if (!res.ok) throw new Error('Weather service unavailable');
        const c = (await res.json()).current;
        setState({ status: 'idle', msg: '', w: { temp: Math.round(c.temperature_2m), feels: Math.round(c.apparent_temperature), humidity: c.relative_humidity_2m, wind: Math.round(c.wind_speed_10m), label: WEATHER[c.weather_code] ?? 'Unknown' } });
      } catch (e) {
        setState({ status: 'error', msg: e instanceof Error ? e.message : 'Could not load weather.' });
      }
    }, () => setState({ status: 'error', msg: 'Location permission was denied.' }), { timeout: 10000 });
  };
  useEffect(() => { void navigator.permissions?.query({ name: 'geolocation' }).then((p) => { if (p.state === 'granted') load(); }).catch(() => undefined); }, []);
  const w = state.w;
  return (
    <Hud style={{ ['--fill' as string]: 'linear-gradient(180deg, rgba(20,48,110,0.75), rgba(8,18,40,0.9) 55%, rgba(4,10,22,0.96))' }}>
      <div className="row between"><span className="row"><MapPin size={16} className="c-cyan" /> Your location</span><span className="t-sub">{new Date().toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' })}</span></div>
      {w ? (
        <>
          <div className="row" style={{ margin: '22px 0 2px', gap: 12 }}>
            <span style={{ fontSize: 56, fontWeight: 700, fontFamily: 'var(--font-head)' }}>{w.temp}°C</span>
            <CloudSun size={42} className="c-cyan" style={{ filter: 'drop-shadow(0 0 8px var(--aura-cyan))' }} />
          </div>
          <div className="row between"><span style={{ fontSize: 17 }}>{w.label}</span><span className="t-sub">Feels like {w.feels}°C</span></div>
          <div className="grid g2" style={{ marginTop: 20, gap: 8 }}>
            <span className="row t-sub"><Droplets size={16} /> {w.humidity}%</span>
            <span className="row t-sub"><Wind size={16} /> {w.wind} km/h</span>
          </div>
        </>
      ) : (
        <div className="stack" style={{ alignItems: 'center', gap: 10, padding: '24px 0' }}>
          <CloudSun size={38} className="c-cyan" />
          <span className="t-sub" style={{ textAlign: 'center' }}>{state.msg || 'Show live weather for where you are.'}</span>
          <button className="btn sm" onClick={load} disabled={state.status === 'loading'}>{state.status === 'loading' ? 'Locating…' : 'Enable weather'}</button>
        </div>
      )}
    </Hud>
  );
}

export default function Home() {
  const nav = useNavigate();
  const user = useUser();
  const agents = useAgents();
  const activity = activityStore.use();
  const tasks = tasksStore.use();
  const localEvents = eventsStore.use();
  const googleEvents = googleEventsStore.use();
  const txs = transactionsStore.use();
  const budgets = budgetsStore.use();
  const [ask, setAsk] = useState('');
  const [health, setHealth] = useState<'checking' | 'online' | 'offline'>('checking');
  const [aiOk, setAiOk] = useState<boolean | null>(null);

  useEffect(() => {
    aura.health().then((h) => { setHealth('online'); setAiOk(h.dependencies?.pythonAi === 'ok'); }).catch(() => setHealth('offline'));
  }, []);

  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good Morning' : hour < 17 ? 'Good Afternoon' : 'Good Evening';
  const go = (q: string) => nav(`/chat?q=${encodeURIComponent(q)}`);

  const today = todayISO();
  const events = useMemo(() => [...localEvents, ...googleEvents], [localEvents, googleEvents]);
  const todayEvents = events.filter((e) => e.date === today).sort((a, b) => toMin(a.start) - toMin(b.start));
  const clashes = conflicts(todayEvents);
  const openToday = tasks.filter((t) => !t.done && dayOf(t.date) === 'today');
  const overdue = tasks.filter((t) => !t.done && t.date < today);
  const weekEnd = new Date(); weekEnd.setDate(weekEnd.getDate() + 7);
  const upcoming = events.filter((e) => e.date >= today && e.date <= weekEnd.toISOString().slice(0, 10));

  const now = new Date();
  const monthTx = txs.filter((t) => { const d = new Date(t.ts); return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth(); });
  const spend = monthTx.filter((t) => t.amount < 0).reduce((s, t) => s - t.amount, 0);
  const limitTotal = budgets.reduce((s, b) => s + b.limit, 0);
  const important = openToday.length + todayEvents.length;
  const activeAgents = agents.filter((a) => a.status !== 'idle').length;

  const insights = useMemo(() => {
    const out: { icon: typeof Plane; tone: Tone; title: string; body: string; to: string }[] = [];
    clashes.slice(0, 2).forEach(([a, b]) => out.push({ icon: AlertTriangle, tone: 'amber', title: 'Schedule conflict today', body: `“${a.title}” (${a.start}) overlaps with “${b.title}” (${b.start}).`, to: '/calendar' }));
    if (overdue.length) out.push({ icon: Bell, tone: 'amber', title: `${overdue.length} overdue task${overdue.length > 1 ? 's' : ''}`, body: `“${overdue[0].title}” was due ${overdue[0].date}.`, to: '/tasks' });
    for (const b of budgets) {
      const spent = monthTx.filter((t) => t.amount < 0 && t.category === b.category).reduce((s, t) => s - t.amount, 0);
      if (spent >= b.limit * 0.9) out.push({ icon: Wallet, tone: 'red', title: `${b.category} budget at ${Math.round((spent / b.limit) * 100)}%`, body: `${inr(spent)} of ${inr(b.limit)} spent this month.`, to: '/finance' });
    }
    if (openToday.length && !overdue.length && !clashes.length) out.push({ icon: Target, tone: 'cyan', title: `${openToday.length} task${openToday.length > 1 ? 's' : ''} left today`, body: `Next up: “${openToday[0].title}”.`, to: '/tasks' });
    return out;
  }, [clashes, overdue, budgets, monthTx, openToday]);

  const quick: { icon: typeof Plane; label: string; tone: Tone; to: string }[] = [
    { icon: Search, label: 'Find Products', tone: 'amber', to: '/shopping' },
    { icon: Scale, label: 'Compare Prices', tone: 'blue', to: '/shopping' },
    { icon: Plane, label: 'Plan Travel', tone: 'blue', to: '/travel' },
    { icon: CalendarCheck, label: 'Create Task', tone: 'blue', to: '/tasks' },
    { icon: IndianRupee, label: 'Add Expense', tone: 'green', to: '/finance' },
    { icon: BookOpen, label: 'Research', tone: 'violet', to: '/research' },
    { icon: Sparkles, label: 'Ask AURA', tone: 'cyan', to: '/chat' },
    { icon: LayoutGrid, label: 'Open Apps', tone: 'blue', to: '/integrations' },
  ];
  const chips: [typeof Plane, string][] = [
    [CalendarCheck, 'Plan my day'], [Tag, 'Find best price'], [Plane, 'Prepare for travel'], [Wallet, 'Review my budget'], [Target, 'What should I focus on?'], [SquarePlus, 'Create a task'],
  ];

  const summary = important === 0
    ? 'Nothing is scheduled for today yet.'
    : <>You have <b className="c-cyan">{important} thing{important > 1 ? 's' : ''}</b> today.{clashes.length > 0 && <> I detected <b className="c-amber">{clashes.length} schedule conflict{clashes.length > 1 ? 's' : ''}</b>.</>}</>;

  return (
    <>
      <div className="dash-hero">
        <div className="hero">
          <div className="copy" style={{ zIndex: 2 }}>
            <h2 style={{ fontSize: 28, fontWeight: 600 }}>{greet},</h2>
            <h1 className="grad-cyan" style={{ fontSize: 44 }}>{user.name}</h1>
            <p className="lead" style={{ fontSize: 16 }}>“Let's make today productive. Ask me anything about your schedule, tasks, spending or plans.”</p>
            <p style={{ marginTop: 12, fontSize: 14 }}>{summary}</p>
            <div style={{ marginTop: 14 }}><Wave bars={26} /></div>
          </div>
          <div className="dash-portal">
            <AuraAvatar art="android" size={330} height={300} square />
          </div>
        </div>
        <Hud corners>
          <h3 style={{ fontSize: 21, fontWeight: 500, marginBottom: 12 }}>How can I help you today?</h3>
          <div className="row" style={{ justifyContent: 'center', margin: '4px 0 16px' }}>
            <button className="mic-btn" style={{ width: 78, height: 78 }} aria-label="Start voice mode" onClick={() => nav('/voice')}><Mic size={32} /></button>
          </div>
          <CommandInput value={ask} onChange={setAsk} onSubmit={go} placeholder="Ask anything..." />
          <div className="grid g3" style={{ marginTop: 12, gap: 8 }}>
            {chips.map(([I, l]) => <button key={l} className="chip" style={{ justifyContent: 'flex-start' }} onClick={() => go(l)}><I size={15} /> {l}</button>)}
          </div>
        </Hud>
      </div>

      <div className="grid g4">
        <MetricCard icon={Users} tone="cyan" value={String(activeAgents)} label="Agents Working" onClick={() => nav('/agents')} />
        <MetricCard icon={Clock} tone="amber" value={String(tasks.filter((t) => !t.done).length)} label="Open Tasks" onClick={() => nav('/tasks')} />
        <MetricCard icon={CalendarDays} tone="blue" value={String(upcoming.length)} label="Events This Week" onClick={() => nav('/calendar')} />
        <MetricCard icon={IndianRupee} tone="cyan" value={inr(spend)} label="Spent This Month" onClick={() => nav('/finance')}
          extra={limitTotal > 0 ? <div className="row" style={{ marginTop: 6 }}><div style={{ flex: 1 }}><Bar value={Math.min(100, (spend / limitTotal) * 100)} tone={spend > limitTotal ? 'red' : 'green'} /></div><span className="t-mute">{Math.round((spend / limitTotal) * 100)}% of budgets</span></div> : undefined} />
      </div>

      <div className="grid g3">
        <Hud title="Today's Schedule" action="View All" onAction={() => nav('/calendar')}>
          <div className="stack" style={{ gap: 0 }}>
            {todayEvents.map((e, i) => {
              const meta = kindMeta[e.kind];
              return (
                <div className="row" key={e.id} style={{ alignItems: 'stretch', gap: 12 }}>
                  <span className="mono t-sub" style={{ width: 66, fontSize: 12, paddingTop: 14, flexShrink: 0 }}>{e.start}</span>
                  <div className="stack" style={{ gap: 0, alignItems: 'center', width: 10 }}>
                    <span style={{ width: 1.5, flex: 1, background: i ? 'var(--aura-primary)' : 'transparent', opacity: 0.6 }} />
                    <span className="dot cyan" />
                    <span style={{ width: 1.5, flex: 1, background: i < todayEvents.length - 1 ? 'var(--aura-primary)' : 'transparent', opacity: 0.6 }} />
                  </div>
                  <div className="li grow" style={{ padding: '9px 0' }}>
                    <IconBox icon={meta.icon} tone={meta.tone} size="sm" />
                    <div className="grow"><div className="t-title">{e.title}</div><div className="t-sub">{e.end ? `until ${e.end}` : meta.label}{e.source === 'google' ? ' • Google Calendar' : ''}</div></div>
                    <MoreVertical size={15} className="t-mute" aria-hidden />
                  </div>
                </div>
              );
            })}
            {!todayEvents.length && <div className="empty">No events today. Add one in Calendar.</div>}
          </div>
        </Hud>

        <Hud title="AURA Insights" action="See Details" onAction={() => nav('/decisions')}>
          <div className="stack" style={{ gap: 10 }}>
            {insights.map((i) => <InsightCard key={i.title} {...i} onClick={() => nav(i.to)} />)}
            {!insights.length && <div className="empty"><CheckCircle2 size={18} className="c-green" /> You're all caught up. Insights appear here as you add tasks, events and spending.</div>}
          </div>
        </Hud>

        <Hud title="Agents" action="Manage" onAction={() => nav('/agents')}>
          <div className="list">
            {agents.filter((a) => a.id !== 'core').slice(0, 8).map((a) => <AgentCard key={a.id} agent={a} compact onClick={() => nav(`/agents/${a.id}`)} />)}
          </div>
        </Hud>
      </div>

      <div className="grid g3">
        <Hud title="Quick Actions">
          <div className="grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 14 }}>
            {quick.map((q) => <ActionCard key={q.label} {...q} onClick={() => nav(q.to)} />)}
          </div>
        </Hud>
        <Hud title="Recent Activity" action="View All" onAction={() => nav('/collaboration')}>
          <div className="list">
            {activity.slice(0, 5).map((r, i) => {
              const a = agentById(r.agent);
              return (
                <div className="li" key={`${r.agent}${r.time}${i}`}>
                  {a && <IconBox icon={a.icon} tone={a.tone} size="sm" />}
                  <div className="grow"><div className="t-title">{a?.name ?? r.agent}</div><div className="t-sub ellipsis">{r.text}</div></div>
                  <span className="t-mute" style={{ whiteSpace: 'nowrap' }}>{r.time}</span>
                </div>
              );
            })}
            {!activity.length && <div className="empty">No agent activity yet this session. Ask AURA something to get started.</div>}
          </div>
        </Hud>
        <WeatherCard />
      </div>
      <div className="row between wrap">
        <div className="row wrap">
          <StatusBadge status={health === 'online' ? 'online' : 'idle'} label={health === 'checking' ? 'Connecting…' : health === 'online' ? 'Backend online' : 'Backend offline'} />
          {aiOk !== null && <StatusBadge status={aiOk ? 'active' : 'idle'} label={aiOk ? 'AI service ready' : 'AI service unreachable'} />}
        </div>
        <SyncStatus stores={[tasksStore, eventsStore, transactionsStore, budgetsStore]} />
      </div>
    </>
  );
}
