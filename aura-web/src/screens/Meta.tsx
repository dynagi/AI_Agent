import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CalendarCheck, IndianRupee, Plane, MoreHorizontal, Leaf, Heart, Trophy, CheckCircle2, Crown, Users, Zap, Brain, ChevronRight, Sparkles, Rocket, CreditCard as Mail,
  LifeBuoy, Globe, UsersRound, ArrowRight, Infinity as InfinityIcon, Target, Send, Activity, Wallet,
} from 'lucide-react';
import { Hud, IconBox, Bar, Donut, Legend, LineChart, BarChart, SyncStatus, PageHero, toast, type Tone } from '../components/aura';
import { agentById } from '../data/agents';
import { txColor, type TxCategory } from '../data/transactions';
import { goalIcons } from '../data/goals';
import { activityStore } from '../state/agentActivity';
import { tasksStore, transactionsStore, goalsStore, bookingsStore, dayLogsStore, budgetsStore } from '../state/stores';

/* =================== ANALYTICS =================== */

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const RANGES = { 'Last 7 days': 7, 'Last 30 days': 30, 'Last 90 days': 90 } as const;

export function Analytics() {
  const nav = useNavigate();
  const [range, setRange] = useState<keyof typeof RANGES>('Last 30 days');
  const tasks = tasksStore.use();
  const txs = transactionsStore.use();
  const goals = goalsStore.use();
  const bookings = bookingsStore.use();
  const logs = dayLogsStore.use();
  const budgets = budgetsStore.use();
  const activity = activityStore.use();

  const days = RANGES[range];
  const since = new Date(); since.setDate(since.getDate() - days + 1); since.setHours(0, 0, 0, 0);
  const sinceIso = iso(since);

  const stats = useMemo(() => {
    const inRange = txs.filter((t) => new Date(t.ts) >= since);
    const income = inRange.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
    const spend = inRange.filter((t) => t.amount < 0).reduce((s, t) => s - t.amount, 0);
    const byCat = new Map<TxCategory, number>();
    inRange.filter((t) => t.amount < 0).forEach((t) => byCat.set(t.category, (byCat.get(t.category) ?? 0) + Math.abs(t.amount)));
    const dueInRange = tasks.filter((t) => t.date >= sinceIso && t.date <= iso(new Date()));
    const points = Array.from({ length: Math.min(days, 14) }, (_, i) => {
      const d = new Date(); d.setDate(d.getDate() - (Math.min(days, 14) - 1 - i));
      const key = iso(d);
      return { label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), done: tasks.filter((t) => t.date === key && t.done).length };
    });
    return { income, spend, byCat: [...byCat.entries()].sort((a, b) => b[1] - a[1]), doneCount: dueInRange.filter((t) => t.done).length, dueCount: dueInRange.length, points };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txs, tasks, days]);

  const catData = stats.byCat.map(([label, v]) => ({ label, value: Math.round((v / Math.max(1, stats.spend)) * 100), color: txColor[label] }));
  const agentCounts = useMemo(() => {
    const m = new Map<string, number>();
    activity.forEach((a) => m.set(a.agent, (m.get(a.agent) ?? 0) + 1));
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [activity]);
  const loggedDays = logs.filter((l) => l.date >= sinceIso).length;
  const avgSleep = (() => { const v = logs.filter((l) => l.date >= sinceIso && l.sleepHours).map((l) => l.sleepHours as number); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; })();
  const avgSteps = (() => { const v = logs.filter((l) => l.date >= sinceIso && l.steps).map((l) => l.steps as number); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; })();

  const insights = useMemo(() => {
    const out: { icon: typeof Plane; text: string; to: string; cta: string }[] = [];
    if (stats.byCat[0]) out.push({ icon: Wallet, text: `${stats.byCat[0][0]} is your biggest expense in this period (${inr(stats.byCat[0][1])}).`, to: '/finance', cta: 'Review spending' });
    const over = budgets.find((b) => (stats.byCat.find(([c]) => c === b.category)?.[1] ?? 0) > b.limit);
    if (over) out.push({ icon: Wallet, text: `You've spent more than your ${inr(over.limit)} ${over.category} budget.`, to: '/finance', cta: 'Adjust budget' });
    if (stats.dueCount && stats.doneCount < stats.dueCount) out.push({ icon: CalendarCheck, text: `${stats.dueCount - stats.doneCount} task${stats.dueCount - stats.doneCount > 1 ? 's' : ''} that were due are still open.`, to: '/tasks', cta: 'Open tasks' });
    if (avgSleep && avgSleep < 7) out.push({ icon: Heart, text: `You've averaged ${avgSleep.toFixed(1)} hours of sleep. Aim for 7–8.`, to: '/wellness', cta: 'Plan wind-down' });
    return out;
  }, [stats, budgets, avgSleep]);

  const achievements = [
    stats.doneCount >= 5 && { icon: CalendarCheck, tone: 'green', title: 'Task Finisher', sub: `${stats.doneCount} tasks done` },
    bookings.length >= 1 && { icon: Plane, tone: 'blue', title: 'Trip Planner', sub: `${bookings.length} saved booking${bookings.length > 1 ? 's' : ''}` },
    loggedDays >= 5 && { icon: Heart, tone: 'pink', title: 'Wellness Streak', sub: `${loggedDays} days logged` },
    stats.income > stats.spend && stats.income > 0 && { icon: IndianRupee, tone: 'violet', title: 'Smart Spender', sub: `Saved ${inr(stats.income - stats.spend)}` },
  ].filter(Boolean) as { icon: typeof Plane; tone: Tone; title: string; sub: string }[];

  return (
    <>
      <PageHero art="analytics" title="Analytics &" accent="Insights" lead="A personalized view of your own activity, spending and progress." quote="Data into Decisions."
        right={<select className="select" value={range} onChange={(e) => setRange(e.target.value as keyof typeof RANGES)} aria-label="Date range">{Object.keys(RANGES).map((r) => <option key={r}>{r}</option>)}</select>} />
      <div className="grid g4">
        {([[CalendarCheck, `${stats.doneCount}/${stats.dueCount}`, 'Due tasks completed', 'pink'], [IndianRupee, inr(stats.spend), 'Spent', 'cyan'], [Wallet, inr(stats.income - stats.spend), 'Net saved', 'green'], [Plane, String(bookings.length), 'Saved bookings', 'blue']] as const).map(([I, v, l, t]) => (
          <div className="hud row" key={l}><IconBox icon={I} tone={t as Tone} size="lg" /><div style={{ flex: 1 }}><b style={{ fontSize: 22 }}>{v}</b><div className="t-sub">{l}</div></div></div>
        ))}
      </div>
      <div className="grid g3">
        <Hud title="Tasks Completed by Day" icon={CalendarCheck}>
          {stats.points.some((p) => p.done > 0) ? <LineChart values={stats.points.map((p) => p.done)} labels={stats.points.map((p) => p.label)} height={200} /> : <div className="empty">Complete tasks and they'll be charted here.</div>}
        </Hud>
        <Hud title="Spending by Category" icon={IndianRupee}>
          {catData.length ? <div className="row" style={{ gap: 16 }}><Donut data={catData} center={inr(stats.spend)} sub="Spent" size={160} /><Legend data={catData} /></div> : <div className="empty">No spending recorded in this period.</div>}
        </Hud>
        <Hud title="Top Expenses" icon={MoreHorizontal}>
          <div className="stack" style={{ gap: 10 }}>
            {stats.byCat.slice(0, 5).map(([label, v]) => (
              <div className="row" key={label}><span style={{ width: 120, fontSize: 13 }}>{label}</span><div style={{ flex: 1 }}><Bar value={(v / Math.max(1, stats.byCat[0][1])) * 100} tone="cyan" /></div><span className="mono" style={{ fontSize: 12 }}>{inr(v)}</span></div>
            ))}
            {!stats.byCat.length && <div className="empty">Nothing yet.</div>}
            {stats.income > stats.spend && stats.income > 0 && <div className="tile row" style={{ borderColor: 'rgba(34,197,94,0.5)' }}><Leaf className="c-green" /><div style={{ flex: 1 }}><b className="c-green">{inr(stats.income - stats.spend)} saved</b><div className="t-sub">income minus spending in this period</div></div></div>}
          </div>
        </Hud>
      </div>
      <div className="grid g3">
        <Hud title="Activity by Agent" icon={Users}>
          {agentCounts.length ? <BarChart values={agentCounts.map(([, n]) => n)} labels={agentCounts.map(([id]) => (agentById(id)?.name ?? id).split(' ')[0])} showValues height={210} /> : <div className="empty">Ask AURA something in Chat and the agents involved will appear here.</div>}
        </Hud>
        <Hud title="Goal Progress" icon={Target} action="Manage" onAction={() => nav('/finance')}>
          <div className="stack" style={{ gap: 14 }}>
            {goals.map((g) => {
              const v = Math.round((g.saved / g.target) * 100);
              return <div className="row" key={g.id}><IconBox icon={goalIcons[g.icon]} tone={g.tone} size="sm" /><div style={{ flex: 1 }}><div className="row between" style={{ fontSize: 12.5 }}><span>{g.name}</span><span className="t-sub">{inr(g.saved)}/{inr(g.target)}</span></div><Bar value={v} tone={g.tone} /></div><span className="mono t-sub">{v}%</span></div>;
            })}
            {!goals.length && <div className="empty">No goals yet. Add one in Finance.</div>}
          </div>
        </Hud>
        <Hud title="Wellness" icon={Activity}>
          <div className="grid g2" style={{ gap: 8 }}>
            <div className="tile"><b style={{ fontSize: 20 }}>{loggedDays}</b><div className="t-sub">Days logged</div></div>
            <div className="tile"><b style={{ fontSize: 20 }}>{avgSleep ? `${avgSleep.toFixed(1)} h` : '—'}</b><div className="t-sub">Avg sleep</div></div>
            <div className="tile"><b style={{ fontSize: 20 }}>{avgSteps ? Math.round(avgSteps).toLocaleString('en-IN') : '—'}</b><div className="t-sub">Avg steps</div></div>
          </div>
        </Hud>
      </div>
      <div className="grid auto-stack" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.4fr)' }}>
        <Hud title="Achievements" icon={Trophy}>
          <div className="grid g4" style={{ gap: 8 }}>
            {achievements.map((a) => (
              <div key={a.title} className="tile"><div className="row between"><IconBox icon={a.icon} tone={a.tone} size="sm" /><CheckCircle2 size={14} className="c-green" /></div><b style={{ fontSize: 13, display: 'block', marginTop: 6 }}>{a.title}</b><span className="t-mute">{a.sub}</span></div>
            ))}
          </div>
          {!achievements.length && <div className="empty">Achievements unlock as you use AURA.</div>}
        </Hud>
        <Hud title="Personal Insights" icon={Sparkles} action="Based on your data">
          <div className="grid g3" style={{ gap: 8 }}>
            {insights.map((i) => (
              <div key={i.text} className="tile stack" style={{ gap: 8 }}><IconBox icon={i.icon} tone="blue" /><span style={{ fontSize: 12.5 }}>{i.text}</span><button className="btn sm block" style={{ marginTop: 'auto' }} onClick={() => nav(i.to)}>{i.cta}</button></div>
            ))}
          </div>
          {!insights.length && <div className="empty">Add tasks, spending and wellness logs to get insights.</div>}
        </Hud>
      </div>
      <SyncStatus stores={[tasksStore, transactionsStore, goalsStore, bookingsStore, dayLogsStore, budgetsStore]} />
    </>
  );
}

/* =================== THANK YOU (ref 15) =================== */

export function ThankYou() {
  const nav = useNavigate();
  return (
    <>
      <div className="with-rail" style={{ gridTemplateColumns: 'minmax(0,1fr) 420px' }}>
        <div className="stack">
          <div className="hero ty-hero" style={{ alignItems: 'flex-start', padding: 0 }}>
            <div className="city" aria-hidden />
            <img className="scene" src="/aura/thankyou-scene.jpg" alt="AURA android seated at a desk in a night-city office" />
            <div style={{ flex: 1, textAlign: 'center', padding: '56px 28px 40px', marginLeft: 'min(38%, 360px)' }}>
              <h1 className="grad-cyan" style={{ fontSize: 'clamp(48px, 6.4vw, 92px)', lineHeight: 1 }}>Thank You</h1>
              <p style={{ fontSize: 'clamp(22px, 2.4vw, 32px)', marginTop: 10 }}>For Exploring AURA</p>
              <p className="hero-quote" style={{ textAlign: 'center', marginTop: 22, fontSize: 21 }}>“More than an AI —<br />a partner in your everyday life.”</p>
              <div className="row wrap" style={{ justifyContent: 'center', gap: 26, marginTop: 30 }}>
                {[[Rocket, 'More Productive'], [Heart, 'More Balanced'], [Brain, 'More Informed'], [Leaf, 'A Better You']].map(([I, l]) => {
                  const Ic = I as typeof Heart;
                  return <div key={l as string} className="stack" style={{ alignItems: 'center', gap: 8, width: 92 }}><Ic size={36} strokeWidth={1.4} className="c-cyan" style={{ filter: 'drop-shadow(0 0 8px var(--aura-cyan))' }} /><span style={{ fontSize: 14, color: '#bfe9ff' }}>{l as string}</span></div>;
                })}
              </div>
            </div>
          </div>
          <div className="grid g3">
            <Hud corners><div className="row"><IconBox icon={Zap} tone="blue" size="lg" /><div><b style={{ fontSize: 16 }}>One Platform</b><div className="t-sub">All your apps, tasks, and goals in one place.</div></div></div></Hud>
            <Hud corners glow="violet"><div className="row"><IconBox icon={UsersRound} tone="violet" size="lg" /><div><b style={{ fontSize: 16 }}>Smarter Decisions</b><div className="t-sub">Personalized insights for a better you.</div></div></div></Hud>
            <Hud corners glow="cyan"><div className="row"><IconBox icon={InfinityIcon} tone="teal" size="lg" /><div><b style={{ fontSize: 16 }}>Endless Possibilities</b><div className="t-sub">A growing ecosystem of agents to support every part of your life.</div></div></div></Hud>
          </div>
        </div>
        <div className="stack">
          <Hud corners title={<span style={{ fontSize: 22 }}>Next Steps</span>} icon={ArrowRight}>
            <div className="stack" style={{ gap: 6 }}>
              {[['Try AURA', 'Start with your favorite agents and explore the possibilities.', '/dashboard', '#19E6FF'], ['Customize', 'Set your preferences, connect your apps, and make it truly yours.', '/onboarding', '#8B5CFF'], ['Upgrade (Optional)', 'Unlock Pro features for more power, more agents, and unlimited possibilities.', '/pricing', '#00E5A8']].map(([t, s, to, col], i, arr) => (
                <button key={t} className="row" style={{ background: 'none', border: 0, textAlign: 'left', alignItems: 'stretch', gap: 16 }} onClick={() => nav(to)}>
                  <div className="stack" style={{ alignItems: 'center', gap: 0 }}>
                    <span style={{ width: 52, height: 52, borderRadius: '50%', display: 'grid', placeItems: 'center', border: `2.5px solid ${col}`, boxShadow: `0 0 14px ${col}`, fontSize: 22, fontWeight: 700, color: '#fff', flexShrink: 0 }}>{i + 1}</span>
                    {i < arr.length - 1 && <span style={{ flex: 1, width: 0, borderLeft: `2px dashed ${col}88`, minHeight: 24 }} />}
                  </div>
                  <div style={{ paddingTop: 4, paddingBottom: 14 }}><b style={{ fontSize: 17 }}>{t.replace(' (Optional)', '')}{t.includes('Optional') && <span className="c-cyan"> (Optional)</span>}</b><div className="t-sub" style={{ fontSize: 13.5 }}>{s}</div></div>
                </button>
              ))}
            </div>
          </Hud>
          <button className="hud glow-violet row" style={{ textAlign: 'left', padding: 20 }} onClick={() => nav('/pricing')}><Crown className="c-amber" size={34} style={{ filter: 'drop-shadow(0 0 8px var(--aura-warning))' }} /><div style={{ flex: 1 }}><b style={{ fontSize: 17 }}>Unlock Your Full Potential</b><div className="t-sub">Upgrade to AURA Pro and get access to advanced agents, deeper insights, and a smarter everyday life.</div></div><ChevronRight /></button>
          <Hud corners>
            <div className="row" style={{ marginBottom: 14 }}><IconBox icon={Send} tone="blue" size="lg" round /><div><b style={{ fontSize: 17 }}>Let's Stay Connected</b><div className="t-sub">We'd love to hear from you. Share feedback, request features, or just say hi!</div></div></div>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(4,1fr)', gap: 8 }}>
              {[[Mail, 'Email Us'], [LifeBuoy, 'Support'], [Globe, 'Visit Website'], [UsersRound, 'Community']].map(([I, l]) => {
                const Ic = I as typeof Mail;
                return <button key={l as string} className="tile stack" style={{ alignItems: 'center', gap: 8, padding: '12px 4px' }} onClick={() => toast(`${l as string} isn't configured for this deployment yet.`)}><Ic size={26} strokeWidth={1.5} /><span style={{ fontSize: 11.5 }}>{l as string}</span></button>;
              })}
            </div>
          </Hud>
        </div>
      </div>
    </>
  );
}
