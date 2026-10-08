import { tasksStore, eventsStore, transactionsStore, budgetsStore, goalsStore, profileStore, periodStore } from './stores';
import { googleEventsStore } from '../services/googleCalendar';
import { dayOf } from '../data/tasks';
import { todayISO } from '../data/events';

/** A compact snapshot of the user's own data, sent with chat/voice requests so answers are grounded in it. */
export function buildUserContext(): string {
  const today = todayISO();
  const week = new Date(); week.setDate(week.getDate() + 7);
  const weekEnd = week.toISOString().slice(0, 10);
  const now = new Date();
  const monthTx = transactionsStore.get().filter((t) => { const d = new Date(t.ts); return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth(); });
  return JSON.stringify({
    today,
    openTasks: tasksStore.get().filter((t) => !t.done).slice(0, 15).map((t) => ({ title: t.title, due: t.date, when: dayOf(t.date), start: t.start, priority: t.priority })),
    eventsNext7Days: [...eventsStore.get(), ...googleEventsStore.get()].filter((e) => e.date >= today && e.date <= weekEnd).slice(0, 20).map((e) => ({ title: e.title, date: e.date, start: e.start, end: e.end })),
    thisMonth: {
      income: monthTx.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0),
      expenses: monthTx.filter((t) => t.amount < 0).reduce((s, t) => s - t.amount, 0),
      budgets: budgetsStore.get().map((b) => ({ category: b.category, limit: b.limit })),
    },
    goals: goalsStore.get().map((g) => ({ name: g.name, saved: g.saved, target: g.target })),
    profile: profileStore.get()[0] ? { goals: profileStore.get()[0].goals, routine: profileStore.get()[0].routine, preferences: profileStore.get()[0].preferences } : undefined,
    ...(profileStore.get()[0]?.preferences?.Gender === 'Female' ? { periodLog: periodStore.get().slice(-6).map((p) => ({ start: p.start, end: p.end, flow: p.flow })) } : {}),
    currency: 'INR',
  });
}
