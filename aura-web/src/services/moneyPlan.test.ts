import { describe, expect, it } from 'vitest';
import type { Transaction, TxCategory } from '../data/transactions';
import type { Commitment } from '../data/commitments';
import type { Goal } from '../data/goals';
import {
  budgetPlan, buildPlan, canAfford, currentBalance, forecast, goalPlan, matchesCommitment, monthlyEquivalent, occurrences, planContext,
  safeToSpend, typicalSpending, upcomingEvents, isoDay, type PlanInput,
} from './moneyPlan';
import { amountIn, moneyByVoice } from './moneyVoice';

// "Today" is Saturday 10 Oct 2026, noon.
const NOW = new Date(2026, 9, 10, 12);
let n = 0;
const tx = (y: number, m: number, d: number, merchant: string, amount: number, category: TxCategory = 'Food & Dining'): Transaction =>
  ({ id: `t${n++}`, merchant, logo: merchant, ts: new Date(y, m - 1, d, 10).toISOString(), category, amount });
const com = (p: Partial<Commitment> & Pick<Commitment, 'name' | 'kind' | 'amount'>): Commitment =>
  ({ id: p.name, frequency: 'monthly', day: 1, essential: p.kind !== 'subscription' && p.kind !== 'investment', ...p });

const SALARY = com({ name: 'Salary', kind: 'income', amount: 60000, day: 1 });
const RENT = com({ name: 'Rent', kind: 'rent', amount: 18000, day: 5 });
const ELEC = com({ name: 'Electricity', kind: 'bill', amount: 1500, day: 12 });
const NETFLIX = com({ name: 'Netflix', kind: 'subscription', amount: 649, day: 20 });
const SIP = com({ name: 'Mutual fund SIP', kind: 'investment', amount: 5000, day: 7 });

/** 30 days of ₹400 food orders (10 Sep - 9 Oct), one ₹50,000 laptop, and this month's rent and SIP. */
function history(): Transaction[] {
  const out: Transaction[] = [];
  for (let i = 0; i < 30; i++) { const d = new Date(2026, 8, 10 + i); out.push(tx(d.getFullYear(), d.getMonth() + 1, d.getDate(), 'Swiggy', -400)); }
  out.push(tx(2026, 9, 25, 'Croma', -50000, 'Shopping'));
  out.push(tx(2026, 10, 1, 'Salary', 60000, 'Income'));
  out.push(tx(2026, 10, 5, 'Rent', -18000, 'Bills & Utilities'));
  out.push(tx(2026, 10, 7, 'Mutual fund SIP', -5000, 'Others'));
  return out;
}

const base = (over: Partial<PlanInput> = {}): PlanInput => ({
  now: NOW, transactions: history(), commitments: [SALARY, RENT, ELEC, NETFLIX, SIP], goals: [], budgets: [],
  prefs: { anchor: { amount: 80000, at: new Date(2026, 9, 2).toISOString() } }, ...over,
});

describe('scheduling', () => {
  it('puts a monthly commitment on its day, and a 31st on the last day of a short month', () => {
    const c = com({ name: 'X', kind: 'bill', amount: 1, day: 31 });
    expect(occurrences(c, new Date(2027, 1, 1), new Date(2027, 1, 28)).map(isoDay)).toEqual(['2027-02-28']);
    expect(occurrences(c, new Date(2026, 9, 1), new Date(2026, 10, 30)).map(isoDay)).toEqual(['2026-10-31', '2026-11-30']);
  });

  it('handles weekly, quarterly and yearly', () => {
    const weekly = com({ name: 'W', kind: 'other', amount: 1, frequency: 'weekly', day: 0 });
    expect(occurrences(weekly, new Date(2026, 9, 1), new Date(2026, 9, 31)).map(isoDay)).toEqual(['2026-10-04', '2026-10-11', '2026-10-18', '2026-10-25']);
    const quarterly = com({ name: 'Q', kind: 'insurance', amount: 1, frequency: 'quarterly', day: 15, month: 2 });
    expect(occurrences(quarterly, new Date(2026, 9, 1), new Date(2027, 0, 31)).map(isoDay)).toEqual(['2026-12-15']);
    const yearly = com({ name: 'Y', kind: 'insurance', amount: 1, frequency: 'yearly', day: 3, month: 10 });
    expect(occurrences(yearly, new Date(2026, 9, 1), new Date(2027, 11, 31)).map(isoDay)).toEqual(['2026-11-03', '2027-11-03']);
  });

  it('stops an EMI on its end date and waits for a start date', () => {
    const emi = com({ name: 'EMI', kind: 'emi', amount: 1, day: 5, endsOn: '2026-11-30' });
    expect(occurrences(emi, new Date(2026, 9, 1), new Date(2027, 0, 31)).map(isoDay)).toEqual(['2026-10-05', '2026-11-05']);
    const lease = com({ name: 'Lease', kind: 'rent', amount: 1, day: 1, startsOn: '2026-12-01' });
    expect(occurrences(lease, new Date(2026, 9, 1), new Date(2027, 0, 31)).map(isoDay)).toEqual(['2026-12-01', '2027-01-01']);
  });

  it('converts to a monthly equivalent', () => {
    expect(monthlyEquivalent(com({ name: 'a', kind: 'bill', amount: 1200, frequency: 'yearly' }))).toBe(100);
    expect(monthlyEquivalent(com({ name: 'a', kind: 'bill', amount: 300, frequency: 'quarterly' }))).toBe(100);
    expect(monthlyEquivalent(com({ name: 'a', kind: 'bill', amount: 100, frequency: 'weekly' }))).toBeCloseTo(433.33, 1);
  });
});

describe('matching what was paid to what is scheduled', () => {
  it('matches by name, or by amount in a bills category, and never across income / expense', () => {
    expect(matchesCommitment(tx(2026, 10, 5, 'Rent - October', -18000, 'Bills & Utilities'), RENT)).toBe(true);
    expect(matchesCommitment(tx(2026, 10, 5, 'Landlord Sharma', -18200, 'Bills & Utilities'), RENT)).toBe(true);
    expect(matchesCommitment(tx(2026, 10, 5, 'Swiggy', -18000, 'Food & Dining'), RENT)).toBe(false);
    expect(matchesCommitment(tx(2026, 10, 5, 'Rent', 18000, 'Income'), RENT)).toBe(false);
    expect(matchesCommitment(tx(2026, 10, 1, 'Acme Corp', 60500, 'Income'), SALARY)).toBe(true);
  });
});

describe('balance and everyday spending', () => {
  it('starts from the balance the user stated and adds what happened after', () => {
    // 80,000 on 2 Oct, then rent, SIP and eight 400 food orders (2 - 9 Oct)
    expect(currentBalance(base())).toBe(80000 - 18000 - 5000 - 8 * 400);
    expect(currentBalance(base({ prefs: {} }))).toBe(history().reduce((a, t) => a + t.amount, 0));
  });

  it('ignores scheduled payments and caps one-off big purchases', () => {
    const s = typicalSpending(base());
    // 30 food orders + the laptop capped at the usual size = 31 x 400 over 31 days
    expect(s.perDay).toBeCloseTo(400, 5);
    expect(s.confidence).toBe('ok');
    expect(s.perMonthByCategory.get('Bills & Utilities')).toBeUndefined();
  });

  it('says so when there is little history', () => {
    const s = typicalSpending(base({ transactions: [tx(2026, 10, 9, 'Chai', -50)] }));
    expect(s.confidence).toBe('low');
  });
});

describe('upcoming money, and safe to spend', () => {
  it('lists what is still to come and skips what is already paid', () => {
    const ev = upcomingEvents(base(), 30).map((e) => `${isoDay(e.date)} ${e.name}`);
    expect(ev).toEqual(['2026-10-12 Electricity', '2026-10-20 Netflix', '2026-11-01 Salary', '2026-11-05 Rent', '2026-11-07 Mutual fund SIP']);
  });

  it('treats a bill paid a couple of days early as paid', () => {
    const early = [...history(), tx(2026, 10, 9, 'Electricity board', -1500, 'Bills & Utilities')];
    expect(upcomingEvents(base({ transactions: early }), 5).map((e) => e.name)).not.toContain('Electricity');
  });

  it('works out what is free until payday after bills and the buffer', () => {
    const s = safeToSpend(base());
    expect(isoDay(s.nextPayday)).toBe('2026-11-01');
    expect(s.daysToPayday).toBe(22);
    expect(s.dueBefore.map((e) => e.name)).toEqual(['Electricity', 'Netflix']);
    expect(s.buffer).toBe(6000);                              // about 10% of 60,000
    expect(s.amount).toBe(53800 - 1500 - 649 - 6000);
    expect(s.perDay).toBeCloseTo(s.amount / 22, 5);
  });

  it('falls back to month end when no salary is scheduled', () => {
    const s = safeToSpend(base({ commitments: [RENT] }));
    expect(s.paydayKnown).toBe(false);
    expect(isoDay(s.nextPayday)).toBe('2026-11-01');
  });
});

describe('the forecast', () => {
  it('adds scheduled money and the usual spending day by day', () => {
    const f = forecast(base(), 60);
    expect(f.start).toBe(53800);
    expect(f.end).toBeCloseTo(53800 + 120000 - 50298 - 60 * 400, 5);
    expect(f.lowest.balance).toBe(Math.min(...f.days.map((d) => d.balance)));
    expect(f.shortfall).toBeNull();
  });

  it('finds the first day the balance drops under the buffer and what causes it', () => {
    const f = forecast(base({ prefs: { anchor: { amount: 22000, at: new Date(2026, 9, 2).toISOString() } } }), 30);
    expect(f.shortfall).not.toBeNull();
    expect(f.shortfall!.balance).toBeLessThan(6000);
  });
});

describe('can I afford it?', () => {
  it('says yes when the balance stays above the buffer', () => {
    const a = canAfford(base(), 10000);
    expect(a.ok).toBe(true);
    expect(a.okFrom).toBeNull();
  });

  it('says no, and when it would fit', () => {
    const a = canAfford(base(), 60000);
    expect(a.ok).toBe(false);
    expect(a.okFrom && isoDay(a.okFrom)).toBe('2026-11-01');   // payday
    expect(a.reason).toContain('fits from');
  });
});

describe('budgets and goals', () => {
  it('fits everyday spending into what is left after bills and savings', () => {
    const b = budgetPlan(base());
    expect(b.income).toBe(60000);
    expect(b.needs).toBe(19500);
    expect(b.wantsFixed).toBe(649);
    expect(b.savings).toBe(12000);                           // 20% target beats the 5,000 SIP
    expect(b.pool).toBe(60000 - 19500 - 649 - 12000);
    expect(b.status).toBe('surplus');
    const sum = b.categories.reduce((a, c) => a + c.suggested, 0);
    expect(Math.abs(sum - b.pool)).toBeLessThanOrEqual(400);
    expect(b.categories.find((c) => c.category === 'Food & Dining')!.suggested).toBeGreaterThan(b.categories.find((c) => c.category === 'Travel')!.suggested);
  });

  it('flags a deficit when commitments and savings exceed income', () => {
    const b = budgetPlan(base({ commitments: [SALARY, com({ name: 'Rent', kind: 'rent', amount: 50000, day: 5 })] }));
    expect(b.status).toBe('deficit');
  });

  it('puts the emergency fund first, then the nearest deadline', () => {
    const goals: Goal[] = [
      { id: 'house', name: 'House', icon: 'home', tone: 'blue', saved: 0, target: 1_200_000, by: '2027-04-10' },
      { id: 'goa', name: 'Goa trip', icon: 'plane', tone: 'teal', saved: 6000, target: 30000, by: '2027-01-10' },
    ];
    const g = goalPlan(base({ goals }));
    expect(g.lines.map((l) => l.goal.name)).toEqual(['Emergency fund', 'Goa trip', 'House']);
    expect(g.lines[0].virtual).toBe(true);
    const [emergency, goa, house] = g.lines;
    expect(goa.required).toBe(6000);                          // 24,000 over 4 months
    expect(goa.onTrack).toBe(true);
    expect(house.onTrack).toBe(false);
    expect(emergency.allocated + goa.allocated + house.allocated).toBeCloseTo(g.surplus, 0);
    expect(g.emergencyTarget).toBeGreaterThan(150000);
  });

  it('uses the user’s own emergency fund instead of inventing one', () => {
    const goals: Goal[] = [{ id: 'e', name: 'Emergency fund', icon: 'target', tone: 'teal', saved: 90000, target: 180000 }];
    const g = goalPlan(base({ goals }));
    expect(g.lines.some((l) => l.virtual)).toBe(false);
    expect(g.emergencyCoverageMonths).toBeCloseTo(90000 / g.essentialsPerMonth, 5);
  });
});

describe('the whole plan', () => {
  it('warns about rent that is too large a share of income', () => {
    const p = buildPlan(base({ commitments: [SALARY, com({ name: 'Rent', kind: 'rent', amount: 30000, day: 5 })] }));
    expect(p.alerts.some((a) => a.id === 'rent-ratio')).toBe(true);
  });

  it('warns when the balance is heading under the buffer, most urgent first', () => {
    const p = buildPlan(base({ prefs: { anchor: { amount: 22000, at: new Date(2026, 9, 2).toISOString() } } }));
    expect(p.alerts[0].level).toBe('high');
    expect(p.alerts.some((a) => a.id === 'shortfall')).toBe(true);
  });

  it('warns when a category is running ahead of its budget', () => {
    const p = buildPlan(base({ budgets: [{ id: 'b', category: 'Food & Dining', limit: 5000 }] }));
    expect(p.alerts.some((a) => a.id === 'pace-Food & Dining')).toBe(true);
  });

  it('is only "ready" once income and an outgoing commitment exist', () => {
    expect(buildPlan(base()).ready).toBe(true);
    expect(buildPlan(base({ commitments: [] })).ready).toBe(false);
  });

  it('gives the assistant plain numbers', () => {
    const c = planContext(buildPlan(base()));
    expect(c.safeToSpendUntilPayday).toBe(45651);
    expect(c.nextPayday).toBe('2026-11-01');
    expect(JSON.stringify(c)).not.toContain('NaN');
  });

  it('copes with nothing set up at all', () => {
    const p = buildPlan({ now: NOW, transactions: [], commitments: [], goals: [], budgets: [] });
    expect(p.ready).toBe(false);
    expect(Number.isFinite(p.safe.amount)).toBe(true);
    expect(JSON.stringify(planContext(p))).not.toContain('NaN');
  });
});


describe('money by voice', () => {
  it('reads amounts the way people say them', () => {
    expect(amountIn('can i afford 5000')).toBe(5000);
    expect(amountIn('can i afford 5,000 rupees')).toBe(5000);
    expect(amountIn('can i afford 15k')).toBe(15000);
    expect(amountIn('can i afford ₹2 lakh')).toBe(200000);
    expect(amountIn('can i afford 1.5 thousand')).toBe(1500);
    expect(amountIn('can i afford a phone')).toBeUndefined();
  });

  it('leaves everything else to the other handlers', () => {
    for (const s of ['order milk', 'how much did i spend on food', 'i drank two glasses of water', 'what is the weather', 'when is my doctor appointment'])
      expect(moneyByVoice(s, base())).toBeNull();
  });

  it('says what is safe to spend', () => {
    const say = moneyByVoice('how much can i spend today', base())!;
    expect(say).toContain('2,075 rupees a day');          // 45,651 / 22 days
    expect(say).toContain('1 November');
  });

  it('answers can-I-afford with the reason and the date it fits', () => {
    expect(moneyByVoice('can i afford 10000', base())).toMatch(/^Yes\./);
    const no = moneyByVoice('can i afford 60k', base())!;
    expect(no).toMatch(/^Not right now\./);
    expect(no).toContain('from 1 November');
    expect(moneyByVoice('can i afford it', base())).toContain('How much is it');
  });

  it('says when a payment is due', () => {
    expect(moneyByVoice('when is my rent due', base())).toBe('Rent, 18,000 rupees, is due on 5 November, in 26 days.');
    expect(moneyByVoice('when is my electricity bill due', base())).toContain('Electricity, 1,500 rupees, is due on 12 October, in 2 days');
    expect(moneyByVoice('when is payday', base())).toContain('Salary, 60,000 rupees, arrives on 1 November');
  });

  it('asks for set-up when there is nothing to plan with', () => {
    expect(moneyByVoice('how much can i spend', base({ commitments: [] }))).toContain('Your Money Plan');
  });
});
