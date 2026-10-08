import { useMemo, useState, type FormEvent } from 'react';
import { AlertTriangle, CalendarClock, CheckCircle2, Info, Landmark, Pencil, PiggyBank, Plus, Scale, Trash2, Wallet } from 'lucide-react';
import { Hud, IconBox, NeonButton, FuturisticModal, HudInput, toast } from '../aura';
import { inr } from './index';
import { commitmentsStore, goalsStore, budgetsStore, moneyPrefsStore, transactionsStore } from '../../state/stores';
import { uid } from '../../state/store';
import { commitmentTemplates, DEFAULT_MONEY_PREFS, kindLabel, type Commitment, type CommitmentKind, type Frequency, type MoneyPrefs } from '../../data/commitments';
import { canAfford, type Affordability, type MoneyPlan as Plan, type PlanInput } from '../../services/moneyPlan';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dayLabel = (d: Date) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const ordinal = (n: number) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const levelTone = { high: 'c-red', medium: 'c-amber', info: 'c-blue' } as const;

/** The plan, from the user's own stores. Shared with the voice companion through buildPlan(). */
export function usePlanInput(): PlanInput {
  const transactions = transactionsStore.use();
  const commitments = commitmentsStore.use();
  const goals = goalsStore.use();
  const budgets = budgetsStore.use();
  const prefs = moneyPrefsStore.use()[0];
  return useMemo(() => ({ now: new Date(), transactions, commitments, goals, budgets, prefs }), [transactions, commitments, goals, budgets, prefs]);
}

export default function MoneyPlan({ hide, input, plan }: { hide: boolean; input: PlanInput; plan: Plan }) {
  const [editing, setEditing] = useState<Commitment | 'new' | null>(null);
  const [template, setTemplate] = useState<(typeof commitmentTemplates)[number] | null>(null);
  const [settings, setSettings] = useState(false);
  const [asking, setAsking] = useState('');
  const [answer, setAnswer] = useState<Affordability | null>(null);
  const money = (n: number) => (hide ? '••••' : `${n < 0 ? '-' : ''}${inr(n)}`);
  const { safe, forecast: fc, budget, goals } = plan;

  const check = (e: FormEvent) => {
    e.preventDefault();
    const amt = Number(asking.replace(/,/g, ''));
    if (!(amt > 0)) return toast('Enter an amount above zero.');
    setAnswer(canAfford(input, amt));
  };
  const applyBudgets = () => {
    budgetsStore.set((bs) => {
      const next = [...bs];
      for (const c of budget.categories) {
        if (c.suggested <= 0) continue;
        const i = next.findIndex((b) => b.category === c.category);
        if (i >= 0) next[i] = { ...next[i], limit: c.suggested }; else next.push({ id: uid('bg'), category: c.category, limit: c.suggested });
      }
      return next;
    });
    toast('Budgets updated to fit your income, bills and savings.');
  };
  const createEmergency = () => {
    goalsStore.set((gs) => [...gs, { id: uid('gl'), name: 'Emergency fund', icon: 'target', tone: 'teal', saved: 0, target: goals.emergencyTarget }]);
    toast('Emergency fund goal created.');
  };
  const remove = (c: Commitment) => { commitmentsStore.set((cs) => cs.filter((x) => x.id !== c.id)); toast(`${c.name} removed.`); };

  // ---- forecast chart
  const W = 600, H = 150, PAD = 6;
  const bals = fc.days.map((d) => d.balance);
  const lo = Math.min(...bals, safe.buffer, 0), hi = Math.max(...bals, 1);
  const x = (i: number) => PAD + (i / Math.max(1, fc.days.length - 1)) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - ((v - lo) / (hi - lo || 1)) * (H - 2 * PAD);
  const line = fc.days.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.balance).toFixed(1)}`).join(' ');
  const lowIdx = fc.days.findIndex((d) => d.balance === fc.lowest.balance);

  const incomeList = input.commitments.filter((c) => c.kind === 'income');
  const outList = input.commitments.filter((c) => c.kind !== 'income');

  return (
    <>
      <Hud corners title={<span className="section-title" style={{ fontSize: 20 }}>Your Money Plan</span>} action="Settings" onAction={() => setSettings(true)}>
        {!plan.ready && (
          <div className="tile stack" style={{ gap: 10, marginBottom: 14 }}>
            <div><b>Set up your plan</b><div className="t-sub">Add your salary and your regular payments (rent, EMIs, bills, SIPs). AURA then plans around them: what is safe to spend, what is coming, and what to save.</div></div>
            <div className="row wrap" style={{ gap: 6 }}>
              {commitmentTemplates.map((t) => <button key={t.label} className="chip" onClick={() => { setTemplate(t); setEditing('new'); }}>+ {t.label}</button>)}
            </div>
          </div>
        )}

        <div className="grid g4">
          {([
            [Wallet, 'Safe to spend / day', safe.amount >= 0 ? money(safe.perDay) : 'Over budget', safe.amount >= 0 ? `until ${safe.paydayKnown ? 'payday' : 'month end'} · ${safe.daysToPayday} days` : `${money(safe.amount)} short before payday`, safe.amount >= 0 ? 'green' : 'red'],
            [CalendarClock, 'Free until payday', money(Math.max(0, safe.amount)), `after ${money(safe.dueBefore.reduce((a, e) => a - e.amount, 0))} of bills and a ${money(safe.buffer)} buffer`, 'blue'],
            [Scale, 'Lowest balance, 60 days', money(fc.lowest.balance), `on ${dayLabel(fc.lowest.date)}`, fc.shortfall ? 'red' : 'violet'],
            [PiggyBank, 'Emergency fund', `${goals.emergencyCoverageMonths.toFixed(1)} months`, `target ${money(goals.emergencyTarget)}`, 'teal'],
          ] as const).map(([I, l, v, sub, tone]) => (
            <div className="tile row" key={l} style={{ alignItems: 'flex-start', gap: 12 }}>
              <IconBox icon={I} tone={tone} size="lg" />
              <div style={{ minWidth: 0 }}><div className="t-sub">{l}</div><b style={{ fontSize: 22, fontFamily: 'var(--font-head)' }}>{v}</b><div className="t-sub" style={{ fontSize: 12 }}>{sub}</div></div>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 16 }}>
          <div className="row between"><b>Next 60 days</b><span className="t-sub">balance if you spend as usual ({hide ? '••••' : inr(plan.spending.perDay)}/day)</span></div>
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Projected balance for the next 60 days" style={{ width: '100%', height: 150, marginTop: 6 }}>
            <line x1={PAD} x2={W - PAD} y1={y(safe.buffer)} y2={y(safe.buffer)} stroke="#ff6f9a" strokeDasharray="4 4" strokeWidth="1" />
            <path d={`${line} L${x(fc.days.length - 1)},${H - PAD} L${x(0)},${H - PAD} Z`} fill="rgba(0,175,255,0.12)" />
            <path d={line} fill="none" stroke="#00AFFF" strokeWidth="2" />
            {fc.days.map((d, i) => d.events.some((e) => e.amount > 0) && <circle key={`in${i}`} cx={x(i)} cy={y(d.balance)} r="3.5" fill="#22C55E" />)}
            {lowIdx >= 0 && <circle cx={x(lowIdx)} cy={y(fc.lowest.balance)} r="4" fill={fc.shortfall ? '#ff6f9a' : '#FFC857'} />}
          </svg>
          <div className="row t-sub" style={{ gap: 14, fontSize: 12 }}><span><span style={{ color: '#22C55E' }}>●</span> money in</span><span><span style={{ color: '#ff6f9a' }}>- -</span> your buffer</span><span><span style={{ color: '#FFC857' }}>●</span> lowest point</span></div>
        </div>

        <form className="row wrap" style={{ gap: 8, marginTop: 14 }} onSubmit={check}>
          <HudInput label="Can I afford…? (₹)" type="number" min={1} value={asking} onChange={(e) => { setAsking(e.target.value); setAnswer(null); }} placeholder="e.g. 15000" />
          <NeonButton type="submit" variant="primary">Check</NeonButton>
          {answer && <div className={`row ${answer.ok ? 'c-green' : 'c-red'}`} style={{ gap: 6, flexBasis: '100%' }}>{answer.ok ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}<span style={{ fontSize: 13.5 }}><b>{answer.ok ? 'Yes.' : 'Not right now.'}</b> {answer.reason}</span></div>}
        </form>
      </Hud>

      <div className="grid g2">
        <Hud corners title={<span className="section-title" style={{ fontSize: 20 }}>What to do</span>}>
          {plan.alerts.length === 0 && plan.steps.length === 0 && <div className="empty">Nothing needs attention.</div>}
          <div className="list">
            {plan.alerts.map((a) => (
              <div key={a.id} className="li" style={{ alignItems: 'flex-start' }}>{a.level === 'info' ? <Info size={16} className={levelTone[a.level]} style={{ flexShrink: 0, marginTop: 3 }} /> : <AlertTriangle size={16} className={levelTone[a.level]} style={{ flexShrink: 0, marginTop: 3 }} />}<span style={{ fontSize: 13.5 }}>{a.text}</span></div>
            ))}
            {plan.steps.map((s, i) => <div key={s} className="li" style={{ alignItems: 'flex-start' }}><span className="mono" style={{ minWidth: 18 }}>{i + 1}.</span><span style={{ fontSize: 13.5 }}>{s}</span></div>)}
          </div>
          <p className="t-mute" style={{ marginTop: 8 }}>Planning aid based on what you recorded. Not regulated financial advice; AURA never moves money.</p>
        </Hud>

        <Hud corners title={<span className="section-title" style={{ fontSize: 20 }}>Coming up (14 days)</span>}>
          {plan.upcoming.length === 0 && <div className="empty">Nothing scheduled. Add your rent, bills and salary below.</div>}
          <div className="list">{plan.upcoming.map((e, i) => (
            <div className="li" key={`${e.name}${i}`}><div className="grow"><div className="t-title">{e.name}</div><div className="t-sub">{dayLabel(e.date)} · {kindLabel[e.kind]}</div></div>
              <b style={{ color: e.amount > 0 ? 'var(--aura-green)' : '#ff6f9a' }}>{hide ? '••••' : `${e.amount > 0 ? '+ ' : '- '}${inr(e.amount)}`}</b></div>
          ))}</div>
        </Hud>
      </div>

      <Hud corners title={<span className="section-title" style={{ fontSize: 20 }}>Rent, bills and income</span>} action="Add" onAction={() => { setTemplate(null); setEditing('new'); }}>
        {input.commitments.length === 0 && <div className="empty">Nothing yet. Use Add for salary, rent, EMIs, bills, insurance, SIPs and subscriptions.</div>}
        <div className="list">
          {[...incomeList, ...outList].map((c) => (
            <div className="li" key={c.id}>
              <IconBox icon={c.kind === 'income' ? Landmark : Wallet} tone={c.kind === 'income' ? 'green' : 'amber'} size="sm" />
              <div className="grow"><div className="t-title">{c.name}</div>
                <div className="t-sub">{kindLabel[c.kind]} · {c.frequency === 'weekly' ? `every ${WEEKDAYS[c.day]}` : `${ordinal(c.day)}${c.frequency === 'monthly' ? ' of every month' : ` of ${MONTHS[c.month ?? 0]}${c.frequency === 'quarterly' ? ' (every 3 months)' : ' yearly'}`}`}{c.endsOn ? ` · until ${c.endsOn}` : ''}</div></div>
              <b style={{ color: c.kind === 'income' ? 'var(--aura-green)' : '#fff' }}>{money(c.amount)}</b>
              <button className="icon-btn bare" aria-label={`Edit ${c.name}`} onClick={() => setEditing(c)}><Pencil size={15} /></button>
              <button className="icon-btn bare" aria-label={`Remove ${c.name}`} onClick={() => remove(c)}><Trash2 size={15} /></button>
            </div>
          ))}
        </div>
        {input.commitments.length > 0 && <div className="t-sub" style={{ marginTop: 8 }}>Per month: income {money(budget.income)} · needs {money(budget.needs)} · other fixed {money(budget.wantsFixed)} · savings {money(budget.savings)}</div>}
      </Hud>

      <div className="grid g2">
        <Hud corners title={<span className="section-title" style={{ fontSize: 20 }}>Suggested budgets</span>} action={budget.status === 'no-income' ? undefined : 'Apply'} onAction={applyBudgets}>
          {budget.status === 'no-income' ? <div className="empty">Add your income to get budgets that fit it.</div> : (
            <>
              <div className="t-sub" style={{ marginBottom: 8 }}>{budget.status === 'deficit' ? 'Your bills and savings target are more than your income.' : `${money(budget.pool)} a month is left for everyday spending after bills and ${money(budget.savings)} of savings.`}</div>
              <div className="list">{budget.categories.map((c) => (
                <div className="li" key={c.category}><div className="grow">{c.category}</div>
                  <span className="t-sub" style={{ fontSize: 12 }}>you usually spend {money(c.avg)}{c.current !== null ? ` · now ${money(c.current)}` : ''}</span><b>{money(c.suggested)}</b></div>
              ))}</div>
            </>
          )}
        </Hud>

        <Hud corners title={<span className="section-title" style={{ fontSize: 20 }}>Goals plan</span>}>
          <div className="t-sub" style={{ marginBottom: 8 }}>{goals.surplus > 0 ? `About ${money(goals.surplus)} a month is spare at your current habits.` : 'No spare money at your current habits, so goals can’t be funded yet.'}</div>
          {goals.lines.length === 0 && <div className="empty">Add a goal (with a target date) to see what it needs each month.</div>}
          <div className="list">{goals.lines.map((l) => (
            <div className="li" key={l.goal.id} style={{ alignItems: 'flex-start' }}>
              <div className="grow"><div className="t-title">{l.goal.name}{l.virtual && <span className="tag blue" style={{ marginLeft: 6 }}>recommended</span>}</div>
                <div className="t-sub">{money(l.remaining)} to go{l.monthsLeft ? ` in ${l.monthsLeft} months` : ' (aiming for a year)'} · needs {money(l.required)}/month</div></div>
              <div style={{ textAlign: 'right' }}><b className={l.onTrack ? 'c-green' : 'c-amber'}>{money(l.allocated)}</b><div className="t-sub" style={{ fontSize: 12 }}>{l.remaining === 0 ? 'done' : l.onTrack ? 'on track' : 'behind'}</div></div>
              {l.virtual && <NeonButton icon={Plus} onClick={createEmergency}>Create</NeonButton>}
            </div>
          ))}</div>
        </Hud>
      </div>

      {editing && <CommitmentDialog c={editing === 'new' ? undefined : editing} template={template} onClose={() => { setEditing(null); setTemplate(null); }} />}
      {settings && <SettingsDialog prefs={{ ...DEFAULT_MONEY_PREFS, ...input.prefs }} balance={plan.balance} onClose={() => setSettings(false)} />}
    </>
  );
}

function CommitmentDialog({ c, template, onClose }: { c?: Commitment; template: (typeof commitmentTemplates)[number] | null; onClose: () => void }) {
  const [name, setName] = useState(c?.name ?? template?.name ?? '');
  const [kind, setKind] = useState<CommitmentKind>(c?.kind ?? template?.kind ?? 'bill');
  const [amount, setAmount] = useState(c ? String(c.amount) : '');
  const [frequency, setFrequency] = useState<Frequency>(c?.frequency ?? 'monthly');
  const [day, setDay] = useState(String(c?.day ?? template?.day ?? 1));
  const [month, setMonth] = useState(String(c?.month ?? 0));
  const [essential, setEssential] = useState(c?.essential ?? template?.essential ?? true);
  const [endsOn, setEndsOn] = useState(c?.endsOn ?? '');
  const save = (e: FormEvent) => {
    e.preventDefault();
    const amt = Number(amount), d = Number(day);
    if (!name.trim() || !(amt > 0)) return toast('Enter a name and an amount above zero.');
    if (frequency === 'weekly' ? !(d >= 0 && d <= 6) : !(d >= 1 && d <= 31)) return toast(frequency === 'weekly' ? 'Pick a weekday.' : 'Day must be between 1 and 31.');
    const rec: Commitment = { id: c?.id ?? uid('cm'), name: name.trim(), kind, amount: amt, frequency, day: d, essential: kind === 'income' ? true : essential, ...(frequency === 'quarterly' || frequency === 'yearly' ? { month: Number(month) } : {}), ...(endsOn ? { endsOn } : {}) };
    commitmentsStore.set((cs) => (c ? cs.map((x) => (x.id === c.id ? rec : x)) : [...cs, rec]));
    toast(`${rec.name} saved.`);
    onClose();
  };
  return (
    <FuturisticModal title={c ? `Edit ${c.name}` : 'Add rent, bill or income'} icon={Wallet} onClose={onClose}>
      <form className="stack" style={{ gap: 12 }} onSubmit={save}>
        <div className="field"><label htmlFor="cm-kind">Type</label>
          <select id="cm-kind" className="select" style={{ height: 44 }} value={kind} onChange={(e) => setKind(e.target.value as CommitmentKind)}>{(Object.keys(kindLabel) as CommitmentKind[]).map((k) => <option key={k} value={k}>{kindLabel[k]}</option>)}</select></div>
        <HudInput label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Rent, Salary, HDFC EMI" autoFocus />
        <HudInput label="Amount (₹)" type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} />
        <div className="field"><label htmlFor="cm-freq">How often</label>
          <select id="cm-freq" className="select" style={{ height: 44 }} value={frequency} onChange={(e) => { const f = e.target.value as Frequency; setFrequency(f); setDay('1'); }}>
            <option value="monthly">Every month</option><option value="weekly">Every week</option><option value="quarterly">Every 3 months</option><option value="yearly">Every year</option></select></div>
        {frequency === 'weekly'
          ? <div className="field"><label htmlFor="cm-day">Weekday</label><select id="cm-day" className="select" style={{ height: 44 }} value={day} onChange={(e) => setDay(e.target.value)}>{WEEKDAYS.map((w, i) => <option key={w} value={i}>{w}</option>)}</select></div>
          : <HudInput label="Day of the month (1-31)" type="number" min={1} max={31} value={day} onChange={(e) => setDay(e.target.value)} />}
        {(frequency === 'quarterly' || frequency === 'yearly') && <div className="field"><label htmlFor="cm-month">{frequency === 'yearly' ? 'Month' : 'First month of the cycle'}</label><select id="cm-month" className="select" style={{ height: 44 }} value={month} onChange={(e) => setMonth(e.target.value)}>{MONTHS.map((m, i) => <option key={m} value={i}>{m}</option>)}</select></div>}
        <HudInput label="Ends on (optional, e.g. last EMI)" type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
        {kind !== 'income' && <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={essential} onChange={(e) => setEssential(e.target.checked)} /> <span className="t-sub">A need (rent, loan, bills), not a want. Needs set the emergency-fund target.</span></label>}
        <div className="row" style={{ justifyContent: 'flex-end' }}><NeonButton type="button" onClick={onClose}>Cancel</NeonButton><NeonButton type="submit" variant="primary">Save</NeonButton></div>
      </form>
    </FuturisticModal>
  );
}

function SettingsDialog({ prefs, balance, onClose }: { prefs: MoneyPrefs; balance: number; onClose: () => void }) {
  const [bal, setBal] = useState(String(Math.round(balance)));
  const [buffer, setBuffer] = useState(prefs.buffer === undefined ? '' : String(prefs.buffer));
  const [rate, setRate] = useState(String(Math.round(prefs.savingsRate * 100)));
  const [months, setMonths] = useState(String(prefs.emergencyMonths));
  const save = (e: FormEvent) => {
    e.preventDefault();
    const b = Number(bal), r = Number(rate), m = Number(months);
    if (!Number.isFinite(b) || !(r >= 0 && r <= 90) || !(m >= 1 && m <= 24)) return toast('Check the numbers: savings 0-90%, emergency fund 1-24 months.');
    const next: MoneyPrefs = { ...prefs, id: 'prefs', savingsRate: r / 100, emergencyMonths: m, buffer: buffer.trim() === '' ? undefined : Math.max(0, Number(buffer) || 0),
      anchor: Math.round(balance) === b ? prefs.anchor : { amount: b, at: new Date().toISOString() } };
    moneyPrefsStore.set([next]);
    toast('Money plan settings saved.');
    onClose();
  };
  return (
    <FuturisticModal title="Money plan settings" icon={Landmark} onClose={onClose}>
      <form className="stack" style={{ gap: 12 }} onSubmit={save}>
        <HudInput label="My balance right now (₹)" type="number" value={bal} onChange={(e) => setBal(e.target.value)} autoFocus />
        <div className="t-sub">AURA can't see your bank. Tell it your balance now; it keeps count from the expenses and income you add after that.</div>
        <HudInput label="Keep untouched (₹), optional" type="number" min={0} value={buffer} onChange={(e) => setBuffer(e.target.value)} placeholder="default: about 10% of a month's income" />
        <HudInput label="Save this much of income (%)" type="number" min={0} max={90} value={rate} onChange={(e) => setRate(e.target.value)} />
        <HudInput label="Emergency fund covers (months)" type="number" min={1} max={24} value={months} onChange={(e) => setMonths(e.target.value)} />
        <div className="row" style={{ justifyContent: 'flex-end' }}><NeonButton type="button" onClick={onClose}>Cancel</NeonButton><NeonButton type="submit" variant="primary">Save</NeonButton></div>
      </form>
    </FuturisticModal>
  );
}
