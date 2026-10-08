import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Wallet, ShieldCheck, CalendarDays, BarChart3, Receipt, Eye, EyeOff, TrendingUp, TrendingDown, HandCoins, ShoppingBag, PiggyBank, Lightbulb, Leaf,
  Sparkles, PlusCircle, Download, Target, ChevronLeft, ChevronRight, ArrowRight,
} from 'lucide-react';
import { Hud, IconBox, PageHero, NeonButton, BarChart, Donut, FilterDropdown, FuturisticModal, HudInput, SyncStatus, toast, type Tone } from '../components/aura';
import { AICommandPanel, domainAsk } from '../components/ai';
import { TransactionRow, BudgetCard, GoalCard, inr } from '../components/finance';
import MoneyPlan, { usePlanInput } from '../components/finance/MoneyPlan';
import { buildPlan, planContext } from '../services/moneyPlan';
import type { Budget } from '../data/budgets';
import { txColor, type TxCategory } from '../data/transactions';
import { goalIcons, type Goal, type GoalIcon } from '../data/goals';
import { transactionsStore, budgetsStore, goalsStore, commitmentsStore, moneyPrefsStore } from '../state/stores';
import { uid } from '../state/store';
import { usePageSearch, matches } from '../state/search';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TX_CATS: TxCategory[] = ['Food & Dining', 'Shopping', 'Travel', 'Bills & Utilities', 'Subscriptions', 'Others'];
const RANGES = ['This Month', 'Last Month', 'This Year'] as const;

type Dialog = { kind: 'expense' | 'income' | 'newgoal' } | { kind: 'budget'; b?: Budget } | { kind: 'goal'; g: Goal } | null;

const isExpense = (t: { amount: number }) => t.amount < 0;
const inMonth = (ts: string, y: number, m: number) => { const d = new Date(ts); return d.getFullYear() === y && d.getMonth() === m; };
const pctChange = (cur: number, prev: number) => (prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null);

export default function Finance() {
  const nav = useNavigate();
  const q = usePageSearch();
  const txs = transactionsStore.use();
  const budgets = budgetsStore.use();
  const goals = goalsStore.use();
  const [hide, setHide] = useState(false);
  const planInput = usePlanInput();
  const plan = useMemo(() => buildPlan(planInput), [planInput]);
  const today = new Date();
  const year = today.getFullYear();
  const [month, setMonth] = useState(today.getMonth());
  const [range, setRange] = useState<(typeof RANGES)[number]>('This Month');
  const [showAll, setShowAll] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [form, setForm] = useState({ merchant: '', amount: '', category: 'Food & Dining' as TxCategory });

  const sumIn = (y: number, m: number, kind: 'income' | 'expense') =>
    txs.filter((t) => inMonth(t.ts, y, m) && (kind === 'income' ? t.amount > 0 : isExpense(t))).reduce((a, t) => a + Math.abs(t.amount), 0);
  const prevM = month === 0 ? 11 : month - 1;
  const prevY = month === 0 ? year - 1 : year;

  const balance = txs.reduce((a, t) => a + t.amount, 0);
  const income = sumIn(year, month, 'income');
  const expenses = sumIn(year, month, 'expense');
  const savings = income - expenses;
  const series = MONTHS.map((_, i) => sumIn(year, i, 'expense'));
  const from = Math.max(0, month - 5);
  const window6 = series.slice(from, month + 1);
  const labels = MONTHS.slice(from, month + 1);

  const spentByCat = (y: number, m: number | null) => {
    const out = new Map<TxCategory, number>();
    for (const t of txs.filter((x) => isExpense(x) && (m === null ? new Date(x.ts).getFullYear() === y : inMonth(x.ts, y, m)))) out.set(t.category, (out.get(t.category) ?? 0) + Math.abs(t.amount));
    return out;
  };
  const rangeMap = range === 'This Year' ? spentByCat(year, null) : range === 'Last Month' ? spentByCat(prevY, prevM) : spentByCat(year, month);
  const rangeTotal = [...rangeMap.values()].reduce((a, b) => a + b, 0);
  const breakdown = [...rangeMap.entries()].sort((a, b) => b[1] - a[1]).map(([label, v]) => ({ label, value: Math.round((v / rangeTotal) * 100), color: txColor[label] }));
  const monthSpent = spentByCat(year, month);
  const shownTx = [...txs].sort((a, b) => b.ts.localeCompare(a.ts)).filter((t) => matches(q, t.merchant, t.category));
  const money = (v: string) => (hide ? '••••••' : v);
  const delta = (cur: number, prev: number, goodWhenUp: boolean) => { const p = pctChange(cur, prev); return p === null ? null : { text: `${Math.abs(p)}% from last month`, up: p >= 0, good: goodWhenUp ? p >= 0 : p <= 0 }; };

  const saveTx = (e: FormEvent) => {
    e.preventDefault();
    const amt = Number(form.amount);
    if (!form.merchant.trim() || !(amt > 0)) { toast('Enter a name and an amount above zero.'); return; }
    const isExp = dialog?.kind === 'expense';
    transactionsStore.set((ts) => [{ id: uid('tx'), merchant: form.merchant.trim(), logo: isExp ? form.merchant.trim() : 'Salary', ts: new Date().toISOString(), category: isExp ? form.category : 'Income', amount: isExp ? -amt : amt }, ...ts]);
    toast(`${isExp ? 'Expense' : 'Income'} of ${inr(amt)} recorded.`);
    setDialog(null);
    setForm({ merchant: '', amount: '', category: 'Food & Dining' });
  };

  const insights = useMemo(() => {
    const out: [typeof Lightbulb, Tone, string][] = [];
    const top = [...monthSpent.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top) out.push([Lightbulb, 'amber', `${top[0]} is your biggest expense this month at ${inr(top[1])}.`]);
    if (income > 0) out.push([TrendingUp, savings >= 0 ? 'green' : 'red', savings >= 0 ? `You've saved ${inr(savings)} (${Math.round((savings / income) * 100)}% of income) this month.` : `You've spent ${inr(-savings)} more than you earned this month.`]);
    for (const b of budgets) { const sp = monthSpent.get(b.category) ?? 0; if (sp >= b.limit * 0.9) out.push([Leaf, 'red', `${b.category} is at ${Math.round((sp / b.limit) * 100)}% of its ${inr(b.limit)} budget.`]); }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txs, budgets, month]);

  const ai = domainAsk('finance', () => JSON.stringify({
    month: MONTHS[month], income, expenses, savings, balance,
    spendingByCategory: Object.fromEntries(monthSpent), budgets: budgets.map((b) => ({ category: b.category, limit: b.limit, spent: monthSpent.get(b.category) ?? 0 })),
    goals: goals.map((g) => ({ name: g.name, saved: g.saved, target: g.target, by: g.by })), currency: 'INR',
    // the money plan, computed by the app: the assistant explains these numbers and must not make up its own
    plan: planContext(plan),
  }));

  return (
    <div className="module">
      <div className="main">
        <PageHero title={<>Finance <span className="grad">Smarter</span><br />with <span className="grad">AURA</span></>} lead="Track, plan, invest, and grow your money with AI." image="/aura/hero-finance.jpg" imageWidth="26%" quote="Your Money. Your Goals. A Smarter Future."
          feats={[
            { icon: Wallet, title: 'Track expenses', sub: 'Automatically', tone: 'violet' },
            { icon: ShieldCheck, title: 'Smart insights', sub: 'AI-powered analysis' },
            { icon: CalendarDays, title: 'Budget planning', sub: 'Stay on track', tone: 'teal' },
            { icon: BarChart3, title: 'Investment guidance', sub: 'Build wealth', tone: 'violet' },
            { icon: Receipt, title: 'Bill reminders', sub: 'Never miss a payment', tone: 'violet' },
          ]} />

        <div className="grid g4">
          {([
            [Wallet, 'Total Balance', balance, null, 'blue'],
            [HandCoins, 'Monthly Income', income, delta(income, sumIn(prevY, prevM, 'income'), true), 'green'],
            [ShoppingBag, 'Monthly Expenses', expenses, delta(expenses, sumIn(prevY, prevM, 'expense'), false), 'pink'],
            [PiggyBank, 'Savings', savings, null, 'violet'],
          ] as const).map(([I, l, v, d, tone]) => (
            <div className="hud row" key={l} style={{ alignItems: 'flex-start', gap: 14 }}>
              <IconBox icon={I} tone={tone as Tone} size="lg" />
              <div>
                <div className="row t-sub" style={{ gap: 6 }}>{l}
                  {l === 'Total Balance' && <button onClick={() => setHide((h) => !h)} className="icon-btn bare" style={{ width: 24, height: 24, color: 'var(--aura-cyan)' }} aria-pressed={hide} aria-label={hide ? 'Show amounts' : 'Hide amounts'}>{hide ? <EyeOff size={15} /> : <Eye size={15} />}</button>}
                </div>
                <b style={{ fontSize: 24, fontFamily: 'var(--font-head)' }}>{money(`${v < 0 ? '-' : ''}${inr(v)}`)}</b>
                {d && <div className={`row ${d.good ? 'c-green' : 'c-red'}`} style={{ fontSize: 12.5, gap: 4 }}>{d.up ? <TrendingUp size={13} /> : <TrendingDown size={13} />} {d.text}</div>}
              </div>
            </div>
          ))}
        </div>

        <MoneyPlan hide={hide} input={planInput} plan={plan} />

        <div className="grid g2">
          <Hud corners>
            <div className="row between" style={{ marginBottom: 10 }}>
              <h2 className="section-title">Expense Overview</h2>
              <div className="row" style={{ gap: 6 }}>
                <button className="icon-btn" style={{ width: 30, height: 30 }} onClick={() => setMonth((m) => Math.max(0, m - 1))} aria-label="Previous month"><ChevronLeft size={15} /></button>
                <span className="chip" aria-live="polite">{new Date(year, month, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</span>
                <button className="icon-btn" style={{ width: 30, height: 30 }} onClick={() => setMonth((m) => Math.min(today.getMonth(), m + 1))} aria-label="Next month"><ChevronRight size={15} /></button>
              </div>
            </div>
            {window6.some((v) => v > 0) ? <BarChart values={window6} labels={labels} height={210} /> : <div className="empty">No expenses recorded yet. Add an expense to see your trend.</div>}
            <div className="t-sub" style={{ marginTop: 6 }}>{MONTHS[month]} spend: <b style={{ color: '#fff' }}>{money(inr(series[month]))}</b></div>
          </Hud>
          <Hud corners>
            <div className="row between" style={{ marginBottom: 10 }}>
              <h2 className="section-title">Expense Breakdown</h2>
              <FilterDropdown value={range} options={RANGES} onChange={setRange} align="right" />
            </div>
            {breakdown.length === 0 ? <div className="empty">No expenses in this period.</div> : <div className="row wrap" style={{ gap: 20 }}>
              <Donut data={breakdown} size={170} stroke={24} center={money(inr(rangeTotal))} sub="Total" />
              <div className="legend" style={{ flex: 1, minWidth: 160 }}>
                {breakdown.map((s) => <div key={s.label} className="legend-row"><span className="sw" style={{ background: s.color, borderRadius: '50%' }} /><span>{s.label}</span><span className="v">{s.value}%</span></div>)}
              </div>
            </div>}
          </Hud>
        </div>

        <div className="grid g2">
          <Hud corners title={<span className="section-title" style={{ fontSize: 20 }}>Recent Transactions</span>} action={showAll ? 'Show less' : 'View All'} onAction={() => setShowAll((s) => !s)}>
            <div className="list">{(showAll ? shownTx : shownTx.slice(0, 4)).map((t) => <TransactionRow key={t.id} tx={t} hide={hide} />)}</div>
            {!shownTx.length && <div className="empty">{q ? `No transactions match “${q}”.` : 'No transactions yet. Use Add Expense or Add Income to record one.'}</div>}
          </Hud>
          <Hud corners title={<span className="section-title" style={{ fontSize: 20 }}>Budgets</span>} action="Add Budget" onAction={() => setDialog({ kind: 'budget' })}>
            <div className="list">{budgets.map((b) => <BudgetCard key={b.id} b={b} spent={monthSpent.get(b.category) ?? 0} hide={hide} onEdit={() => setDialog({ kind: 'budget', b })} />)}</div>
            {!budgets.length && <div className="empty">No budgets yet. Set one to track a spending limit.</div>}
          </Hud>
        </div>
        <SyncStatus stores={[transactionsStore, budgetsStore, goalsStore, commitmentsStore, moneyPrefsStore]} />
      </div>

      <div className="rail">
        <AICommandPanel title="AI Finance Insights"
          header={insights.length > 0 ? (
            <div className="list" style={{ marginBottom: 10 }}>
              {insights.map(([I, t, txt]) => (
                <div key={txt} className="li" style={{ alignItems: 'flex-start' }}><IconBox icon={I} tone={t} size="sm" /><span style={{ fontSize: 13.5 }}>{txt}</span></div>
              ))}
            </div>
          ) : <p className="t-sub" style={{ marginBottom: 10, fontSize: 13.5 }}>Record a few transactions and AURA will surface insights here.</p>}
          prompts={['Where am I overspending?', 'How can I save more each month?', 'Summarize this month']} promptStyle="boxes"
          onAsk={ai} cta="Ask AURA about my finances" ctaIcon={Sparkles} placeholder="Ask about your money…"
          footer={<p className="t-mute" style={{ marginTop: 8 }}>Informational only — not regulated financial advice. AURA never moves money.</p>} />

        <Hud corners title="Financial Goals" action="New goal" onAction={() => setDialog({ kind: 'newgoal' })}>
          <div className="stack" style={{ gap: 16 }}>{goals.map((g) => <GoalCard key={g.id} g={g} hide={hide} onContribute={() => setDialog({ kind: 'goal', g })} />)}</div>
          {!goals.length && <div className="empty">No goals yet. Create one to start tracking savings.</div>}
        </Hud>

        <Hud corners title="Quick Actions">
          <div className="grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 8 }}>
            {([[PlusCircle, 'Add Expense', 'blue', () => setDialog({ kind: 'expense' })], [Download, 'Add Income', 'green', () => setDialog({ kind: 'income' })], [Target, 'Set Budget', 'pink', () => setDialog({ kind: 'budget' })], [BarChart3, 'View Reports', 'violet', () => nav('/analytics')]] as const).map(([I, l, tone, fn]) => (
              <button key={l} className="stack" style={{ background: 'none', border: 0, alignItems: 'center', gap: 6 }} onClick={fn}><IconBox icon={I} tone={tone as Tone} size="lg" /><span style={{ fontSize: 11.5 }}>{l}</span></button>
            ))}
          </div>
        </Hud>
      </div>

      {(dialog?.kind === 'expense' || dialog?.kind === 'income') && (
        <FuturisticModal title={dialog.kind === 'expense' ? 'Add Expense' : 'Add Income'} icon={dialog.kind === 'expense' ? PlusCircle : Download} onClose={() => setDialog(null)}>
          <form className="stack" style={{ gap: 12 }} onSubmit={saveTx}>
            <HudInput label={dialog.kind === 'expense' ? 'Merchant' : 'Source'} value={form.merchant} onChange={(e) => setForm({ ...form, merchant: e.target.value })} placeholder={dialog.kind === 'expense' ? 'e.g. Swiggy' : 'e.g. Freelance project'} autoFocus />
            <HudInput label="Amount (₹)" type="number" min={1} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
            {dialog.kind === 'expense' && (
              <div className="field"><label htmlFor="tx-cat">Category</label>
                <select id="tx-cat" className="select" style={{ height: 44 }} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as TxCategory })}>{TX_CATS.map((c) => <option key={c}>{c}</option>)}</select>
              </div>
            )}
            <div className="row" style={{ justifyContent: 'flex-end' }}><NeonButton type="button" onClick={() => setDialog(null)}>Cancel</NeonButton><NeonButton type="submit" variant="primary">Save</NeonButton></div>
          </form>
        </FuturisticModal>
      )}

      {dialog?.kind === 'budget' && <BudgetDialog b={dialog.b} existing={budgets} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'goal' && <GoalDialog g={dialog.g} goals={goals} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'newgoal' && <NewGoalDialog onClose={() => setDialog(null)} />}
    </div>
  );
}

function BudgetDialog({ b, existing, onClose }: { b?: Budget; existing: Budget[]; onClose: () => void }) {
  const [cat, setCat] = useState<TxCategory>(b?.category ?? 'Food & Dining');
  const cur = existing.find((x) => x.category === cat);
  const [limit, setLimit] = useState(String(b?.limit ?? cur?.limit ?? 5000));
  const save = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(limit);
    if (!(n > 0)) return toast('Enter a limit above zero.');
    budgetsStore.set((bs) => (bs.some((x) => x.category === cat) ? bs.map((x) => (x.category === cat ? { ...x, limit: n } : x)) : [...bs, { id: uid('bg'), category: cat, limit: n }]));
    toast(`${cat} budget set to ${inr(n)}.`);
    onClose();
  };
  return (
    <FuturisticModal title={b ? `Edit ${b.category} budget` : 'Set Budget'} icon={Target} onClose={onClose}>
      <form className="stack" style={{ gap: 12 }} onSubmit={save}>
        {!b && <div className="field"><label htmlFor="bg-cat">Category</label><select id="bg-cat" className="select" style={{ height: 44 }} value={cat} onChange={(e) => setCat(e.target.value as TxCategory)}>{TX_CATS.map((c) => <option key={c}>{c}</option>)}</select></div>}
        <HudInput label="Monthly limit (₹)" type="number" min={1} value={limit} onChange={(e) => setLimit(e.target.value)} autoFocus />
        <div className="row" style={{ justifyContent: 'flex-end' }}><NeonButton type="button" onClick={onClose}>Cancel</NeonButton><NeonButton type="submit" variant="primary">Save budget</NeonButton></div>
      </form>
    </FuturisticModal>
  );
}

function NewGoalDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [saved, setSaved] = useState('0');
  const [by, setBy] = useState('');
  const [icon, setIcon] = useState<GoalIcon>('target');
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !(Number(target) > 0)) return toast('Enter a goal name and a target above zero.');
    goalsStore.set((gs) => [...gs, { id: uid('gl'), name: name.trim(), icon, tone: 'violet', saved: Math.max(0, Number(saved) || 0), target: Number(target), ...(by ? { by } : {}) }]);
    onClose();
  };
  return (
    <FuturisticModal title="New Goal" icon={Target} onClose={onClose}>
      <form className="stack" style={{ gap: 12 }} onSubmit={save}>
        <HudInput label="Goal" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Emergency fund" autoFocus />
        <HudInput label="Target (₹)" type="number" min={1} value={target} onChange={(e) => setTarget(e.target.value)} />
        <HudInput label="Already saved (₹)" type="number" min={0} value={saved} onChange={(e) => setSaved(e.target.value)} />
        <HudInput label="Want it by (optional)" type="date" value={by} onChange={(e) => setBy(e.target.value)} />
        <div className="field"><label>Icon</label><div className="seg">{(Object.keys(goalIcons) as GoalIcon[]).map((k) => { const I = goalIcons[k]; return <button type="button" key={k} className={`chip ${icon === k ? 'active' : ''}`} onClick={() => setIcon(k)} aria-label={k}><I size={16} /></button>; })}</div></div>
        <div className="row" style={{ justifyContent: 'flex-end' }}><NeonButton type="button" onClick={onClose}>Cancel</NeonButton><NeonButton type="submit" variant="primary">Create goal</NeonButton></div>
      </form>
    </FuturisticModal>
  );
}

function GoalDialog({ g, goals, onClose }: { g: Goal; goals: Goal[]; onClose: () => void }) {
  const [id, setId] = useState(g.id);
  const [amt, setAmt] = useState('5000');
  const goal = goals.find((x) => x.id === id) ?? g;
  const save = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(amt);
    if (!(n > 0)) return toast('Enter an amount above zero.');
    goalsStore.set((gs) => gs.map((x) => (x.id === id ? { ...x, saved: Math.min(x.target, x.saved + n) } : x)));
    toast(`${inr(n)} added to ${goal.name}. This only updates your tracker — no money moves.`);
    onClose();
  };
  return (
    <FuturisticModal title="Add to Goal" icon={ArrowRight} onClose={onClose}>
      <form className="stack" style={{ gap: 12 }} onSubmit={save}>
        <div className="field"><label htmlFor="gl">Goal</label><select id="gl" className="select" style={{ height: 44 }} value={id} onChange={(e) => setId(e.target.value)}>{goals.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
        <div className="t-sub">{inr(goal.saved)} of {inr(goal.target)} saved</div>
        <HudInput label="Amount (₹)" type="number" min={1} value={amt} onChange={(e) => setAmt(e.target.value)} autoFocus />
        <div className="row" style={{ justifyContent: 'flex-end' }}><NeonButton type="button" onClick={onClose}>Cancel</NeonButton><NeonButton type="submit" variant="primary">Add</NeonButton></div>
      </form>
    </FuturisticModal>
  );
}
