import { addDays, buildPlan, canAfford, startOfDay, upcomingEvents, type PlanInput } from './moneyPlan';

/**
 * Money questions answered out loud from the money plan, with no model call: "how much can I spend today", "can I
 * afford 15000", "when is rent due", "how am I doing with money". Everything comes from services/moneyPlan.ts.
 */

const rupees = (n: number) => `${Math.round(Math.abs(n)).toLocaleString('en-IN')} rupees`;
const spokenDate = (d: Date) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long' });

/** "5000", "5,000", "5k", "2 lakh", "1.5 thousand": the amount in rupees, or undefined. */
export function amountIn(t: string): number | undefined {
  const m = t.replace(/₹|\brs\.?|\brupees?\b/g, ' ').match(/(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|lakhs?|lacs?|crores?|cr)?\b/);
  if (!m) return undefined;
  const n = Number(m[1].replace(/,/g, ''));
  const unit = m[2] ?? '';
  const x = /^(k|thousand)$/.test(unit) ? 1e3 : /^(lakhs?|lacs?)$/.test(unit) ? 1e5 : /^(crores?|cr)$/.test(unit) ? 1e7 : 1;
  return n > 0 ? n * x : undefined;
}

const KIND_WORD: Record<string, string> = { emi: 'emi', sip: 'investment', salary: 'income', payday: 'income', rent: 'rent', insurance: 'insurance', subscription: 'subscription', bill: 'bill' };

/** The spoken answer to a money question, or null when the sentence isn't one (so other handlers get it). */
export function moneyByVoice(t: string, input: PlanInput): string | null {
  const asksSpend = (/\bhow much\b.*\b(spend|use|left|free)\b|\b(safe|free) to spend\b|\bwhat can i spend\b|\bspending money\b/.test(t)) && !/\b(spent|did i)\b/.test(t);
  const asksAfford = /\bcan i afford\b|\bdo i have (enough )?(money|budget) for\b|\bwill i be able to afford\b/.test(t);
  const asksDue = /\bwhen (is|are|do i pay|will i get|does)\b.*\b(rent|emi|bill|electricity|internet|insurance|sip|subscription|salary|payday)\b/.test(t);
  const asksPlan = /\b(money|finance|financial|budget) (plan|summary|status)\b|\bhow am i doing (financially|with (my )?money)\b|\bmy finances\b/.test(t);
  if (!asksSpend && !asksAfford && !asksDue && !asksPlan) return null;

  const plan = buildPlan(input);
  if (!plan.ready) return 'I need your salary and your regular payments, like rent, to plan your money. Add them in Finance, under Your Money Plan, and ask me again.';

  if (asksAfford) {
    const amt = amountIn(t);
    if (!amt) return 'How much is it? Say something like, can I afford fifteen thousand.';
    const a = canAfford(input, amt);
    if (a.ok) return `Yes. Your balance would stay above ${rupees(a.buffer)} for the next 45 days; the lowest it gets is ${rupees(a.lowestBalance)} on ${spokenDate(a.lowestDate)}.`;
    return `Not right now. It would take your balance down to ${rupees(a.lowestBalance)} on ${spokenDate(a.lowestDate)}, below your ${rupees(a.buffer)} buffer. `
      + (a.okFrom ? `It would fit from ${spokenDate(a.okFrom)}.` : 'It doesn’t fit in the next 45 days.');
  }

  if (asksDue) {
    const word = t.match(/\b(rent|emi|bill|electricity|internet|insurance|sip|subscription|salary|payday)\b/)?.[1] ?? '';
    const ev = upcomingEvents(input, 62).find((e) => e.name.toLowerCase().includes(word) || e.kind === KIND_WORD[word]);
    if (!ev) return `I don't have ${word ? `a ${word}` : 'that'} scheduled in the next two months.`;
    const days = Math.round((startOfDay(ev.date).getTime() - startOfDay(input.now).getTime()) / 86_400_000);
    const when = days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `on ${spokenDate(ev.date)}, in ${days} days`;
    return `${ev.name}, ${rupees(ev.amount)}, ${ev.amount > 0 ? 'arrives' : 'is due'} ${when}.`;
  }

  if (asksPlan) return plan.steps.slice(0, 3).join(' ').replace(/₹([\d,]+)/g, '$1 rupees') || 'Everything looks on track.';

  const s = plan.safe;
  const until = s.paydayKnown ? 'payday' : 'the end of the month';
  if (s.amount < 0) return `Bills due before ${until} are ${rupees(s.amount)} more than your free cash. Hold off on extra spending.`;
  return `You can spend about ${rupees(s.perDay)} a day until ${until}, ${spokenDate(addDays(s.nextPayday, 0))}. That is ${rupees(s.amount)} in total after your bills.`;
}
