import type { Transaction, TxCategory } from '../data/transactions';
import type { Budget } from '../data/budgets';
import type { Goal } from '../data/goals';
import { DEFAULT_MONEY_PREFS, type Commitment, type MoneyPrefs } from '../data/commitments';

/**
 * AURA's money plan. Pure functions: give them the user's transactions, scheduled commitments (salary, rent, EMIs,
 * bills, SIPs), goals, budgets and settings, and they work out the future:
 *
 *  - a day-by-day cash-flow forecast (scheduled money in and out, plus the user's own typical everyday spending);
 *  - what is safe to spend today, and whether a purchase fits (and when, if not now);
 *  - budgets that fit the income, goals turned into monthly amounts, an emergency-fund target, and alerts.
 *
 * It never moves money and it is not regulated financial advice. Everything is deterministic and explainable: each
 * number can be traced to the commitments and spending it came from. The spending estimate is a trimmed average of
 * the last 90 days (one big purchase doesn't distort it), and says so when there isn't enough history.
 */

export interface PlanInput {
  now: Date;
  transactions: Transaction[];
  commitments: Commitment[];
  goals: Goal[];
  budgets: Budget[];
  prefs?: Partial<MoneyPrefs>;
}

// ------------------------------------------------------------------ dates

const DAY = 86_400_000;
export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const daysInMonth = (y: number, m: number) => new Date(y, m + 1, 0).getDate();
export const daysBetween = (a: Date, b: Date) => Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / DAY);
export const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseDay = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** The dates (day precision) a commitment falls on within [from, to]. A day of 31 in a 30-day month means the 30th. */
export function occurrences(c: Commitment, from: Date, to: Date): Date[] {
  const out: Date[] = [];
  const lo = startOfDay(from), hi = startOfDay(to);
  const starts = c.startsOn ? parseDay(c.startsOn) : null;
  const ends = c.endsOn ? parseDay(c.endsOn) : null;
  const ok = (d: Date) => d >= lo && d <= hi && (!starts || d >= starts) && (!ends || d <= ends);
  if (c.frequency === 'weekly') {
    for (let d = lo; d <= hi; d = addDays(d, 1)) if (d.getDay() === c.day && ok(d)) out.push(d);
    return out;
  }
  const anchor = c.month ?? 0;
  // one candidate date per calendar month from `lo`'s month to `hi`'s month
  const months = (hi.getFullYear() - lo.getFullYear()) * 12 + hi.getMonth() - lo.getMonth();
  for (let i = 0; i <= months; i++) {
    const y = lo.getFullYear() + Math.floor((lo.getMonth() + i) / 12), m = (lo.getMonth() + i) % 12;
    if (c.frequency === 'yearly' && m !== anchor) continue;
    if (c.frequency === 'quarterly' && (((m - anchor) % 3) + 3) % 3 !== 0) continue;
    const d = new Date(y, m, Math.min(Math.max(1, c.day), daysInMonth(y, m)));
    if (ok(d)) out.push(d);
  }
  return out;
}

/** What a commitment costs (or brings) in an average month. */
export function monthlyEquivalent(c: Commitment): number {
  switch (c.frequency) {
    case 'weekly': return (c.amount * 52) / 12;
    case 'quarterly': return c.amount / 3;
    case 'yearly': return c.amount / 12;
    default: return c.amount;
  }
}

// ------------------------------------------------------------------ matching transactions to commitments

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Whether a recorded transaction is (probably) the payment or receipt of this commitment. */
export function matchesCommitment(t: Transaction, c: Commitment): boolean {
  const income = c.kind === 'income';
  if (income !== t.amount > 0) return false;
  const a = norm(t.merchant), b = norm(c.name);
  if (b.length >= 3 && (a.includes(b) || b.includes(a)) && a.length >= 3) return true;
  const close = Math.abs(Math.abs(t.amount) - c.amount) <= c.amount * (income ? 0.1 : 0.03);
  const sameKind = income ? t.category === 'Income' : t.category === 'Bills & Utilities' || t.category === 'Subscriptions';
  return close && sameKind;
}

/** Whether the occurrence on `date` has already been paid / received (a matching transaction within 3 days either side). */
function isSettled(c: Commitment, date: Date, txs: Transaction[], now: Date): boolean {
  const lo = addDays(date, -3).getTime(), hi = addDays(date, 4).getTime();
  return txs.some((t) => { const ts = new Date(t.ts).getTime(); return ts >= lo && ts < hi && ts <= now.getTime() && matchesCommitment(t, c); });
}

// ------------------------------------------------------------------ what the user has now, and spends usually

export function currentBalance(input: PlanInput): number {
  const anchor = input.prefs?.anchor;
  if (anchor) {
    const at = new Date(anchor.at).getTime();
    return anchor.amount + input.transactions.filter((t) => new Date(t.ts).getTime() > at).reduce((a, t) => a + t.amount, 0);
  }
  return input.transactions.reduce((a, t) => a + t.amount, 0);
}

const percentile = (xs: number[], p: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

export interface Spending {
  /** Typical everyday spend per day, in rupees, with scheduled commitments taken out. */
  perDay: number;
  /** Everyday spend by category per month. */
  perMonthByCategory: Map<TxCategory, number>;
  daysOfHistory: number;
  confidence: 'low' | 'ok' | 'good';
}

/**
 * The user's usual everyday spending over the last `windowDays`: expenses that are not one of their scheduled
 * commitments, each capped at the 95th percentile of such expenses so a single laptop doesn't become "normal".
 */
export function typicalSpending(input: PlanInput, windowDays = 90): Spending {
  const { now, transactions, commitments } = input;
  const from = addDays(startOfDay(now), -windowDays);
  const expenses = transactions.filter((t) => t.amount < 0 && new Date(t.ts) >= from && new Date(t.ts) <= now
    && !commitments.some((c) => matchesCommitment(t, c)));
  const all = transactions.filter((t) => new Date(t.ts) >= from && new Date(t.ts) <= now);
  const first = all.length ? Math.min(...all.map((t) => new Date(t.ts).getTime())) : now.getTime();
  const daysOfHistory = Math.min(windowDays, Math.max(0, daysBetween(new Date(first), now) + 1));
  const cap = percentile(expenses.map((t) => -t.amount), 0.95);
  const byCat = new Map<TxCategory, number>();
  let total = 0;
  for (const t of expenses) { const v = Math.min(-t.amount, cap || -t.amount); total += v; byCat.set(t.category, (byCat.get(t.category) ?? 0) + v); }
  const span = Math.max(14, daysOfHistory);
  const perDay = expenses.length ? total / span : 0;
  const monthly = 30.44 / span;
  for (const [k, v] of byCat) byCat.set(k, v * monthly);
  return { perDay, perMonthByCategory: byCat, daysOfHistory, confidence: daysOfHistory < 14 || expenses.length < 5 ? 'low' : daysOfHistory < 45 ? 'ok' : 'good' };
}

/** Average monthly income: the scheduled income if there is any, else the last three months of recorded income. */
export function monthlyIncome(input: PlanInput): number {
  const scheduled = input.commitments.filter((c) => c.kind === 'income').reduce((a, c) => a + monthlyEquivalent(c), 0);
  if (scheduled > 0) return scheduled;
  const from = addDays(startOfDay(input.now), -90);
  const recorded = input.transactions.filter((t) => t.amount > 0 && new Date(t.ts) >= from && new Date(t.ts) <= input.now).reduce((a, t) => a + t.amount, 0);
  return recorded / 3;
}

const outflows = (cs: Commitment[]) => cs.filter((c) => c.kind !== 'income');
const bufferOf = (input: PlanInput) => input.prefs?.buffer ?? Math.round((monthlyIncome(input) * 0.1) / 500) * 500;

// ------------------------------------------------------------------ the forecast

export interface PlanEvent { date: Date; name: string; amount: number; kind: Commitment['kind']; essential: boolean }
export interface DayPoint { date: Date; balance: number; events: PlanEvent[] }
export interface Forecast {
  days: DayPoint[];
  start: number;
  end: number;
  lowest: { date: Date; balance: number };
  /** First day the balance falls below the buffer, if it does. */
  shortfall: { date: Date; balance: number; causes: PlanEvent[] } | null;
}

/** Unsettled scheduled events from today through `days` days ahead, soonest first. */
export function upcomingEvents(input: PlanInput, days: number): PlanEvent[] {
  const today = startOfDay(input.now), to = addDays(today, days);
  const out: PlanEvent[] = [];
  for (const c of input.commitments) {
    for (const d of occurrences(c, today, to)) {
      if (isSettled(c, d, input.transactions, input.now)) continue;   // incl. paid a day or two early
      out.push({ date: d, name: c.name, amount: c.kind === 'income' ? c.amount : -c.amount, kind: c.kind, essential: c.essential });
    }
  }
  return out.sort((a, b) => a.date.getTime() - b.date.getTime() || b.amount - a.amount);
}

export function forecast(input: PlanInput, days = 60, extraSpend: { amount: number; on?: Date } | null = null): Forecast {
  const today = startOfDay(input.now);
  const spend = typicalSpending(input);
  const events = upcomingEvents(input, days);
  const buffer = bufferOf(input);
  let bal = currentBalance(input);
  const start = bal;
  const points: DayPoint[] = [];
  let lowest = { date: today, balance: bal };
  let shortfall: Forecast['shortfall'] = null;
  for (let i = 0; i <= days; i++) {
    const date = addDays(today, i);
    const todays = events.filter((e) => sameDay(e.date, date));
    bal += todays.reduce((a, e) => a + e.amount, 0);
    if (i > 0) bal -= spend.perDay;            // today's everyday spending is already in the balance
    if (extraSpend && sameDay(extraSpend.on ?? today, date)) bal -= extraSpend.amount;
    points.push({ date, balance: bal, events: todays });
    if (bal < lowest.balance) lowest = { date, balance: bal };
    if (!shortfall && bal < buffer) shortfall = { date, balance: bal, causes: todays.filter((e) => e.amount < 0) };
  }
  return { days: points, start, end: bal, lowest, shortfall };
}

// ------------------------------------------------------------------ safe to spend, and "can I afford it?"

export interface SafeToSpend {
  /** Cash that is free to spend until the next payday, after bills due before it and the buffer. May be negative. */
  amount: number;
  perDay: number;
  daysToPayday: number;
  nextPayday: Date;
  paydayKnown: boolean;
  dueBefore: PlanEvent[];
  buffer: number;
  usualPerDay: number;
}

export function safeToSpend(input: PlanInput): SafeToSpend {
  const today = startOfDay(input.now);
  const incomes = upcomingEvents(input, 62).filter((e) => e.kind === 'income');
  const paydayKnown = incomes.length > 0;
  const nextPayday = paydayKnown ? startOfDay(incomes[0].date)
    : new Date(today.getFullYear(), today.getMonth() + 1, 1);           // no salary scheduled: to the end of the month
  const daysToPayday = Math.max(1, daysBetween(today, nextPayday));
  const dueBefore = upcomingEvents(input, daysToPayday).filter((e) => e.amount < 0 && e.date < nextPayday);
  const buffer = bufferOf(input);
  const amount = currentBalance(input) - dueBefore.reduce((a, e) => a - e.amount, 0) - buffer;
  return { amount, perDay: Math.max(0, amount) / daysToPayday, daysToPayday, nextPayday, paydayKnown, dueBefore, buffer, usualPerDay: typicalSpending(input).perDay };
}

export interface Affordability {
  ok: boolean;
  /** Lowest balance in the next 45 days if the purchase is made now. */
  lowestBalance: number;
  lowestDate: Date;
  buffer: number;
  /** When it would fit, if not now (within 45 days). */
  okFrom: Date | null;
  reason: string;
}

export function canAfford(input: PlanInput, amount: number): Affordability {
  const buffer = bufferOf(input);
  const horizon = 45;
  const now = forecast(input, horizon, { amount });
  const ok = now.lowest.balance >= buffer;
  let okFrom: Date | null = null;
  if (!ok) {
    for (let d = 1; d <= horizon; d++) {
      const when = addDays(startOfDay(input.now), d);
      if (forecast(input, horizon, { amount, on: when }).lowest.balance >= buffer) { okFrom = when; break; }
    }
  }
  const fmt = (d: Date) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  const reason = ok
    ? `Your balance would stay above ₹${Math.round(buffer).toLocaleString('en-IN')} for the next ${horizon} days (lowest ₹${Math.round(now.lowest.balance).toLocaleString('en-IN')} on ${fmt(now.lowest.date)}).`
    : `It would take your balance to ₹${Math.round(now.lowest.balance).toLocaleString('en-IN')} on ${fmt(now.lowest.date)}, below your ₹${Math.round(buffer).toLocaleString('en-IN')} buffer`
      + (okFrom ? `. It fits from ${fmt(okFrom)}.` : ' and it doesn’t fit in the next 45 days.');
  return { ok, lowestBalance: now.lowest.balance, lowestDate: now.lowest.date, buffer, okFrom, reason };
}

// ------------------------------------------------------------------ budgets that fit the income

const FLEX: TxCategory[] = ['Food & Dining', 'Shopping', 'Travel', 'Others'];
const DEFAULT_SHARE: Record<string, number> = { 'Food & Dining': 0.4, Shopping: 0.25, Travel: 0.15, Others: 0.2 };

export interface BudgetPlan {
  income: number;
  /** Essential commitments (rent, EMI, bills, insurance) per month. */
  needs: number;
  /** Non-essential commitments (subscriptions...) per month. */
  wantsFixed: number;
  /** Savings: the SIPs already scheduled, topped up to the target rate. */
  savings: number;
  savingsTarget: number;
  /** What is left for everyday spending. */
  pool: number;
  status: 'surplus' | 'tight' | 'deficit' | 'no-income';
  categories: { category: TxCategory; current: number | null; avg: number; suggested: number }[];
}

export function budgetPlan(input: PlanInput): BudgetPlan {
  const prefs = { ...DEFAULT_MONEY_PREFS, ...input.prefs };
  const income = monthlyIncome(input);
  const out = outflows(input.commitments);
  const needs = out.filter((c) => c.essential && c.kind !== 'investment').reduce((a, c) => a + monthlyEquivalent(c), 0);
  const wantsFixed = out.filter((c) => !c.essential && c.kind !== 'investment').reduce((a, c) => a + monthlyEquivalent(c), 0);
  const sips = out.filter((c) => c.kind === 'investment').reduce((a, c) => a + monthlyEquivalent(c), 0);
  const savingsTarget = income * prefs.savingsRate;
  const savings = Math.max(sips, savingsTarget);
  const pool = income - needs - wantsFixed - savings;
  const spend = typicalSpending(input);
  const total = FLEX.reduce((a, c) => a + (spend.perMonthByCategory.get(c) ?? 0), 0);
  const categories = FLEX.map((category) => {
    const avg = spend.perMonthByCategory.get(category) ?? 0;
    const share = total > 0 && spend.confidence !== 'low' ? avg / total : DEFAULT_SHARE[category];
    return { category, current: input.budgets.find((b) => b.category === category)?.limit ?? null, avg, suggested: Math.max(0, Math.round((pool * share) / 100) * 100) };
  });
  const status: BudgetPlan['status'] = income <= 0 ? 'no-income' : pool < 0 ? 'deficit' : pool < income * 0.15 ? 'tight' : 'surplus';
  return { income, needs, wantsFixed, savings, savingsTarget, pool, status, categories };
}

// ------------------------------------------------------------------ goals

export interface GoalLine {
  goal: Goal;
  /** Not created yet: the emergency fund AURA recommends. */
  virtual: boolean;
  remaining: number;
  monthsLeft: number | null;
  /** Needed per month to finish on time (or within a year when there is no date). */
  required: number;
  /** What this month's spare money covers, in priority order. */
  allocated: number;
  onTrack: boolean;
  etaMonths: number | null;
}

export interface GoalPlan {
  /** Spare money per month at the user's current habits, after commitments and everyday spending. */
  surplus: number;
  essentialsPerMonth: number;
  emergencyTarget: number;
  emergencyCoverageMonths: number;
  lines: GoalLine[];
}

const isEmergency = (g: Goal) => /emergency|rainy|safety/i.test(g.name);

export function goalPlan(input: PlanInput): GoalPlan {
  const prefs = { ...DEFAULT_MONEY_PREFS, ...input.prefs };
  const spend = typicalSpending(input);
  const income = monthlyIncome(input);
  const committed = outflows(input.commitments).reduce((a, c) => a + monthlyEquivalent(c), 0);   // SIPs included: they are money already going out
  const everyday = spend.perDay * 30.44;
  const surplus = Math.max(0, income - committed - everyday);
  const essentialsPerMonth = outflows(input.commitments).filter((c) => c.essential).reduce((a, c) => a + monthlyEquivalent(c), 0)
    + (spend.perMonthByCategory.get('Food & Dining') ?? 0);
  const emergencyTarget = Math.round(essentialsPerMonth * prefs.emergencyMonths);
  const existing = input.goals.find(isEmergency);
  const goals: { goal: Goal; virtual: boolean }[] = input.goals.map((goal) => ({ goal, virtual: false }));
  if (!existing && essentialsPerMonth > 0) {
    goals.unshift({ goal: { id: 'virtual_emergency', name: 'Emergency fund', icon: 'target', tone: 'teal', saved: 0, target: emergencyTarget }, virtual: true });
  }
  const today = startOfDay(input.now);
  const lines: GoalLine[] = goals.map(({ goal, virtual }) => {
    const remaining = Math.max(0, goal.target - goal.saved);
    let monthsLeft: number | null = null;
    if (goal.by) monthsLeft = Math.max(1, Math.ceil(daysBetween(today, parseDay(goal.by)) / 30.44));
    return { goal, virtual, remaining, monthsLeft, required: remaining === 0 ? 0 : Math.ceil(remaining / (monthsLeft ?? 12)), allocated: 0, onTrack: false, etaMonths: null };
  });
  // emergency fund first, then the nearest deadline, then goals with no date
  const order = [...lines].sort((a, b) => Number(isEmergency(b.goal)) - Number(isEmergency(a.goal))
    || (a.monthsLeft ?? 1e9) - (b.monthsLeft ?? 1e9));
  let left = surplus;
  for (const l of order) {
    l.allocated = Math.min(l.required, Math.max(0, left));
    left -= l.allocated;
    l.onTrack = l.remaining === 0 || l.allocated >= l.required - 0.5;
    l.etaMonths = l.remaining === 0 ? 0 : l.allocated > 0 ? Math.ceil(l.remaining / l.allocated) : null;
  }
  const saved = existing?.saved ?? 0;
  return { surplus, essentialsPerMonth, emergencyTarget, emergencyCoverageMonths: essentialsPerMonth > 0 ? saved / essentialsPerMonth : 0, lines: order };
}

// ------------------------------------------------------------------ alerts, and the whole plan

export interface Alert { id: string; level: 'high' | 'medium' | 'info'; text: string }

const rs = (n: number) => `₹${Math.round(Math.abs(n)).toLocaleString('en-IN')}`;
const shortDate = (d: Date) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

export interface MoneyPlan {
  balance: number;
  safe: SafeToSpend;
  forecast: Forecast;
  upcoming: PlanEvent[];
  spending: Spending;
  budget: BudgetPlan;
  goals: GoalPlan;
  alerts: Alert[];
  /** What to do next, in order. */
  steps: string[];
  /** Whether there is enough set up (income and bills) for the numbers to mean much. */
  ready: boolean;
}

export function buildPlan(input: PlanInput): MoneyPlan {
  const balance = currentBalance(input);
  const safe = safeToSpend(input);
  const fc = forecast(input, 60);
  const upcoming = upcomingEvents(input, 14);
  const spending = typicalSpending(input);
  const budget = budgetPlan(input);
  const goals = goalPlan(input);
  const alerts: Alert[] = [];
  const buffer = bufferOf(input);

  if (fc.shortfall) {
    const why = fc.shortfall.causes.slice(0, 2).map((e) => `${e.name} ${rs(e.amount)}`).join(' and ');
    alerts.push({ id: 'shortfall', level: 'high', text: `At your current pace your balance drops below ${rs(buffer)} on ${shortDate(fc.shortfall.date)}${why ? ` (${why} due)` : ''}. Hold back everyday spending or move a bill.` });
  }
  if (safe.amount < 0) alerts.push({ id: 'safe-negative', level: 'high', text: `Bills due before ${safe.paydayKnown ? 'payday' : 'month end'} (${rs(safe.dueBefore.reduce((a, e) => a - e.amount, 0))}) are more than your free cash: you are ${rs(safe.amount)} short.` });
  const rent = input.commitments.filter((c) => c.kind === 'rent').reduce((a, c) => a + monthlyEquivalent(c), 0);
  if (budget.income > 0 && rent / budget.income > 0.35) alerts.push({ id: 'rent-ratio', level: 'medium', text: `Rent is ${Math.round((rent / budget.income) * 100)}% of your income. Around 30% is comfortable; above 35% leaves little room to save.` });
  const fixed = budget.needs + budget.wantsFixed;
  if (budget.income > 0 && fixed / budget.income > 0.6) alerts.push({ id: 'fixed-heavy', level: 'medium', text: `Fixed commitments take ${Math.round((fixed / budget.income) * 100)}% of your income before you spend anything.` });
  if (budget.status === 'deficit') alerts.push({ id: 'deficit', level: 'high', text: `Income ${rs(budget.income)} doesn't cover commitments ${rs(budget.needs + budget.wantsFixed)} plus your savings target ${rs(budget.savings)}. Lower the savings target or trim a commitment.` });
  const subs = input.commitments.filter((c) => c.kind === 'subscription').reduce((a, c) => a + monthlyEquivalent(c), 0);
  if (subs > 0 && budget.income > 0 && subs / budget.income > 0.05) alerts.push({ id: 'subs', level: 'info', text: `Subscriptions cost ${rs(subs)} a month (${Math.round((subs / budget.income) * 100)}% of income). Worth a look.` });
  if (goals.essentialsPerMonth > 0 && goals.emergencyCoverageMonths < 3) alerts.push({ id: 'emergency', level: goals.emergencyCoverageMonths < 1 ? 'medium' : 'info', text: `Your emergency fund covers ${goals.emergencyCoverageMonths.toFixed(1)} months of essentials. Aim for ${(input.prefs?.emergencyMonths ?? DEFAULT_MONEY_PREFS.emergencyMonths)} (${rs(goals.emergencyTarget)}).` });
  // spending ahead of the month's budget
  const day = input.now.getDate(), dim = daysInMonth(input.now.getFullYear(), input.now.getMonth());
  for (const b of input.budgets) {
    const spent = input.transactions.filter((t) => t.amount < 0 && t.category === b.category && new Date(t.ts).getMonth() === input.now.getMonth() && new Date(t.ts).getFullYear() === input.now.getFullYear()).reduce((a, t) => a - t.amount, 0);
    if (spent > b.limit * (day / dim) + b.limit * 0.15 && spent > b.limit * 0.5) alerts.push({ id: `pace-${b.category}`, level: spent > b.limit ? 'high' : 'medium', text: `${b.category}: ${rs(spent)} spent, ${Math.round((spent / b.limit) * 100)}% of the ${rs(b.limit)} budget with ${dim - day} days left.` });
  }
  if (spending.confidence === 'low') alerts.push({ id: 'low-data', level: 'info', text: 'Not much spending recorded yet, so everyday spending is a rough guess. It gets sharper as you log more.' });

  const steps: string[] = [];
  const nextBills = upcoming.filter((e) => e.amount < 0).slice(0, 3);
  if (nextBills.length) steps.push(`Coming up: ${nextBills.map((e) => `${e.name} ${rs(e.amount)} on ${shortDate(e.date)}`).join(', ')}.`);
  if (safe.amount >= 0) steps.push(`You can spend about ${rs(safe.perDay)} a day until ${safe.paydayKnown ? `payday (${shortDate(safe.nextPayday)})` : 'the end of the month'}${safe.usualPerDay > safe.perDay * 1.15 ? `, less than your usual ${rs(safe.usualPerDay)} a day.` : '.'}`);
  const toFund = goals.lines.filter((l) => l.allocated > 0);
  if (toFund.length) steps.push(`Set aside this month: ${toFund.map((l) => `${rs(l.allocated)} for ${l.goal.name}`).join(', ')}.`);
  const behind = goals.lines.filter((l) => !l.onTrack && l.remaining > 0 && l.goal.by);
  if (behind.length) steps.push(`${behind.map((l) => l.goal.name).join(', ')} ${behind.length > 1 ? 'are' : 'is'} behind: it needs ${behind.map((l) => rs(l.required)).join(' / ')} a month and your spare money doesn't cover it.`);
  if (budget.status !== 'no-income' && budget.categories.some((c) => c.current === null || Math.abs((c.current ?? 0) - c.suggested) > c.suggested * 0.25)) steps.push('Apply the suggested budgets so everyday spending fits what is left after bills and savings.');

  const order = { high: 0, medium: 1, info: 2 } as const;
  alerts.sort((a, b) => order[a.level] - order[b.level]);
  return { balance, safe, forecast: fc, upcoming, spending, budget, goals, alerts, steps, ready: input.commitments.some((c) => c.kind === 'income') && input.commitments.some((c) => c.kind !== 'income') };
}

// ------------------------------------------------------------------ for the assistant

/** The plan as plain numbers for the finance assistant to explain (it must not invent figures of its own). */
export function planContext(plan: MoneyPlan): Record<string, unknown> {
  const r = Math.round;
  return {
    balance: r(plan.balance),
    safeToSpendUntilPayday: r(plan.safe.amount), safePerDay: r(plan.safe.perDay), daysToPayday: plan.safe.daysToPayday, nextPayday: isoDay(plan.safe.nextPayday),
    upcomingBills: plan.upcoming.filter((e) => e.amount < 0).slice(0, 8).map((e) => ({ name: e.name, amount: r(-e.amount), on: isoDay(e.date) })),
    lowestBalanceNext60Days: { amount: r(plan.forecast.lowest.balance), on: isoDay(plan.forecast.lowest.date) },
    monthlyIncome: r(plan.budget.income), needs: r(plan.budget.needs), fixedWants: r(plan.budget.wantsFixed), savingsTarget: r(plan.budget.savings),
    everydaySpendPerDay: r(plan.spending.perDay), spendingConfidence: plan.spending.confidence,
    suggestedBudgets: plan.budget.categories.map((c) => ({ category: c.category, suggested: c.suggested, usualPerMonth: r(c.avg) })),
    goals: plan.goals.lines.map((l) => ({ name: l.goal.name, remaining: r(l.remaining), neededPerMonth: l.required, allocatedThisMonth: r(l.allocated), onTrack: l.onTrack })),
    emergencyFundCoverageMonths: Number(plan.goals.emergencyCoverageMonths.toFixed(1)),
    alerts: plan.alerts.map((a) => a.text),
  };
}
