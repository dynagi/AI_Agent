import type { PeriodEntry } from './wellness';

/** Cycle estimates. They come only from what the user logged and are not medical advice or contraception. */
export type Phase = 'Menstrual' | 'Follicular' | 'Ovulation' | 'Luteal';

export const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const dayDiff = (a: string, b: string) => Math.round((new Date(`${b}T00:00:00`).getTime() - new Date(`${a}T00:00:00`).getTime()) / 86_400_000);
export const addDays = (isoDate: string, n: number) => { const d = new Date(`${isoDate}T00:00:00`); d.setDate(d.getDate() + n); return iso(d); };
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export interface CycleStats {
  sorted: PeriodEntry[]; cycleLen: number; periodLen: number; last?: PeriodEntry; next?: string;
  ongoing?: PeriodEntry; cycleDay?: number; learned: boolean; samples: number;
}

export function cycleStats(entries: PeriodEntry[], today: string): CycleStats {
  const sorted = [...entries].sort((a, b) => a.start.localeCompare(b.start));
  const cycles = sorted.slice(1).map((e, i) => dayDiff(sorted[i].start, e.start)).filter((n) => n >= 15 && n <= 60);
  const lengths = sorted.filter((e) => e.end).map((e) => dayDiff(e.start, e.end as string) + 1).filter((n) => n >= 1 && n <= 14);
  const cycleLen = cycles.length ? Math.round(mean(cycles)) : 28;
  const periodLen = lengths.length ? Math.round(mean(lengths)) : 5;
  const last = sorted[sorted.length - 1];
  // If the last logged start is far in the past, roll forward to the next expected start that is still ahead.
  let next = last ? addDays(last.start, cycleLen) : undefined;
  while (next && dayDiff(today, next) < -periodLen) next = addDays(next, cycleLen);
  const ongoing = last && !last.end && dayDiff(last.start, today) <= 14 ? last : undefined;
  const cycleDay = last ? dayDiff(last.start, today) + 1 : undefined;
  return { sorted, cycleLen, periodLen, last, next, ongoing, cycleDay, learned: cycles.length >= 2, samples: cycles.length };
}

export interface ForecastPeriod { start: string; end: string; ovulation: string }

/** Predicted periods from the next expected start, out to `months` months ahead. */
export function forecast(c: CycleStats, months: number, today: string): ForecastPeriod[] {
  if (!c.next) return [];
  const horizon = addDays(today, Math.round(months * 30.4));
  const out: ForecastPeriod[] = [];
  for (let start = c.next; start <= horizon && out.length < 30; start = addDays(start, c.cycleLen)) {
    out.push({ start, end: addDays(start, c.periodLen - 1), ovulation: addDays(start, -14) });
  }
  return out;
}

/** Phase for a cycle day (1-based), using a 14-day luteal phase to estimate ovulation. */
export function phaseOf(cycleDay: number, periodLen: number, cycleLen: number): Phase {
  const ov = Math.max(periodLen + 2, cycleLen - 14);
  if (cycleDay <= periodLen) return 'Menstrual';
  if (cycleDay >= ov - 1 && cycleDay <= ov + 1) return 'Ovulation';
  return cycleDay < ov - 1 ? 'Follicular' : 'Luteal';
}

export const phaseInfo: Record<Phase, { blurb: string; color: string; tips: string[] }> = {
  Menstrual: {
    blurb: 'Your period. Energy is often lower, so go easy on yourself.', color: '#FF4FD8',
    tips: ['Rest when you can and keep a heat pack handy', 'Iron-rich foods help: lentils, spinach, dates, jaggery', 'Drink plenty of water and warm fluids', 'Gentle movement such as walking or stretching can ease cramps'],
  },
  Follicular: {
    blurb: 'Energy tends to rise after your period ends.', color: '#00AFFF',
    tips: ['A good time for harder workouts and new projects', 'Eat protein and fresh vegetables to rebuild energy', 'Plan social and demanding tasks for these days'],
  },
  Ovulation: {
    blurb: 'Estimated mid-cycle window. Many people feel most energetic.', color: '#00E5A8',
    tips: ['Stay hydrated, especially if you exercise', 'Good days for presentations and social plans', 'This is only an estimate; it is not a way to avoid or achieve pregnancy'],
  },
  Luteal: {
    blurb: 'The days before your next period. Mood and cravings can shift.', color: '#8B5CFF',
    tips: ['Magnesium-rich snacks may help: nuts, seeds, dark chocolate', 'Keep caffeine and very salty food moderate', 'Protect your sleep and plan lighter days', 'Stock up on supplies for the coming period'],
  },
};
