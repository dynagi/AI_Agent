import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Leaf, ClipboardList, Bell, BarChart3, Flower2, LayoutDashboard, Dumbbell, Utensils, Brain, Moon, HeartPulse, Target, ClipboardCheck, Mic,
  GlassWater, Pill, Smile, Sun, Plus, Pause, Play, Activity, Droplets,
} from 'lucide-react';
import { Hud, PageHero, NeonButton, NeonTabs, FilterDropdown, FuturisticModal, HudInput, SyncStatus, Bar, toast, toneHex, type Tone } from '../components/aura';
import { AICommandPanel, domainAsk } from '../components/ai';
import { PlanRow, MetricRow, MealRow } from '../components/wellness';
import { VibeCard, XPCard, QuestsCard, JourneyStrip } from '../components/wellness/WorldCards';
import { AchievementsCard, RecordsCard } from '../components/wellness/Achievements';
import { MorningMode, WindDownMode } from '../components/wellness/DayModes';
import Garden from '../components/wellness/Garden';
import { TARGETS, type DayLog, type PlanArea, type PlanItem, type WellnessIcon } from '../data/wellness';
import { cycleStats } from '../data/cycle';
import { computeVibe, computeXP, computeQuests, computeAchievements, computeRecords } from '../data/wellnessWorld';
import NextDoseCard from '../components/wellness/NextDoseCard';
import MedicineTab from '../components/wellness/MedicineTab';
import PeriodTab from '../components/wellness/PeriodTab';
import { wellnessPlanStore, metricsStore, dayLogsStore, mealsStore, habitsStore, periodStore, wellnessEventsStore } from '../state/stores';
import { uid } from '../state/store';
import { usePageSearch, matches } from '../state/search';
import { useShowPeriodTracker } from '../state/user';

const TABS = ['Overview', 'Fitness', 'Nutrition', 'Mindfulness', 'Sleep', 'Health Metrics', 'Habit Tracker', 'Medicines', 'Period Tracker', 'Wellness Plan'] as const;
type Tab = (typeof TABS)[number];
const tabIcons = { Overview: LayoutDashboard, Fitness: Dumbbell, Nutrition: Utensils, Mindfulness: Flower2, Sleep: Moon, 'Health Metrics': HeartPulse, 'Habit Tracker': Target, Medicines: Pill, 'Period Tracker': Droplets, 'Wellness Plan': ClipboardCheck };
const AREAS: PlanArea[] = ['Mindfulness', 'Fitness', 'Nutrition', 'Sleep'];
const areaIcon: Record<PlanArea, WellnessIcon> = { Mindfulness: 'flame', Fitness: 'dumbbell', Nutrition: 'utensils', Sleep: 'moon' };
const areaTone: Record<PlanArea, Tone> = { Mindfulness: 'red', Fitness: 'magenta', Nutrition: 'cyan', Sleep: 'violet' };
const MEAL_NAMES = ['Breakfast', 'Lunch', 'Snack', 'Dinner'];

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayIso = (offset: number) => { const d = new Date(); d.setDate(d.getDate() + offset); return iso(d); };
const weekDates = (weeksBack: number) => {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) - weeksBack * 7);
  return Array.from({ length: 7 }, (_, i) => { const x = new Date(d); x.setDate(d.getDate() + i); return iso(x); });
};
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const pct = (v: number | undefined, target: number) => Math.min(100, Math.round(((v ?? 0) / target) * 100));

function WeeklyChart({ logs, dates }: { logs: Map<string, DayLog>; dates: string[] }) {
  const H = 200, W = 420, pad = 26, slot = (W - pad) / 7, bw = 7;
  const rows = dates.map((d) => logs.get(d));
  const series = [[rows.map((l) => pct(l?.steps, TARGETS.steps)), '#00E5A8', 'Steps'], [rows.map((l) => pct(l?.calories, TARGETS.calories)), '#FF4FD8', 'Calories'], [rows.map((l) => pct(l?.sleepHours, TARGETS.sleepHours)), '#8B5CFF', 'Sleep']] as const;
  return (
    <svg viewBox={`0 0 ${W} ${H + 22}`} className="chart-svg" role="img" aria-label="Weekly steps, calories and sleep as a percentage of daily targets">
      {[0, 25, 50, 75, 100].map((v) => <g key={v}><line x1={pad} x2={W} y1={H - (v / 100) * (H - 10)} y2={H - (v / 100) * (H - 10)} stroke="rgba(0,174,255,0.08)" /><text x={0} y={H - (v / 100) * (H - 10) + 4}>{v}</text></g>)}
      {DAY_LABELS.map((d, i) => (
        <g key={d}>
          {series.map(([vals, c, name], k) => {
            const h = (vals[i] / 100) * (H - 10);
            return <rect key={k} x={pad + slot * i + slot / 2 - 12 + k * (bw + 2)} y={H - h} width={bw} height={h} rx="2" fill={c} style={{ filter: `drop-shadow(0 0 4px ${c})` }}><title>{`${d} ${name}: ${vals[i]}% of target`}</title></rect>;
          })}
          <text x={pad + slot * i + slot / 2} y={H + 16} textAnchor="middle">{d}</text>
        </g>
      ))}
    </svg>
  );
}

function Breathing({ minutes, title, onClose, onFinish }: { minutes: number; title: string; onClose: () => void; onFinish: (minutes: number) => void }) {
  const [left, setLeft] = useState(minutes * 60);
  const [run, setRun] = useState(true);
  useEffect(() => {
    if (!run || left <= 0) return;
    const t = setTimeout(() => setLeft((l) => l - 1), 1000);
    return () => clearTimeout(t);
  }, [run, left]);
  const phase = Math.floor(left / 4) % 2 ? 'Breathe in' : 'Breathe out';
  return (
    <FuturisticModal title={title} icon={Flower2} onClose={onClose}>
      <div className="stack" style={{ alignItems: 'center', gap: 16, padding: 10 }}>
        <div className="breath" style={{ animationPlayState: run ? 'running' : 'paused' }} aria-hidden />
        <div className="t-title" style={{ fontSize: 20 }} aria-live="polite">{left > 0 ? phase : 'Session complete'}</div>
        <div className="mono" style={{ fontSize: 28 }}>{String(Math.floor(left / 60)).padStart(2, '0')}:{String(left % 60).padStart(2, '0')}</div>
        <div className="row">
          <NeonButton icon={run ? Pause : Play} onClick={() => setRun((r) => !r)} disabled={left <= 0}>{run ? 'Pause' : 'Resume'}</NeonButton>
          <NeonButton variant="primary" onClick={() => { onClose(); onFinish(minutes); toast(`🧘 Mind reset. ${title} finished. +15 XP`); }}>Finish</NeonButton>
        </div>
      </div>
    </FuturisticModal>
  );
}

export default function Wellness() {
  const q = usePageSearch();
  const plan = wellnessPlanStore.use();
  const metrics = metricsStore.use();
  const logs = dayLogsStore.use();
  const allMeals = mealsStore.use();
  const habits = habitsStore.use();
  const periods = periodStore.use();
  const events = wellnessEventsStore.use();
  const showPeriod = useShowPeriodTracker();
  const [params] = useSearchParams();
  const [tabRaw, setTab] = useState<Tab>(() => { const t = params.get('tab'); return (TABS as readonly string[]).includes(t ?? '') ? (t as Tab) : 'Overview'; });
  const visibleTabs: readonly Tab[] = showPeriod ? TABS : TABS.filter((t) => t !== 'Period Tracker');
  const tab: Tab = visibleTabs.includes(tabRaw) ? tabRaw : 'Overview';
  const [week, setWeek] = useState<'This Week' | 'Last Week'>('This Week');
  const [session, setSession] = useState<{ title: string; minutes: number } | null>(null);
  const [dialog, setDialog] = useState<'meal' | 'mood' | 'plan' | 'stats' | 'metric' | 'habit' | null>(null);
  const [dayMode, setDayMode] = useState<'morning' | 'winddown' | null>(null);
  const [mealForm, setMealForm] = useState({ name: 'Breakfast', dish: '', kcal: '' });
  const [planForm, setPlanForm] = useState({ time: '7:00 AM', title: '', sub: '', area: 'Fitness' as PlanArea });
  const [statsForm, setStatsForm] = useState({ steps: '', calories: '', sleepHours: '', workoutMin: '' });
  const [metricForm, setMetricForm] = useState({ name: '', value: '', status: '' });
  const [habitName, setHabitName] = useState('');

  const today = dayIso(0);
  const cycle = useMemo(() => cycleStats(periods, today), [periods, today]);
  const logMap = useMemo(() => new Map(logs.map((l) => [l.date, l])), [logs]);
  const todayLog = logMap.get(today);
  const meals = allMeals.filter((m) => m.date === today);
  const kcal = meals.filter((m) => m.eaten).reduce((s, m) => s + m.kcal, 0);
  const water = todayLog?.water ?? 0;
  const mood = todayLog?.mood ?? null;

  const upsertLog = (patch: Partial<DayLog>) => dayLogsStore.set((ls) => (ls.some((l) => l.date === today) ? ls.map((l) => (l.date === today ? { ...l, ...patch } : l)) : [...ls, { id: `log_${today}`, date: today, ...patch }]));

  const show = (...tabs: Tab[]) => tab === 'Overview' || tabs.includes(tab);
  const areaFor: Partial<Record<Tab, PlanArea>> = { Fitness: 'Fitness', Nutrition: 'Nutrition', Mindfulness: 'Mindfulness', Sleep: 'Sleep' };
  const isDone = (p: PlanItem) => p.doneOn === today;
  const planItems = plan.filter((p) => (!areaFor[tab] || p.area === areaFor[tab]) && matches(q, p.title, p.sub, p.area));
  const togglePlan = (id: string) => {
    const turningOn = plan.find((p) => p.id === id)?.doneOn !== today;
    wellnessPlanStore.set((ps) => ps.map((p) => (p.id === id ? { ...p, doneOn: p.doneOn === today ? undefined : today } : p)));
    if (turningOn) toast('🔥 Nice work. +5 XP');
  };
  const done = plan.filter(isDone).length;
  const dates = weekDates(week === 'This Week' ? 0 : 1);
  const weekTotals = dates.map((d) => logMap.get(d));
  const hasWeekData = weekTotals.some((l) => l && (l.steps || l.calories || l.sleepHours));

  // ----- AURA Wellness World: Today's Vibe, XP, Quests, Achievements, Records -----
  // All derived from the stores above — nothing new is persisted for these except
  // mindfulness session completions (wellnessEventsStore), which nothing else tracked.
  const meditatedToday = events.some((e) => e.date === today);
  const vibe = useMemo(() => computeVibe({ todayLog, mood, kcalEaten: kcal, planDoneToday: done, planTotal: plan.length }), [todayLog, mood, kcal, done, plan.length]);
  const xp = useMemo(() => computeXP({ logs, habits, meals: allMeals, events, planDoneToday: done }), [logs, habits, allMeals, events, done]);
  const habitsDoneToday = habits.filter((h) => h.done.includes(today)).length;
  const quests = useMemo(() => computeQuests({ water, meditatedToday, planDoneToday: done, planTotal: plan.length, habitsDoneToday, habitsTotal: habits.length }), [water, meditatedToday, done, plan.length, habitsDoneToday, habits.length]);
  const achievements = useMemo(() => computeAchievements({ logs, habits, meals: allMeals, events }), [logs, habits, allMeals, events]);
  const records = useMemo(() => computeRecords({ logs, habits, events }), [logs, habits, events]);
  const todaysWins = [
    water >= TARGETS.water ? 'Hydration' : null,
    meditatedToday ? 'Mindfulness' : null,
    (todayLog?.steps ?? 0) >= TARGETS.steps || (todayLog?.workoutMin ?? 0) > 0 ? 'Movement' : null,
    done > 0 ? 'Plan progress' : null,
  ].filter((w): w is string => !!w);
  const goToTab = (t: Tab) => setTab(t);

  const ai = domainAsk('wellness', () => JSON.stringify({
    today, plan: plan.map((p) => ({ time: p.time, title: p.title, area: p.area, doneToday: isDone(p) })), meals: meals.map((m) => ({ meal: m.name, dish: m.dish, kcal: m.kcal, eaten: m.eaten })),
    todayLog: todayLog ?? null, last7Days: dates.map((d) => logMap.get(d)).filter(Boolean), ...(showPeriod ? { periodLog: periods.slice(-6).map((p) => ({ start: p.start, end: p.end, flow: p.flow })), estimatedCycleLength: cycle.cycleLen } : {}), habits: habits.map((h) => ({ name: h.name, doneDays: h.done.length })),
    note: 'Give general wellness guidance only. Do not diagnose medical conditions.',
  }));

  const submitMeal = (e: React.FormEvent) => {
    e.preventDefault();
    if (!mealForm.dish.trim()) return toast('Describe what you ate.');
    mealsStore.set((ms) => [...ms, { id: uid('ml'), name: mealForm.name, dish: mealForm.dish.trim(), kcal: Math.max(0, Number(mealForm.kcal) || 0), eaten: true, date: today }]);
    setDialog(null); setMealForm({ name: 'Breakfast', dish: '', kcal: '' });
    toast('🍎 Fuel logged. +5 XP');
  };
  const submitPlan = (e: React.FormEvent) => {
    e.preventDefault();
    if (!planForm.title.trim()) return;
    wellnessPlanStore.set((ps) => [...ps, { id: uid('w'), time: planForm.time, title: planForm.title.trim(), sub: planForm.sub.trim() || planForm.area, icon: areaIcon[planForm.area], tone: areaTone[planForm.area], area: planForm.area }]);
    setDialog(null); setPlanForm({ time: '7:00 AM', title: '', sub: '', area: 'Fitness' });
    toast('Added to your plan.');
  };
  const submitStats = (e: React.FormEvent) => {
    e.preventDefault();
    const num = (s: string) => (s.trim() === '' ? undefined : Math.max(0, Number(s)));
    upsertLog({ steps: num(statsForm.steps) ?? todayLog?.steps, calories: num(statsForm.calories) ?? todayLog?.calories, sleepHours: num(statsForm.sleepHours) ?? todayLog?.sleepHours, workoutMin: num(statsForm.workoutMin) ?? todayLog?.workoutMin });
    setDialog(null); setStatsForm({ steps: '', calories: '', sleepHours: '', workoutMin: '' });
    toast('Today\'s stats saved.');
  };
  const submitMetric = (e: React.FormEvent) => {
    e.preventDefault();
    if (!metricForm.name.trim() || !metricForm.value.trim()) return;
    metricsStore.set((ms) => [...ms, { id: uid('m'), name: metricForm.name.trim(), value: metricForm.value.trim(), status: metricForm.status.trim(), icon: 'activity', tone: 'teal', good: true }]);
    setDialog(null); setMetricForm({ name: '', value: '', status: '' });
    toast('Metric saved.');
  };
  const weekDays = weekDates(0);
  const toggleHabit = (id: string, date: string) => {
    const habit = habits.find((h) => h.id === id);
    const turningOn = habit && !habit.done.includes(date);
    habitsStore.set((hs) => hs.map((h) => (h.id === id ? { ...h, done: h.done.includes(date) ? h.done.filter((d) => d !== date) : [...h.done, date] } : h)));
    if (turningOn && date === today) toast('🌱 Your garden grew! +10 XP');
  };

  return (
    <div className="module">
      <div className="main">
        <PageHero title={<>Wellness <span className="grad">Smarter</span><br />with <span className="grad">AURA</span></>} lead="Track your routines and get personalized wellness guidance." image="/aura/hero-wellness.jpg" imageWidth="26%" quote="A Healthier You. A Brighter Tomorrow."
          feats={[
            { icon: Leaf, title: 'Track Health', sub: 'All in one place', tone: 'teal' },
            { icon: ClipboardList, title: 'Personalized Plans', sub: 'AI-powered', tone: 'magenta' },
            { icon: Bell, title: 'Routines', sub: 'Stay consistent', tone: 'teal' },
            { icon: BarChart3, title: 'Insights', sub: 'Track progress', tone: 'violet' },
            { icon: Flower2, title: 'Holistic Wellness', sub: 'Mind • Body • Life', tone: 'teal' },
          ]}>
          <div className="row wrap" style={{ gap: 10, marginTop: 14 }}>
            <NeonButton icon={Sun} onClick={() => setDayMode('morning')}>Morning check-in</NeonButton>
            <NeonButton icon={Moon} onClick={() => setDayMode('winddown')}>Wind down</NeonButton>
          </div>
        </PageHero>

        <NeonTabs wrap tabs={visibleTabs as unknown as typeof TABS} value={tab} onChange={setTab} icons={tabIcons} />

        {tab === 'Medicines' ? (
          <MedicineTab />
        ) : tab === 'Period Tracker' ? (
          <PeriodTab />
        ) : tab === 'Habit Tracker' ? (
          <Hud corners title="Habit Tracker" sub="Tap a day to mark it done." action="Add habit" onAction={() => setDialog('habit')}>
            <b style={{ fontSize: 13, display: 'block', marginBottom: 4 }}>🌷 Your Wellness Garden</b>
            <Garden habits={habits} weekDays={weekDays} />
            <div className="table-scroll">
              <table className="data-table">
                <thead><tr><th>Habit</th>{DAY_LABELS.map((d) => <th key={d} style={{ textAlign: 'center' }}>{d}</th>)}<th style={{ textAlign: 'right' }}>This week</th></tr></thead>
                <tbody>{habits.map((h) => (
                  <tr key={h.id}><td>{h.name}</td>{weekDays.map((d, i) => (
                    <td key={d} style={{ textAlign: 'center' }}><input type="checkbox" className="check" checked={h.done.includes(d)} disabled={d > today} onChange={() => toggleHabit(h.id, d)} aria-label={`${h.name} on ${DAY_LABELS[i]}`} /></td>
                  ))}<td style={{ textAlign: 'right' }} className="mono">{weekDays.filter((d) => h.done.includes(d)).length}/7</td></tr>
                ))}</tbody>
              </table>
            </div>
            {!habits.length && <div className="empty">No habits yet. Add one to start tracking.</div>}
          </Hud>
        ) : (
          <>
            {tab === 'Overview' && (
              <div className="stack" style={{ gap: 16, marginBottom: 16 }}>
                <VibeCard vibe={vibe} mood={mood} />
                <NextDoseCard onOpen={() => setTab('Medicines')} />
                {(mood === 'Stressed' || mood === 'Low') && (
                  <button className="tile row" style={{ gap: 10, width: '100%', textAlign: 'left', ['--bd' as string]: `${toneHex.amber}88` }} onClick={() => setSession({ title: '3 min Stress Relief', minutes: 3 })}>
                    <Sun size={22} style={{ color: toneHex.amber }} />
                    <span style={{ flex: 1 }}>Feeling {mood.toLowerCase()}? A 3-minute Stress Relief session might help.</span>
                  </button>
                )}
                <Hud corners><JourneyStrip bars={vibe.bars} /></Hud>
                <div className="grid g2" style={{ gap: 16 }}>
                  <XPCard xp={xp} />
                  <QuestsCard quests={quests} onGoto={goToTab} />
                </div>
                <div className="grid g2" style={{ gap: 16 }}>
                  <AchievementsCard achievements={achievements} />
                  <RecordsCard records={records} />
                </div>
              </div>
            )}
          <div className="grid wellness-grid">
            {(show('Fitness', 'Nutrition', 'Mindfulness', 'Sleep', 'Wellness Plan')) && (
              <Hud corners className="w-plan" title={<span className="section-title" style={{ fontSize: 20 }}>Today's Wellness Plan</span>} action={`${done}/${plan.length} done`}>
                <div>{planItems.map((p, i) => <PlanRow key={p.id} item={p} done={isDone(p)} last={i === planItems.length - 1} onToggle={() => togglePlan(p.id)} />)}</div>
                {!planItems.length && <div className="empty">{plan.length ? 'Nothing in this area yet.' : 'Your plan is empty. Add routines like workouts, meals or meditation.'}</div>}
                <NeonButton icon={Plus} block onClick={() => setDialog('plan')}>Add to plan</NeonButton>
              </Hud>
            )}
            {show('Fitness', 'Sleep') && (
              <Hud corners>
                <div className="row between" style={{ marginBottom: 8 }}>
                  <h2 className="section-title" style={{ fontSize: 20 }}>Weekly Progress</h2>
                  <FilterDropdown value={week} options={['This Week', 'Last Week'] as const} onChange={setWeek} align="right" />
                </div>
                {hasWeekData ? <WeeklyChart logs={logMap} dates={dates} /> : <div className="empty">No stats logged for this week. Use “Log Stats” to add steps, calories and sleep.</div>}
                <div className="row" style={{ justifyContent: 'center', gap: 16, fontSize: 13 }}>
                  {[['Steps', '#00E5A8'], ['Calories', '#FF4FD8'], ['Sleep', '#8B5CFF']].map(([l, c]) => <span key={l} className="row" style={{ gap: 6 }}><span className="dot" style={{ background: c, color: c }} /> {l}</span>)}
                </div>
                <p className="t-mute" style={{ textAlign: 'center' }}>% of daily targets: {TARGETS.steps.toLocaleString('en-IN')} steps · {TARGETS.calories} kcal · {TARGETS.sleepHours} h sleep</p>
              </Hud>
            )}
            {show('Health Metrics') && (
              <Hud corners title={<span className="section-title" style={{ fontSize: 20 }}>Health Metrics</span>} action="Add" onAction={() => setDialog('metric')}>
                <div className="list">{metrics.filter((m) => matches(q, m.name)).map((m) => <MetricRow key={m.id} m={m} onRemove={() => metricsStore.set((ms) => ms.filter((x) => x.id !== m.id))} />)}</div>
                {!metrics.length && <div className="empty">No metrics yet. Add readings such as weight or resting heart rate.</div>}
                <p className="t-mute" style={{ marginTop: 6 }}>Self-reported values. Not a medical diagnosis.</p>
              </Hud>
            )}
            {show('Mindfulness') && (
              <Hud corners title={<span className="section-title" style={{ fontSize: 20 }}>Mindfulness</span>}>
                <div className="grid g2" style={{ gap: 10 }}>
                  {([[Leaf, '5 min', 'Breathing', 'teal', 5], [Flower2, '10 min', 'Meditation', 'violet', 10], [Moon, '15 min', 'Wind-down', 'blue', 15], [Sun, '3 min', 'Stress Relief', 'amber', 3]] as const).map(([I, a, b, tone, min]) => (
                    <button key={b} className="tile row" style={{ gap: 10, ['--bd' as string]: `${toneHex[tone as Tone]}88` }} onClick={() => setSession({ title: `${a} ${b}`.trim(), minutes: min })}>
                      <I size={26} style={{ color: toneHex[tone as Tone] }} /><span style={{ textAlign: 'left' }}><b>{a}</b><br /><span className="t-sub">{b}</span></span>
                    </button>
                  ))}
                </div>
              </Hud>
            )}
            {show('Nutrition') && (
              <Hud corners title={<span className="section-title" style={{ fontSize: 20 }}>Nutrition Today</span>}>
                <div className="stack" style={{ gap: 12 }}>
                  <div><div className="row between t-sub"><span>Calories eaten</span><b style={{ color: '#fff' }}>{kcal.toLocaleString('en-IN')} / {TARGETS.calories.toLocaleString('en-IN')} kcal</b></div><Bar value={pct(kcal, TARGETS.calories)} tone="cyan" /></div>
                  <div><div className="row between t-sub"><span>Water</span><b style={{ color: '#fff' }}>{water} / {TARGETS.water} glasses</b></div><Bar value={pct(water, TARGETS.water)} tone="blue" /></div>
                </div>
              </Hud>
            )}
          </div>
          </>
        )}
        <SyncStatus stores={[wellnessPlanStore, metricsStore, dayLogsStore, mealsStore, habitsStore, periodStore, wellnessEventsStore]} />
      </div>

      <div className="rail">
        <AICommandPanel title="Ask AURA Wellness" prompts={showPeriod
          ? ['Create a gentle routine for this week', 'What should I add to my care kit?', 'Summarize my logged cycle patterns', 'How can I reduce stress?']
          : ['Create a 7-day workout plan for me', 'Suggest a healthy meal plan', 'How can I reduce stress?', 'Generate a personalized sleep routine']}
          onAsk={ai} cta="Talk to AURA" ctaIcon={Mic} placeholder="Ask about workouts, meals, sleep…" />
        <Hud corners title={<span className="section-title" style={{ fontSize: 20 }}>Today's Meals</span>} action="Log meal" onAction={() => setDialog('meal')}>
          <div className="list">{meals.map((m) => <MealRow key={m.id} meal={m} onToggle={() => mealsStore.set((ms) => ms.map((x) => (x.id === m.id ? { ...x, eaten: !x.eaten } : x)))} onRemove={() => mealsStore.set((ms) => ms.filter((x) => x.id !== m.id))} />)}</div>
          {!meals.length && <div className="empty">No meals logged today.</div>}
        </Hud>
        <Hud corners title={<span className="section-title" style={{ fontSize: 20 }}>Quick Actions</span>}>
          <div className="grid g2" style={{ gap: 10 }}>
            {([
              [Utensils, 'Log Meal', 'red', () => setDialog('meal')],
              [Activity, 'Log Stats', 'violet', () => setDialog('stats')],
              [GlassWater, `Log Water (${water}/${TARGETS.water})`, 'blue', () => { const next = Math.min(TARGETS.water, water + 1); upsertLog({ water: next }); toast(next >= TARGETS.water ? `💧 +1 — hydration goal reached! +10 XP` : `💧 +1 · ${next}/${TARGETS.water} glasses`); }],
              [Smile, mood ? `Mood: ${mood}` : 'Log Mood', 'magenta', () => setDialog('mood')],
            ] as const).map(([I, l, tone, fn]) => (
              <button key={l} className="tile stack" style={{ alignItems: 'center', gap: 6, ['--bd' as string]: `${toneHex[tone as Tone]}88` }} onClick={fn}>
                <I size={24} style={{ color: toneHex[tone as Tone] }} /><span style={{ fontSize: 12.5 }}>{l}</span>
              </button>
            ))}
          </div>
        </Hud>
      </div>

      {session && <Breathing {...session} onClose={() => setSession(null)} onFinish={(minutes) => wellnessEventsStore.set((es) => [...es, { id: uid('we'), type: 'mindfulness', date: today, minutes }])} />}
      {dayMode === 'morning' && <MorningMode todayLog={todayLog} plan={plan} onClose={() => setDayMode(null)} />}
      {dayMode === 'winddown' && (
        <WindDownMode
          mood={mood}
          onSetMood={(m) => { upsertLog({ mood: m }); toast(`Mood logged: ${m}.`); }}
          wins={todaysWins}
          onClose={() => setDayMode(null)}
          onBreathe={() => { setDayMode(null); setSession({ title: '15 min Wind-down', minutes: 15 }); }}
        />
      )}
      {dialog === 'meal' && (
        <FuturisticModal title="Log Meal" icon={Utensils} onClose={() => setDialog(null)}>
          <form className="stack" style={{ gap: 12 }} onSubmit={submitMeal}>
            <div className="field"><label htmlFor="ml-name">Meal</label><select id="ml-name" className="select" style={{ height: 44 }} value={mealForm.name} onChange={(e) => setMealForm({ ...mealForm, name: e.target.value })}>{MEAL_NAMES.map((m) => <option key={m}>{m}</option>)}</select></div>
            <HudInput label="What did you eat?" value={mealForm.dish} onChange={(e) => setMealForm({ ...mealForm, dish: e.target.value })} placeholder="e.g. Oats with fruit" autoFocus />
            <HudInput label="Calories (optional)" type="number" min={0} value={mealForm.kcal} onChange={(e) => setMealForm({ ...mealForm, kcal: e.target.value })} />
            <div className="row" style={{ justifyContent: 'flex-end' }}><NeonButton type="button" onClick={() => setDialog(null)}>Cancel</NeonButton><NeonButton type="submit" variant="primary">Log</NeonButton></div>
          </form>
        </FuturisticModal>
      )}
      {dialog === 'mood' && (
        <FuturisticModal title="How are you feeling?" icon={Smile} onClose={() => setDialog(null)}>
          <div className="seg">{['Great', 'Good', 'Okay', 'Low', 'Stressed'].map((m) => <button key={m} className={`chip ${mood === m ? 'active' : ''}`} onClick={() => { upsertLog({ mood: m }); setDialog(null); toast(`Mood logged: ${m}.`); }}>{m}</button>)}</div>
        </FuturisticModal>
      )}
      {dialog === 'stats' && (
        <FuturisticModal title="Log today's stats" icon={Activity} onClose={() => setDialog(null)}>
          <form className="stack" style={{ gap: 12 }} onSubmit={submitStats}>
            <HudInput label="Steps" type="number" min={0} value={statsForm.steps} onChange={(e) => setStatsForm({ ...statsForm, steps: e.target.value })} placeholder={todayLog?.steps ? String(todayLog.steps) : ''} autoFocus />
            <HudInput label="Calories (kcal)" type="number" min={0} value={statsForm.calories} onChange={(e) => setStatsForm({ ...statsForm, calories: e.target.value })} placeholder={todayLog?.calories ? String(todayLog.calories) : ''} />
            <HudInput label="Sleep last night (hours)" type="number" min={0} step="0.5" value={statsForm.sleepHours} onChange={(e) => setStatsForm({ ...statsForm, sleepHours: e.target.value })} placeholder={todayLog?.sleepHours ? String(todayLog.sleepHours) : ''} />
            <HudInput label="Workout (minutes)" type="number" min={0} value={statsForm.workoutMin} onChange={(e) => setStatsForm({ ...statsForm, workoutMin: e.target.value })} placeholder={todayLog?.workoutMin ? String(todayLog.workoutMin) : ''} />
            <div className="row" style={{ justifyContent: 'flex-end' }}><NeonButton type="button" onClick={() => setDialog(null)}>Cancel</NeonButton><NeonButton type="submit" variant="primary">Save</NeonButton></div>
          </form>
        </FuturisticModal>
      )}
      {dialog === 'plan' && (
        <FuturisticModal title="Add to Wellness Plan" icon={Brain} onClose={() => setDialog(null)}>
          <form className="stack" style={{ gap: 12 }} onSubmit={submitPlan}>
            <HudInput label="Activity" value={planForm.title} onChange={(e) => setPlanForm({ ...planForm, title: e.target.value })} placeholder="e.g. Morning walk" autoFocus />
            <HudInput label="Details (optional)" value={planForm.sub} onChange={(e) => setPlanForm({ ...planForm, sub: e.target.value })} placeholder="e.g. 20 minutes" />
            <HudInput label="Time" value={planForm.time} onChange={(e) => setPlanForm({ ...planForm, time: e.target.value })} />
            <div className="field"><label>Area</label><div className="seg">{AREAS.map((a) => <button type="button" key={a} className={`chip ${planForm.area === a ? 'active' : ''}`} onClick={() => setPlanForm({ ...planForm, area: a })}>{a}</button>)}</div></div>
            <div className="row" style={{ justifyContent: 'flex-end' }}><NeonButton type="button" onClick={() => setDialog(null)}>Cancel</NeonButton><NeonButton type="submit" variant="primary">Add</NeonButton></div>
          </form>
        </FuturisticModal>
      )}
      {dialog === 'metric' && (
        <FuturisticModal title="Add health metric" icon={HeartPulse} onClose={() => setDialog(null)}>
          <form className="stack" style={{ gap: 12 }} onSubmit={submitMetric}>
            <HudInput label="Metric" value={metricForm.name} onChange={(e) => setMetricForm({ ...metricForm, name: e.target.value })} placeholder="e.g. Weight" autoFocus />
            <HudInput label="Value" value={metricForm.value} onChange={(e) => setMetricForm({ ...metricForm, value: e.target.value })} placeholder="e.g. 68.5 kg" />
            <HudInput label="Note (optional)" value={metricForm.status} onChange={(e) => setMetricForm({ ...metricForm, status: e.target.value })} placeholder="e.g. -0.5 kg" />
            <div className="row" style={{ justifyContent: 'flex-end' }}><NeonButton type="button" onClick={() => setDialog(null)}>Cancel</NeonButton><NeonButton type="submit" variant="primary">Save</NeonButton></div>
          </form>
        </FuturisticModal>
      )}
      {dialog === 'habit' && (
        <FuturisticModal title="New habit" icon={Target} onClose={() => setDialog(null)}>
          <form className="stack" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); if (!habitName.trim()) return; habitsStore.set((hs) => [...hs, { id: uid('hb'), name: habitName.trim(), done: [] }]); setHabitName(''); setDialog(null); }}>
            <HudInput label="Habit" value={habitName} onChange={(e) => setHabitName(e.target.value)} placeholder="e.g. Meditate 10 min" autoFocus />
            <div className="row" style={{ justifyContent: 'flex-end' }}><NeonButton type="button" onClick={() => setDialog(null)}>Cancel</NeonButton><NeonButton type="submit" variant="primary">Add</NeonButton></div>
          </form>
        </FuturisticModal>
      )}
    </div>
  );
}
